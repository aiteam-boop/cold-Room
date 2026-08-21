import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendEmail, appClientUrl, appBaseUrl, isEmailEnabled, approvalCcEmail, approvalEmailHtml } from '../services/email';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { signApiPath } from '../lib/signedUrl';
import {
  requireAuth, requireProjectMember,
  requirePage, requireEdit, requireAnyPage, requireAnyEdit, requireSection, requireFinancialView,
} from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';
import { upload, uploadPdf } from '../middleware/upload';
import { SIGNED_TYPE } from '../services/grnReminders';
import { audit } from '../lib/audit';
import { extractPiFields } from '../services/piExtract';
import { scheduleSheetSync } from '../services/sheetsSync';
import {
  COMPANY, nextDocNumber, computeTotals, paymentTotalPct,
  defaultPOSections, defaultWOSections,
  normalizeTermsSections, assertTermsMutationsAllowed,
  milestonePaidAmount, milestoneRemaining,
} from '../services/procurement';
import { renderProcurementPdf, renderGRNPdf, renderPackingListPdf } from '../services/procurementPdf';
import { notifyUser, notifyProjectRoles } from '../services/notify';
import { hasSection, shouldHideFinancials } from '../lib/permissions';
import { KYC_KINDS, VENDOR_TYPES, BOQ_CATEGORIES } from '../lib/enums';
import { kycScore, kycStatus, normalizeRateChart, rateFor } from '../services/vendorProfile';
import { extractKycFields } from '../services/kycExtract';
import { readFromDb } from '../lib/fileStore';
import { deliveryInfo } from '../services/delivery';
import { chainForAmount, validateChain, type MatrixDocType } from '../services/approvalMatrix';
import { resolveAutoChain } from '../services/fixedChain';
import { buildPaymentSteps, ensurePaymentSteps, notifyCurrentPaymentStep } from '../services/paymentChain';
import {
  buildChain, recordDecision, remindCurrent, finalizeApproval, markDocOnHold,
  getChainState, resolveActor, type DocType,
} from '../services/approvalChain';

const rs = (n: number) => 'Rs. ' + (n || 0).toLocaleString('en-IN');

const router = Router({ mergeParams: true });
router.use(requireAuth);

// Pages that share the procurement docs endpoints (Payment Pipeline / PO / WO).
const DOC_PAGES = ['pay', 'po', 'wo'] as const;

// ── Vendor list ─────────────────────────────────────────────────────────────
// The vendor database is company-wide: every project sees all vendors, so a
// vendor added in one project is immediately usable in all others.
//
// Deactivated vendors are hidden by default — this endpoint backs the PO/WO
// vendor picker (Sprint PRD §5.1.1). The Vendors page passes ?includeInactive=1.
router.get('/vendors', requireProjectMember, requirePage('vendors'), asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
  const vendors = await prisma.vendor.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { name: 'asc' },
    include: { kycDocs: { where: { type: 'KYC' }, select: { kycKind: true } } },
  });
  res.json({
    vendors: vendors.map(({ kycDocs, ...v }) => ({
      ...v,
      rateChart: normalizeRateChart(v.rateChart),
      kycStatus: kycStatus(kycDocs),
      kycDocCount: kycDocs.length,
      kyc: kycScore(v, kycDocs),
    })),
  });
}));

// GET .../vendors/:vendorId/rate — the rate this vendor charges for an item
// today, so the PO line-item form can auto-suggest a price (PRD §5.1.5).
// Amisha can always override; a vendor with no rate chart simply returns null.
router.get('/vendors/:vendorId/rate', requireProjectMember, requireAnyPage(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const item = z.object({ item: z.string().min(1) }).parse(req.query).item;
  const vendor = await prisma.vendor.findUnique({ where: { id: req.params.vendorId }, select: { rateChart: true } });
  if (!vendor) throw notFound('Vendor not found');
  const chart = normalizeRateChart(vendor.rateChart);
  res.json({ suggested: rateFor(chart, item), history: chart.filter((r) => r.itemDescription.toLowerCase().trim() === item.toLowerCase().trim()) });
}));

// Inline create vendor + map to this project (FR-MC-27). Full-profile edits go
// through the global /api/vendors routes; this is the quick "add while drafting
// a PO" path, so it stays a thin subset.
router.post('/vendors', requireProjectMember, requireEdit('vendors'), asyncHandler(async (req, res) => {
  const b = z.object({
    name: z.string().min(1), type: z.enum(['VENDOR', 'CONTRACTOR']).default('VENDOR'),
    vendorType: z.enum(VENDOR_TYPES).optional(), boqCategories: z.array(z.enum(BOQ_CATEGORIES)).optional(),
    contactPerson: z.string().optional(), phones: z.string().optional(), tel: z.string().optional(), fax: z.string().optional(),
    website: z.string().optional(), address: z.string().optional(), email: z.string().optional(),
    gstin: z.string().optional(), cin: z.string().optional(), pan: z.string().optional(),
    bankAccount: z.string().optional(), ifsc: z.string().optional(),
  }).parse(req.body);
  const vendor = await prisma.vendor.create({ data: { ...b, createdById: req.user!.sub, siteMappings: { create: { projectId: req.params.projectId } } } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'VENDOR_CREATE_INLINE', entity: 'Vendor', entityId: vendor.id });
  res.status(201).json({ vendor });
}));

// ── PO / WO documents ───────────────────────────────────────────────────────

const parseJson = (s: string | null | undefined, fallback: unknown) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

// ── Post-approval amendment trail ───────────────────────────────────────────
// An approved PO/WO/GRN is locked, but real documents get changed after signing.
// We allow it only with a reason, and record every such edit — who, their email,
// when, why — so anyone opening the document sees the full history.
export interface Amendment { at: string; byId: string; byName: string; byEmail: string; remark: string }

function appendAmendment(existingJson: string | null | undefined, actor: { id: string; name: string; email: string }, remark: string): string {
  const list = parseJson(existingJson, []) as Amendment[];
  list.push({ at: new Date().toISOString(), byId: actor.id, byName: actor.name, byEmail: actor.email, remark: remark.trim() });
  return JSON.stringify(list);
}

function serializeDoc(d: any) {
  return {
    ...d,
    // Always hand the client fully-formed clauses (isStruckOff / isLocked /
    // isCustom), even for documents saved before those flags existed.
    termsSections: normalizeTermsSections(parseJson(d.termsSections, [])),
    payTriggers: parseJson(d.payTriggers, {}),
    // User-added item columns + each line's values for them.
    customColumns: parseJson(d.customColumns, []),
    ...(Array.isArray(d.lineItems) ? { lineItems: d.lineItems.map((l: any) => ({ ...l, customValues: parseJson(l.customValues, {}) })) } : {}),
    overrides: parseJson(d.overrides, {}),
    amendments: parseJson(d.amendments, []),
    // The persisted "compare against" BOQ items on the Budget vs Actual panel (§5).
    budgetCompareItemIds: parseJson(d.budgetCompareItemIds, []),
    // Per-payment-term Proforma Invoices uploaded on the PO.
    termPis: parseJson(d.termPis, {}),
    paymentTotalPct: paymentTotalPct(d),
    // Derived, never stored (G7). Only when the caller loaded the GRNs.
    ...(Array.isArray(d.grns) ? { delivery: deliveryInfo(d, d.grns) } : {}),
  };
}

// GET .../docs?type=PO|WO
// `createdById` / `raisedById` are plain ids (no Prisma relation), so resolve the
// people behind them in one query and hand the lists a { name, email } to show.
async function creatorsById(ids: (string | null | undefined)[]): Promise<Map<string, { name: string; email: string }>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, email: true } });
  return new Map(users.map((u) => [u.id, { name: u.name, email: u.email }]));
}

router.get('/docs', requireProjectMember, requireAnyPage(...DOC_PAGES), asyncHandler(async (req, res) => {
  const type = req.query.type === 'WO' ? 'WO' : req.query.type === 'PO' ? 'PO' : undefined;
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, ...(type ? { type } : {}) },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { lineItems: true, grns: true, milestones: true } },
      grns: { select: { grnDate: true, status: true } },
    },
  });
  const creators = await creatorsById(docs.map((d) => d.createdById));
  // For docs still awaiting approval, who is it currently pending with?
  const pendingIds = docs.filter((d) => d.status === 'PENDING_APPROVAL').map((d) => d.id);
  const pendingSteps = pendingIds.length
    ? await prisma.approvalStep.findMany({ where: { docId: { in: pendingIds }, status: 'PENDING' }, select: { docId: true, approverName: true, approverRole: true } })
    : [];
  const pendingBy = new Map(pendingSteps.map((s) => [s.docId, s]));
  // Physical goods receipts (GRN-QAS) per PO/WO — for the "GRN pdf" action.
  const goodsReceipts = docs.length
    ? await prisma.goodsReceipt.findMany({ where: { docId: { in: docs.map((d) => d.id) } }, orderBy: { createdAt: 'desc' }, select: { id: true, grnNumber: true, status: true, docId: true } })
    : [];
  const grByDoc = new Map<string, { id: string; grnNumber: string; status: string }[]>();
  for (const g of goodsReceipts) { const a = grByDoc.get(g.docId!) ?? []; a.push({ id: g.id, grnNumber: g.grnNumber, status: g.status }); grByDoc.set(g.docId!, a); }
  res.json({
    docs: maskFinancials(
      docs.map((d) => ({
        id: d.id, type: d.type, docNumber: d.docNumber, status: d.status, vendorName: d.vendorName,
        docDate: d.docDate, basicAmount: d.basicAmount, finalAmount: d.finalAmount, esignApplied: d.esignApplied,
        counts: d._count,
        delivery: deliveryInfo(d, d.grns), // G7 — promised vs actual, derived
        createdBy: (d.createdById && creators.get(d.createdById)) || null,
        pendingWith: pendingBy.get(d.id)?.approverName ?? null,
        pendingWithRole: pendingBy.get(d.id)?.approverRole ?? null,
        // Proforma Invoices uploaded on this PO/WO (per term) — shown as a link.
        pis: Object.entries(parseJson(d.termPis, {}) as Record<string, any>).filter(([, v]) => v && v.piPdfUrl).map(([k, v]) => ({ term: k, piNumber: v.piNumber ?? null, piUrl: v.piPdfUrl as string })),
        goodsReceipts: grByDoc.get(d.id) ?? [],
      })),
      req.account,
    ),
  });
}));

// POST .../docs — create a PO or WO with company defaults.
router.post('/docs', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const b = z.object({ type: z.enum(['PO', 'WO']), vendorId: z.string().optional() }).parse(req.body);
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
  const docNumber = await nextDocNumber(b.type);
  let vendor = null as any;
  if (b.vendorId) vendor = await prisma.vendor.findUnique({ where: { id: b.vendorId } });

  const doc = await prisma.procurementDoc.create({
    data: {
      projectId: req.params.projectId, type: b.type, docNumber, status: 'DRAFT',
      vendorId: vendor?.id, vendorName: vendor?.name, vendorAddress: vendor?.address, vendorGstin: vendor?.gstin,
      vendorContact: vendor?.contactPerson, vendorPhone: vendor?.phones,
      invoiceTo: COMPANY.invoiceTo,
      shipTo: b.type === 'PO' ? (project?.siteLocation ?? '') : null,
      siteAddress: b.type === 'WO' ? (project?.siteLocation ?? '') : null,
      gstEnabled: b.type === 'PO',
      termsSections: JSON.stringify(b.type === 'PO' ? defaultPOSections() : defaultWOSections()),
      createdById: req.user!.sub,
      lineItems: { create: { srNo: 1, description: '', qty: 0, unitPrice: 0, totalPrice: 0, sortOrder: 0 } },
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_CREATE', entity: 'ProcurementDoc', entityId: doc.id, details: { type: b.type, docNumber } });
  res.status(201).json({ doc: serializeDoc(doc) });
}));

// ── BOQ Head Mapping (Procurement PRD §5 · D2/D3) ────────────────────────────
// Re-map already-issued PO/WO line items to their BOQ head. The head is INTERNAL
// only, so setting it never touches the vendor PDF and needs no re-approval —
// hence these light endpoints instead of the full document PATCH/amendment flow.
router.get('/head-mapping', requireProjectMember, requireAnyPage(...DOC_PAGES), asyncHandler(async (req, res) => {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, docNumber: true, type: true, status: true, vendorName: true, createdAt: true,
      lineItems: {
        where: { isLeadTime: false },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, description: true, boqHead: true, boqItem: { select: { category: true } } },
      },
    },
  });
  res.json({
    docs: docs.map((d) => ({
      id: d.id, docNumber: d.docNumber, type: d.type, status: d.status, vendorName: d.vendorName, createdAt: d.createdAt,
      lineItems: d.lineItems.map((l) => ({ id: l.id, description: l.description, boqHead: l.boqHead, suggestedHead: l.boqItem?.category ?? null })),
    })),
  });
}));

// PATCH .../line-items/heads — bulk-set the internal BOQ head on issued lines (D3).
router.patch('/line-items/heads', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const body = z.object({ items: z.array(z.object({ id: z.string(), boqHead: z.string().trim().max(120).nullable() })).max(1000) }).parse(req.body);
  // Only touch line items that belong to THIS project's documents.
  const owned = await prisma.procurementLineItem.findMany({ where: { id: { in: body.items.map((i) => i.id) }, doc: { projectId: req.params.projectId } }, select: { id: true } });
  const ownedSet = new Set(owned.map((o) => o.id));
  let updated = 0;
  for (const it of body.items) {
    if (!ownedSet.has(it.id)) continue;
    await prisma.procurementLineItem.update({ where: { id: it.id }, data: { boqHead: it.boqHead || null } });
    updated++;
  }
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_HEAD_REMAP', entity: 'ProcurementLineItem', entityId: req.params.projectId, details: { updated } });
  res.json({ ok: true, updated });
}));

// GET .../docs/:docId — full document. Line items carry their linked BOQ row so
// the builder can show "Sr. 12 · Copper piping" instead of a bare id.
router.get('/docs/:docId', requireProjectMember, requireAnyPage(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({
    where: { id: req.params.docId, projectId: req.params.projectId },
    include: {
      lineItems: { orderBy: { sortOrder: 'asc' }, include: { boqItem: { select: { id: true, srNo: true, description: true, unit: true, makeModel: true } } } },
      milestones: { orderBy: { sortOrder: 'asc' } },
      grns: { select: { id: true, grnNumber: true, status: true, invoiceValue: true, grnDate: true, invoiceNumber: true, invoicePdfUrl: true } },
    },
  });
  if (!doc) throw notFound('Document not found');
  const approval = await getChainState(doc.type as DocType, doc.id);
  res.json({ doc: maskFinancials(serializeDoc(doc), req.account), approval });
}));

// GET .../docs/:docId/pipeline — the phase timeline (Approval → Payment → Goods
// Receipt) for one PO/WO. Read-only aggregation of existing data; used by the
// Approvals "Approved" tab and the project dashboard. Financials masked like
// every other money endpoint; the client also renders amounts via money().
router.get('/docs/:docId/pipeline', requireProjectMember, requireAnyPage(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({
    where: { id: req.params.docId, projectId: req.params.projectId },
    include: {
      lineItems: { select: { qty: true } },
      milestones: { orderBy: { sortOrder: 'asc' }, include: { installments: { orderBy: { createdAt: 'asc' } } } },
      project: { select: { name: true } },
    },
  });
  if (!doc) throw notFound('Document not found');

  // ── Approval phase — who signs, in order ──
  const chain = await getChainState(doc.type as DocType, doc.id);
  const steps = chain.steps.map((s) => ({ order: s.order, name: s.approverName, role: s.approverRole, status: s.status, actedAt: s.actedAt, remarks: s.remarks }));

  // ── Payment phase — terms with paid/remaining + UTRs (partial flagged red) ──
  // Payment records (PAY-QAS-###) raised against each term, so a triggered term
  // shows its payment number, trigger date, and management release decision.
  const payGrns = await prisma.gRN.findMany({
    where: { docId: doc.id, milestoneId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { grnNumber: true, milestoneId: true, paymentStatus: true, releaseStatus: true, releaseAt: true, utrNumber: true, paidAt: true },
  });
  const payByTerm = new Map<string, typeof payGrns>();
  for (const g of payGrns) { if (!g.milestoneId) continue; const arr = payByTerm.get(g.milestoneId) ?? []; arr.push(g); payByTerm.set(g.milestoneId, arr); }
  const terms = doc.milestones.map((m) => ({
    name: m.name, percentage: m.percentage, inrAmount: m.inrAmount,
    amountPaid: milestonePaidAmount(m), remaining: milestoneRemaining(m),
    status: m.status, utrNumber: m.utrNumber, triggeredAt: m.actualTriggerDate,
    installments: m.installments.map((i) => ({ amount: i.amount, utrNumber: i.utrNumber, paymentDate: i.paymentDate })),
    payments: (payByTerm.get(m.id) ?? []).map((g) => ({ grnNumber: g.grnNumber, paymentStatus: g.paymentStatus, releaseStatus: g.releaseStatus, releaseAt: g.releaseAt, utrNumber: g.utrNumber, paidAt: g.paidAt })),
  }));
  const paidAmount = Math.round(terms.reduce((s, t) => s + t.amountPaid, 0) * 100) / 100;
  const pendingAmount = Math.round(terms.reduce((s, t) => s + t.remaining, 0) * 100) / 100;

  // ── Goods Receipt phase — physical receipts against this PO + received vs PO qty ──
  const grs = await prisma.goodsReceipt.findMany({
    where: { docId: doc.id },
    orderBy: { createdAt: 'desc' },
    include: { lineItems: { select: { acceptedQty: true } } },
  });
  const totalPoQty = Math.round(doc.lineItems.reduce((s, l) => s + (l.qty || 0), 0) * 100) / 100;
  const receipts = grs.map((g) => ({
    grnNumber: g.grnNumber, status: g.status, receivedDate: g.receivedDate,
    receivedQty: Math.round(g.lineItems.reduce((s, l) => s + (l.acceptedQty || 0), 0) * 100) / 100,
  }));
  const totalReceivedQty = Math.round(receipts.reduce((s, r) => s + r.receivedQty, 0) * 100) / 100;

  const payload = {
    doc: { docNumber: doc.docNumber, type: doc.type, vendorName: doc.vendorName, finalAmount: doc.finalAmount, status: doc.status, projectName: doc.project?.name ?? null },
    approval: { approved: chain.approved, total: chain.total, steps },
    payment: { paidAmount, pendingAmount, termsTotal: terms.length, terms },
    goodsReceipt: { count: grs.length, totalPoQty, totalReceivedQty, remainingQty: Math.round(Math.max(totalPoQty - totalReceivedQty, 0) * 100) / 100, receipts },
  };
  res.json({ pipeline: maskFinancials(payload, req.account) });
}));

const lineSchema = z.object({
  id: z.string().optional(), srNo: z.coerce.number().optional(), description: z.string().default(''),
  uom: z.string().optional().nullable(), qty: z.coerce.number().catch(0).default(0),
  unitPrice: z.coerce.number().catch(0).default(0), totalPrice: z.coerce.number().optional(),
  isLeadTime: z.boolean().optional(), leadTimeText: z.string().optional().nullable(),
  gstExempt: z.boolean().optional(), // this line bears no GST (e.g. refundable deposit)
  gstExemptRemark: z.string().nullable().optional(), // why it is GST-exempt
  gstPct: z.coerce.number().nullable().optional(), // per-line GST rate; null = doc default
  customValues: z.any().optional(), // { [colKey]: value } for user-added columns
  // Links this PO line back to the BOQ item it fulfils — the join that powers
  // the BOQ Cost view (Sprint PRD §6.3). Optional but strongly recommended.
  boqItemId: z.string().nullable().optional(),
  // BOQ head (heading/category) this line rolls up under — internal only (D2).
  boqHead: z.string().trim().max(120).nullable().optional(),
});
// Accept null on optional string fields — the client sends null for the
// address field that doesn't apply (siteAddress on a PO, shipTo on a WO).
const nstr = z.string().nullable().optional();
// Coerce numeric fields so values typed as strings ("25") validate cleanly.
const num = z.coerce.number().optional();
const updateSchema = z.object({
  docNumber: z.string().trim().min(1).max(60).optional(),
  vendorId: z.string().nullable().optional(),
  vendorName: nstr, vendorAddress: nstr, vendorGstin: nstr, vendorContact: nstr, vendorPhone: nstr,
  againstQuotation: nstr, invoiceTo: nstr, shipTo: nstr, siteAddress: nstr,
  // Delivery commitment (G7). ISO date string, or null to clear.
  promisedDeliveryDate: z.string().min(1).nullable().optional(),
  requiredByDate: z.string().min(1).nullable().optional(),
  gstEnabled: z.boolean().optional(), gstPct: num,
  basicAmount: num, gstAmount: num, finalAmount: num,
  payAdvancePct: num, payBeforeDeliveryPct: num, payRunningPct: num,
  payPostDeliveryPct: num, payPostCompletionPct: num, payRetentionPct: num,
  payGstInclusive: z.boolean().optional(),
  customColumns: z.any().optional(),
  termPis: z.any().optional(),
  payTriggers: z.any().optional(),
  termsSections: z.array(z.object({
    title: z.string(), text: z.string().default(''),
    isStruckOff: z.boolean().optional(), struckOffAt: z.string().nullable().optional(),
    isLocked: z.boolean().optional(), isCustom: z.boolean().optional(),
  })).optional(),
  overrides: z.any().optional(),
  lineItems: z.array(lineSchema).optional(),
  // Required to edit an APPROVED document — the reason for the post-approval
  // change. Ignored on a draft.
  amendmentRemark: z.string().trim().max(2000).optional(),
});

// PATCH .../docs/:docId — edit any field (manual override everywhere).
// An APPROVED document is normally locked, but may be amended WITH A REASON: the
// edit then goes through and is logged in the amendment trail for everyone.
router.patch('/docs/:docId', requireProjectMember, requireAnyEdit(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const existing = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!existing) throw notFound('Document not found');
  const b = updateSchema.parse(req.body);

  const isAmendment = existing.status === 'APPROVED';
  if (isAmendment && (!b.amendmentRemark || b.amendmentRemark.trim().length < 3)) {
    throw forbidden('This document is approved. To change it you must give a reason for the amendment (min 3 characters).');
  }
  const amendments = isAmendment
    ? appendAmendment(existing.amendments, { id: req.user!.sub, name: req.user!.name || 'User', email: req.user!.email || '' }, b.amendmentRemark!)
    : undefined;

  // docNumber is unique. If it changed, ensure no other doc already uses it.
  if (b.docNumber !== undefined && b.docNumber !== existing.docNumber) {
    const clash = await prisma.procurementDoc.findUnique({ where: { docNumber: b.docNumber } });
    if (clash) throw conflict(`Document number "${b.docNumber}" is already in use.`);
  }

  // T&C: standard clauses may be struck off but never deleted; locked clauses
  // may not even be edited (Sprint PRD §8.2). Enforced here, not just in the UI.
  let termsSections: ReturnType<typeof normalizeTermsSections> | undefined;
  if (b.termsSections !== undefined) {
    termsSections = normalizeTermsSections(b.termsSections);
    assertTermsMutationsAllowed(normalizeTermsSections(parseJson(existing.termsSections, [])), termsSections);
  }

  // Replace line items if provided + recompute totals.
  let totals = { basicAmount: existing.basicAmount, gstAmount: existing.gstAmount, finalAmount: existing.finalAmount };
  if (b.lineItems) {
    // Only accept BOQ links that belong to this project — a stray id from
    // another project would silently poison that project's cost sheet.
    const wanted = [...new Set(b.lineItems.map((l) => l.boqItemId).filter(Boolean) as string[])];
    const valid = wanted.length
      ? new Set((await prisma.bOQItem.findMany({ where: { id: { in: wanted }, projectId: existing.projectId }, select: { id: true } })).map((i) => i.id))
      : new Set<string>();
    const unknown = wanted.filter((id) => !valid.has(id));
    if (unknown.length) throw badRequest(`BOQ item(s) not found in this project: ${unknown.join(', ')}`);

    await prisma.procurementLineItem.deleteMany({ where: { docId: existing.id } });
    let order = 0;
    for (const li of b.lineItems) {
      const total = li.isLeadTime ? 0 : (li.totalPrice ?? li.qty * li.unitPrice);
      await prisma.procurementLineItem.create({ data: { docId: existing.id, srNo: li.srNo ?? order + 1, description: li.description, uom: li.uom ?? null, qty: li.qty, unitPrice: li.unitPrice, totalPrice: Math.round(total * 100) / 100, isLeadTime: !!li.isLeadTime, gstExempt: !!li.gstExempt, gstExemptRemark: li.gstExemptRemark ?? null, gstPct: li.gstPct ?? null, leadTimeText: li.leadTimeText ?? null, customValues: li.customValues != null ? JSON.stringify(li.customValues) : null, boqItemId: li.boqItemId ?? null, boqHead: li.boqHead ?? null, sortOrder: order++ } });
    }
    totals = computeTotals(b.lineItems.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, totalPrice: l.totalPrice, isLeadTime: l.isLeadTime, gstExempt: l.gstExempt, gstPct: l.gstPct })), b.gstEnabled ?? existing.gstEnabled, b.gstPct ?? existing.gstPct, { basicAmount: b.basicAmount, gstAmount: b.gstAmount, finalAmount: b.finalAmount });
  } else if (b.basicAmount != null || b.gstAmount != null || b.finalAmount != null || b.gstPct != null || b.gstEnabled != null) {
    const lines = await prisma.procurementLineItem.findMany({ where: { docId: existing.id } });
    totals = computeTotals(lines, b.gstEnabled ?? existing.gstEnabled, b.gstPct ?? existing.gstPct, { basicAmount: b.basicAmount, gstAmount: b.gstAmount, finalAmount: b.finalAmount });
  }

  const doc = await prisma.procurementDoc.update({
    where: { id: existing.id },
    data: {
      ...(b.docNumber !== undefined && { docNumber: b.docNumber }),
      ...(b.vendorId !== undefined && { vendorId: b.vendorId }),
      ...(b.vendorName !== undefined && { vendorName: b.vendorName }),
      ...(b.vendorAddress !== undefined && { vendorAddress: b.vendorAddress }),
      ...(b.vendorGstin !== undefined && { vendorGstin: b.vendorGstin }),
      ...(b.vendorContact !== undefined && { vendorContact: b.vendorContact }),
      ...(b.vendorPhone !== undefined && { vendorPhone: b.vendorPhone }),
      ...(b.againstQuotation !== undefined && { againstQuotation: b.againstQuotation }),
      ...(b.invoiceTo !== undefined && { invoiceTo: b.invoiceTo }),
      ...(b.shipTo !== undefined && { shipTo: b.shipTo }),
      ...(b.siteAddress !== undefined && { siteAddress: b.siteAddress }),
      ...(b.promisedDeliveryDate !== undefined && { promisedDeliveryDate: b.promisedDeliveryDate ? new Date(b.promisedDeliveryDate) : null }),
      ...(b.requiredByDate !== undefined && { requiredByDate: b.requiredByDate ? new Date(b.requiredByDate) : null }),
      ...(b.gstEnabled !== undefined && { gstEnabled: b.gstEnabled }),
      ...(b.gstPct !== undefined && { gstPct: b.gstPct }),
      basicAmount: totals.basicAmount, gstAmount: totals.gstAmount, finalAmount: totals.finalAmount,
      ...(b.payAdvancePct !== undefined && { payAdvancePct: b.payAdvancePct }),
      ...(b.payBeforeDeliveryPct !== undefined && { payBeforeDeliveryPct: b.payBeforeDeliveryPct }),
      ...(b.payRunningPct !== undefined && { payRunningPct: b.payRunningPct }),
      ...(b.payPostDeliveryPct !== undefined && { payPostDeliveryPct: b.payPostDeliveryPct }),
      ...(b.payPostCompletionPct !== undefined && { payPostCompletionPct: b.payPostCompletionPct }),
      ...(b.payRetentionPct !== undefined && { payRetentionPct: b.payRetentionPct }),
      ...(b.payGstInclusive !== undefined && { payGstInclusive: b.payGstInclusive }),
      ...(b.customColumns !== undefined && { customColumns: JSON.stringify(b.customColumns) }),
      ...(b.termPis !== undefined && { termPis: JSON.stringify(b.termPis) }),
      ...(b.payTriggers !== undefined && { payTriggers: JSON.stringify(b.payTriggers) }),
      ...(termsSections !== undefined && { termsSections: JSON.stringify(termsSections) }),
      ...(b.overrides !== undefined && { overrides: JSON.stringify(b.overrides) }),
      ...(amendments !== undefined && { amendments }),
    },
    include: {
      lineItems: { orderBy: { sortOrder: 'asc' }, include: { boqItem: { select: { id: true, srNo: true, description: true, unit: true, makeModel: true } } } },
      milestones: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (isAmendment) {
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_AMEND', entity: 'ProcurementDoc', entityId: doc.id, details: { remark: b.amendmentRemark } });
  }
  res.json({ doc: serializeDoc(doc) });
}));

// PATCH .../docs/:docId/budget-compare — persist the BOQ items the user picked to
// compare on the Budget vs Actual panel (§5). Kept separate from the main PATCH so
// it works whatever the document's status (it changes nothing on the vendor PO).
router.patch('/docs/:docId/budget-compare', requireProjectMember, requireAnyEdit(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const { itemIds } = z.object({ itemIds: z.array(z.string()) }).parse(req.body);
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId }, select: { id: true } });
  if (!doc) throw notFound('Document not found');
  // Keep only real BOQ items of this project.
  const valid = await prisma.bOQItem.findMany({ where: { id: { in: itemIds }, projectId: req.params.projectId }, select: { id: true } });
  const ids = valid.map((v) => v.id);
  await prisma.procurementDoc.update({ where: { id: doc.id }, data: { budgetCompareItemIds: JSON.stringify(ids) } });
  res.json({ ok: true, itemIds: ids });
}));

/**
 * POST .../docs/:docId/delivery — set the delivery commitment.
 *
 * The normal PATCH refuses to touch an APPROVED document, which would leave every
 * PO approved before this feature existed permanently without a delivery date —
 * invisible on the register and excluded from on-time reporting forever.
 *
 * So this endpoint may backfill an APPROVED document, but ONLY while the promised
 * date is still empty. Once a commitment exists it is frozen with the rest of the
 * signed document: letting someone move the goalpost after the fact would make
 * "delivered on time?" answer itself. A genuinely renegotiated date belongs in a
 * revised PO, not an edit.
 */
router.post('/docs/:docId/delivery', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound('Document not found');

  const b = z.object({
    promisedDeliveryDate: z.string().min(1).nullable().optional(),
    requiredByDate: z.string().min(1).nullable().optional(),
  }).parse(req.body ?? {});

  if (doc.status === 'APPROVED' && b.promisedDeliveryDate !== undefined && doc.promisedDeliveryDate) {
    throw forbidden('This document is approved and already carries a promised delivery date. It cannot be changed — raise a revised PO instead.');
  }

  const updated = await prisma.procurementDoc.update({
    where: { id: doc.id },
    data: {
      ...(b.promisedDeliveryDate !== undefined && { promisedDeliveryDate: b.promisedDeliveryDate ? new Date(b.promisedDeliveryDate) : null }),
      ...(b.requiredByDate !== undefined && { requiredByDate: b.requiredByDate ? new Date(b.requiredByDate) : null }),
    },
    include: { grns: { select: { grnDate: true, status: true } } },
  });
  await audit({
    userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_DELIVERY_SET',
    entity: 'ProcurementDoc', entityId: doc.id,
    details: { backfilledOnApproved: doc.status === 'APPROVED', promisedDeliveryDate: b.promisedDeliveryDate, requiredByDate: b.requiredByDate },
  });
  res.json({ doc: serializeDoc(updated) });
}));

// POST .../docs/:docId/submit — submit for approval (validates 100% payment).
// A DRAFT is submitted for the first time; an APPROVED doc that was amended can
// be RE-submitted for fresh approval — it drops back to PENDING_APPROVAL and its
// e-sign / approved stamps are cleared until it is approved again.
router.post('/docs/:docId/submit', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound('Document not found');
  if (doc.status === 'PENDING_APPROVAL') throw badRequest('Already awaiting approval.');
  const isResubmit = doc.status === 'APPROVED';
  const total = paymentTotalPct(doc);
  if (Math.abs(total - 100) > 0.01) throw badRequest(`Payment terms must total 100% (currently ${total}%).`);
  let chain = z.object({ chain: z.array(z.string()).optional() }).parse(req.body ?? {}).chain ?? [];
  // Grouped steps (any-one-approves) when the fixed chain defines them; null lets
  // buildChain treat `chain` as one approver per step (the legacy behaviour).
  let chainGroups: string[][] | null = null;

  // 1) FIXED chain (admin-configured in Users → Approval Chain) wins. When one
  //    exists the document routes through it automatically — the creator never
  //    picks approvers. Any value-mandated approver missing from it is appended
  //    by resolveAutoChain, so Finance still can't be bypassed.
  const auto = await resolveAutoChain(doc.type as MatrixDocType, req.params.projectId, doc.finalAmount);
  if (auto.source === 'fixed') {
    chain = auto.approverIds;
    chainGroups = auto.groups;
  } else {
    // 2) No fixed chain → unchanged legacy behaviour: the value-band matrix fills
    //    an empty selection, and a hand-picked chain must still satisfy it.
    const matrix = await chainForAmount(doc.type as MatrixDocType, req.params.projectId, doc.finalAmount);
    if (matrix.configured && matrix.steps.length) {
      if (chain.length === 0) {
        chain = matrix.steps.map((s) => s.approverId);
      } else {
        const check = await validateChain(doc.type as MatrixDocType, req.params.projectId, doc.finalAmount, chain);
        if (!check.ok) throw badRequest(check.message, { missing: check.missing, amount: doc.finalAmount });
      }
    }
  }

  const updated = await prisma.procurementDoc.update({
    where: { id: doc.id },
    data: {
      status: 'PENDING_APPROVAL',
      // On re-submission after an amendment, clear the prior approval so the doc
      // is genuinely "awaiting approval" again, not still showing as e-signed.
      ...(isResubmit && { esignApplied: false, approvedById: null, approvedAt: null, lockedAt: null }),
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: isResubmit ? 'PROC_DOC_RESUBMIT' : 'PROC_DOC_SUBMIT', entity: 'ProcurementDoc', entityId: doc.id, details: { chainLength: chain.length, resubmit: isResubmit } });
  if (chain.length) {
    // Build the sequential approval chain; only the first approver is notified.
    const actor = await resolveActor(req.account!.id);
    await buildChain(doc.type as DocType, doc.id, req.params.projectId, chainGroups ?? chain, actor);
  } else {
    // No chain chosen → fall back to notifying project admins (legacy behaviour).
    await notifyProjectRoles(req.params.projectId, ['ADMIN'], { type: 'DOC_SUBMITTED', title: `${doc.type} pending approval`, message: `${doc.docNumber} (${doc.vendorName || 'vendor'}) for ${rs(doc.finalAmount)} needs approval.`, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  }
  res.json({ doc: serializeDoc(updated) });
}));

// POST .../docs/:docId/recall — back to draft (FR-MC-12).
router.post('/docs/:docId/recall', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  if (doc.status !== 'PENDING_APPROVAL') throw badRequest('Only pending documents can be recalled');
  const updated = await prisma.procurementDoc.update({ where: { id: doc.id }, data: { status: 'DRAFT' } });
  res.json({ doc: serializeDoc(updated) });
}));

// DELETE .../docs/:docId — remove a DRAFT PO/WO. Only DRAFTs can be deleted; once
// a document is submitted/approved it is a record and must be recalled/amended,
// never deleted.
router.delete('/docs/:docId', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  // A draft was never submitted; an on-hold doc was held during approval and sent
  // back to be corrected — both are safe to discard. A pending or approved
  // document is a record and must be recalled/amended, never deleted.
  if (doc.status !== 'DRAFT' && doc.status !== 'ON_HOLD') throw forbidden('Only a draft or on-hold document can be deleted. Submitted or approved documents cannot be removed.');
  // An on-hold doc is held before approval, so it should carry nothing downstream —
  // but guard anyway: never cascade-delete a doc that already has payments or goods
  // receipts against it (would silently remove real records).
  if (doc.status === 'ON_HOLD') {
    const [payCount, grCount] = await Promise.all([
      prisma.gRN.count({ where: { docId: doc.id } }),
      prisma.goodsReceipt.count({ where: { docId: doc.id } }),
    ]);
    if (payCount > 0 || grCount > 0) throw forbidden('This document has payments or goods receipts against it and cannot be deleted — amend it instead.');
  }
  // Line items cascade on delete; clear the loose bits that don't.
  await prisma.approvalStep.deleteMany({ where: { docType: doc.type, docId: doc.id } });
  await prisma.paymentMilestone.deleteMany({ where: { docId: doc.id } });
  await prisma.procurementDoc.delete({ where: { id: doc.id } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_DELETE', entity: 'ProcurementDoc', entityId: doc.id, details: { docNumber: doc.docNumber, type: doc.type } });
  res.json({ ok: true });
}));

// POST .../docs/:docId/approve — approve the CURRENT chain step (or, if no chain
// was set, a direct admin/canApprove approval). Final approval e-signs + builds
// milestones via finalizeApproval(). requireProjectMember is intentionally NOT
// applied so org-level approvers who aren't project members can still approve.
router.post('/docs/:docId/approve', asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  if (doc.status !== 'PENDING_APPROVAL') throw badRequest('Document is not pending approval');
  const remarks = (typeof req.body?.remarks === 'string' ? req.body.remarks : undefined) || undefined;
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: doc.type, docId: doc.id } });

  if (stepCount > 0) {
    const outcome = await recordDecision(doc.type as DocType, doc.id, actor, 'APPROVE', remarks);
    if (outcome === 'COMPLETED') await finalizeApproval(doc.type as DocType, doc.id, actor.id);
    await audit({ userId: actor.id, projectId: req.params.projectId, action: 'PROC_DOC_APPROVE', entity: 'ProcurementDoc', entityId: doc.id, details: { outcome } });
    return res.json({ ok: true, outcome });
  }

  // Legacy path (no chain): admin / canApprove approves directly.
  if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
  await finalizeApproval(doc.type as DocType, doc.id, actor.id);
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'PROC_DOC_APPROVE', entity: 'ProcurementDoc', entityId: doc.id, details: { outcome: 'COMPLETED', legacy: true } });
  res.json({ ok: true, outcome: 'COMPLETED' });
}));

// Put a PO/WO on hold: the approver spotted something to correct, so the document
// goes back to the raiser with a note instead of being rejected outright.
router.post('/docs/:docId/hold', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(1, 'Say what needs to be corrected.') }).parse(req.body);
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  if (doc.status !== 'PENDING_APPROVAL') throw badRequest('Document is not pending approval');
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: doc.type, docId: doc.id } });
  if (stepCount > 0) {
    await recordDecision(doc.type as DocType, doc.id, actor, 'HOLD', reason);
    await markDocOnHold(doc.type as DocType, doc.id, reason);
  } else {
    if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
    await markDocOnHold(doc.type as DocType, doc.id, reason);
    if (doc.createdById) await notifyUser(doc.createdById, { type: 'DOC_ON_HOLD', title: `${doc.type} on hold`, message: `${doc.docNumber} needs correction: ${reason}`, projectId: req.params.projectId, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${req.params.projectId}` });
  }
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'PROC_DOC_HOLD', entity: 'ProcurementDoc', entityId: doc.id, details: { reason } });
  res.json({ ok: true });
}));

// POST .../docs/:docId/remind — re-notify the current pending approver.
router.post('/docs/:docId/remind', requireProjectMember, asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  const actor = await resolveActor(req.account!.id);
  await remindCurrent(doc.type as DocType, doc.id, actor);
  res.json({ ok: true });
}));

// Build a human, filesystem-safe PDF name: "<number>-<vendor>-<project>.pdf",
// e.g. "PO-IN801-A ONE INDUSTRIES-FKI Bhopal.pdf". Invalid path characters are
// stripped and empty parts dropped so the name never breaks a download.
function pdfFileName(...parts: (string | null | undefined)[]): string {
  const clean = parts
    .map((p) => (p || '').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return (clean.join('-') || 'document') + '.pdf';
}

// GET .../docs/:docId/pdf — render the PO/WO PDF.
router.get('/docs/:docId/pdf', requireProjectMember, requireAnyPage(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId }, include: { lineItems: { orderBy: { sortOrder: 'asc' } }, project: { select: { name: true } } } });
  if (!doc) throw notFound();
  // The clean PDF (for the supplier) carries NO approval trail. Only when the
  // caller asks with ?approvals=1 do we print the internal FINAL APPROVAL stamp
  // (who approved, when, with what remark) under the signature.
  const withApprovals = req.query.approvals === '1';
  let approvals: { name: string; role: string | null; at: Date | null; remarks: string | null }[] | undefined;
  if (withApprovals) {
    const chain = await getChainState(doc.type as DocType, doc.id);
    approvals = chain.steps
      .filter((s) => s.status === 'APPROVED')
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ name: s.approverName, role: s.approverRole, at: s.actedAt, remarks: s.remarks }));
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdfFileName(doc.docNumber, doc.vendorName, doc.project?.name, withApprovals ? 'Approved' : undefined)}"`);
  renderProcurementPdf({ ...doc, approvals, termsSections: normalizeTermsSections(parseJson(doc.termsSections, [])) } as any, res);
}));

// POST .../docs/:docId/term-pi/:termKey — upload the Proforma Invoice for ONE
// payment term (advance | beforeDelivery | …). Stored on the PO under termPis so
// the approver sees each term's PI and a GRN raised for that term auto-fetches it.
const TERM_KEYS = ['advance', 'beforeDelivery', 'running', 'postDelivery', 'postCompletion', 'retention'];
router.post('/docs/:docId/term-pi/:termKey', requireProjectMember, requireAnyEdit(...DOC_PAGES), upload.single('file'), asyncHandler(async (req, res) => {
  const termKey = req.params.termKey;
  if (!TERM_KEYS.includes(termKey)) throw badRequest('Unknown payment term.');
  if (!req.file) throw badRequest('No file uploaded (field: file)');
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound('Document not found');
  const fileUrl = `/uploads/${req.file.filename}`;
  // Read the PI so number / date / value fill themselves (best-effort).
  const extracted = await extractPiFields(req.file.path, req.file.mimetype).catch(() => null);
  const termPis = parseJson(doc.termPis, {}) as Record<string, any>;
  termPis[termKey] = {
    piPdfUrl: fileUrl,
    piNumber: extracted?.piNumber ?? termPis[termKey]?.piNumber ?? null,
    piDate: extracted?.piDate ?? termPis[termKey]?.piDate ?? null,
    piValue: extracted?.piValue ?? termPis[termKey]?.piValue ?? null,
  };
  await prisma.procurementDoc.update({ where: { id: doc.id }, data: { termPis: JSON.stringify(termPis) } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'PROFORMA_INVOICE', fileName: req.file.originalname, fileUrl, linkedDocNumber: doc.docNumber, vendorName: doc.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  // The approval email carries the per-term PIs, but it is sent when the approver
  // is notified. If the PI is uploaded AFTER the PO/WO was submitted, the current
  // approver's email already went out without it — so re-notify them now with the
  // updated PI. Best-effort: never fail the upload if the email hiccups.
  if (doc.status === 'PENDING_APPROVAL') {
    try {
      const actor = await resolveActor(req.account!.id);
      await remindCurrent(doc.type as DocType, doc.id, actor);
    } catch { /* email is best-effort; the PI is saved regardless */ }
  }
  res.json({ ok: true, termKey, pi: termPis[termKey], extracted });
}));

// ── Payment milestones ──────────────────────────────────────────────────────
router.post('/docs/:docId/milestones/:mid/trigger', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const { date } = z.object({ date: z.string().optional() }).parse(req.body ?? {});
  const m = await prisma.paymentMilestone.findFirst({ where: { id: req.params.mid, docId: req.params.docId } });
  if (!m) throw notFound('Milestone not found');
  // A payment can only be triggered once the GRN FOR THIS SPECIFIC milestone is
  // approved — each payment term is backed by its own goods receipt, so another
  // milestone's approved GRN must not unlock this one. Two distinct cases so the
  // popup tells the user exactly what to do.
  const grns = await prisma.gRN.findMany({ where: { docId: req.params.docId, milestoneId: m.id }, select: { status: true } });
  const hasApprovedGrn = grns.some((g) => g.status === 'APPROVED');
  if (!hasApprovedGrn) {
    throw badRequest(
      grns.length === 0
        ? `No payment has been raised for this term (${m.name}) yet. Create a Payment for it and get it approved before triggering.`
        : `The payment for this term (${m.name}) is still pending approval. Once it is approved you can trigger this payment.`,
    );
  }
  const updated = await prisma.paymentMilestone.update({ where: { id: m.id }, data: { status: 'TRIGGERED', actualTriggerDate: date ? new Date(date) : new Date(), accountsNotifiedAt: new Date() } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'MILESTONE_TRIGGER', entity: 'PaymentMilestone', entityId: m.id, details: { name: m.name, inr: m.inrAmount } });
  const pdoc = await prisma.procurementDoc.findUnique({ where: { id: req.params.docId }, select: { docNumber: true, vendorName: true } });
  await notifyProjectRoles(req.params.projectId, ['MANAGEMENT'], { type: 'MILESTONE_TRIGGERED', title: 'Payment milestone triggered', message: `${m.name} (${rs(m.inrAmount)}) triggered on ${pdoc?.docNumber} — ${pdoc?.vendorName || 'vendor'}. Ready to pay.`, relatedDocType: 'PaymentMilestone', relatedDocId: m.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  res.json({ milestone: maskFinancials(updated, req.account) });
}));

// POST .../milestones/:mid/pay — Accounts records the payment. UTR + payment
// date are entered manually today; FMS auto-fetch is Phase 2 (Sprint PRD §9).
router.post('/docs/:docId/milestones/:mid/pay', requireProjectMember, requireSection('canMarkPaid'), asyncHandler(async (req, res) => {
  const b = z.object({
    // Optional part-payment amount (Amisha PRD A1/A3). Omitted → clear the whole
    // remaining balance (the common full-payment case).
    amount: z.coerce.number().positive().optional(),
    paymentDate: z.string().optional(),
    paymentReference: z.string().optional(),
    utrNumber: z.string().trim().min(1, 'UTR number is required.'),
    remarks: z.string().optional(),
  }).parse(req.body ?? {});
  const m = await prisma.paymentMilestone.findFirst({ where: { id: req.params.mid, docId: req.params.docId } });
  if (!m) throw notFound();

  const remaining = milestoneRemaining(m);
  if (remaining <= 0) throw badRequest('This term is already fully paid.');
  const amount = b.amount != null ? Math.round(b.amount * 100) / 100 : remaining;
  if (amount <= 0) throw badRequest('Enter a payment amount greater than zero.');
  if (amount > remaining + 0.01) throw badRequest(`Amount exceeds the remaining balance for this term (${rs(remaining)} pending).`);

  // The term's OWN payment must be approved before any (part-)payment is released —
  // an early-triggered term can't be paid on another term's approved headroom.
  const ownGrns = await prisma.gRN.findMany({ where: { docId: req.params.docId, milestoneId: m.id }, select: { status: true } });
  if (!ownGrns.some((g) => g.status === 'APPROVED')) {
    throw badRequest(`The payment for this term (${m.name}) is not approved yet — it can be paid only after its approval is complete.`);
  }

  // Cap total payments at the actual invoiced amount: you cannot pay a vendor more
  // than the total value of their APPROVED GRN invoices for this PO/WO.
  const [grns, allMs] = await Promise.all([
    prisma.gRN.findMany({ where: { docId: req.params.docId, status: 'APPROVED' }, select: { invoiceValue: true } }),
    prisma.paymentMilestone.findMany({ where: { docId: req.params.docId }, select: { amountPaid: true, inrAmount: true, status: true } }),
  ]);
  const invoiced = grns.reduce((s, g) => s + (g.invoiceValue ?? 0), 0);
  const paidSoFar = allMs.reduce((s, x) => s + milestonePaidAmount(x), 0);
  if (invoiced <= 0) throw badRequest('No approved GRN invoice yet — approve a GRN before marking payments paid.');
  if (Math.round((paidSoFar + amount) * 100) / 100 > Math.round(invoiced * 100) / 100) {
    throw badRequest(`This payment (${rs(amount)}) would exceed the invoiced amount. Invoiced ${rs(invoiced)}, already paid ${rs(paidSoFar)}, remaining payable ${rs(Math.max(invoiced - paidSoFar, 0))}.`);
  }

  const paymentDate = b.paymentDate ? new Date(b.paymentDate) : new Date();
  const newPaid = Math.round((milestonePaidAmount(m) + amount) * 100) / 100;
  const fullyPaid = newPaid >= m.inrAmount - 0.01;
  // Log this transfer as its own installment (auditable part-payment history).
  await prisma.paymentInstallment.create({ data: { milestoneId: m.id, docId: req.params.docId, amount, utrNumber: b.utrNumber, paymentReference: b.paymentReference || b.utrNumber, paymentDate, remarks: b.remarks, paidById: req.user!.sub } });
  const updated = await prisma.paymentMilestone.update({
    where: { id: m.id },
    data: {
      amountPaid: newPaid,
      status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
      paymentDate,
      utrNumber: b.utrNumber,
      // Keep the legacy free-text reference populated (older rows and the sheets
      // export read it); default it to the UTR when nothing else was given.
      paymentReference: b.paymentReference || b.utrNumber,
      remarks: b.remarks ?? m.remarks,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'MILESTONE_PAY', entity: 'PaymentMilestone', entityId: m.id, details: { amount, utrNumber: b.utrNumber, paymentDate, partial: !fullyPaid, amountPaid: newPaid } });
  res.json({ milestone: maskFinancials(updated, req.account) });
}));

// POST .../milestones/:mid/proof — attach the NEFT receipt / transfer screenshot.
router.post('/docs/:docId/milestones/:mid/proof', requireProjectMember, requireSection('canMarkPaid'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded (field: file)');
  const m = await prisma.paymentMilestone.findFirst({ where: { id: req.params.mid, docId: req.params.docId } });
  if (!m) throw notFound('Milestone not found');
  const fileUrl = `/uploads/${req.file.filename}`;
  const updated = await prisma.paymentMilestone.update({ where: { id: m.id }, data: { paymentProofUrl: fileUrl } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'PAYMENT_PROOF', fileName: req.file.originalname, fileUrl, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'MILESTONE_PROOF', entity: 'PaymentMilestone', entityId: m.id });
  res.status(201).json({ milestone: maskFinancials(updated, req.account) });
}));

// PATCH a milestone (manual override of name/amount/date).
router.patch('/docs/:docId/milestones/:mid', requireProjectMember, requireAnyEdit(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().optional(), triggerCondition: z.string().optional(), inrAmount: z.number().optional(), expectedDate: z.string().nullable().optional() }).parse(req.body);
  const updated = await prisma.paymentMilestone.update({ where: { id: req.params.mid }, data: { ...(b.name !== undefined && { name: b.name }), ...(b.triggerCondition !== undefined && { triggerCondition: b.triggerCondition }), ...(b.inrAmount !== undefined && { inrAmount: b.inrAmount }), ...(b.expectedDate !== undefined && { expectedDate: b.expectedDate ? new Date(b.expectedDate) : null }) } });
  res.json({ milestone: updated });
}));

// ── GRN payment helpers (GRN/Payment PRD v3) ─────────────────────────────────
// Amisha does the vendor payment on the GRN itself: she picks which PO milestone
// is being paid, uploads the PI, and the advance already paid on that PO
// auto-fills. On GRN approval the linked milestone is TRIGGERED so the Payment
// Pipeline (Accounts' screen) stays in step — we never touch the Pipeline UI.

// The PO's payment terms (milestones) for the dropdown; paid ones are flagged so
// the UI can disable them (§3.2–3.3).
async function milestonesForDoc(docId: string | null | undefined) {
  if (!docId) return [];
  return prisma.paymentMilestone.findMany({
    where: { docId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true, fieldKey: true, percentage: true, inrAmount: true, amountPaid: true, status: true },
  });
}

// "Advance already paid" on the PO — the sum of its TRIGGERED/PAID milestones,
// which auto-captures on the GRN payment entry (§3.4).
async function advancePaidOnDoc(docId: string | null | undefined): Promise<number> {
  if (!docId) return 0;
  const rows = await prisma.paymentMilestone.findMany({
    where: { docId, status: { in: ['TRIGGERED', 'PAID'] } },
    select: { inrAmount: true },
  });
  return rows.reduce((s, r) => s + (r.inrAmount || 0), 0);
}

// On GRN approval: reflect the chosen milestone onto the PO's Payment Pipeline
// (PENDING → TRIGGERED) and start the GRN's own payment ladder (→ TRIGGERED), so
// it flows to Accounts to pay. Mirrors the FMS entry so the two stay consistent.
// Only meaningful when a milestone/payment is attached — pure goods-receipt GRNs
// carry no payment lifecycle.
async function onGrnApproved(grn: { id: string; milestoneId: string | null; paymentStatus: string | null }) {
  if (!grn.milestoneId) return;
  const m = await prisma.paymentMilestone.findUnique({ where: { id: grn.milestoneId } });
  if (m && m.status === 'PENDING') {
    await prisma.paymentMilestone.update({ where: { id: m.id }, data: { status: 'TRIGGERED', actualTriggerDate: new Date() } });
  }
  // Advance the GRN payment ladder to TRIGGERED unless it's already further along
  // (a re-approval after an amendment must not rewind PAID/CLOSED).
  if (!grn.paymentStatus) {
    await prisma.gRN.update({ where: { id: grn.id }, data: { paymentStatus: 'TRIGGERED' } });
  }
}

// Accounts recorded the UTR on the GRN: settle the whole term. Keeps amountPaid
// in step (source of truth for the cost rollups) and logs the balance as an
// installment so the payment history stays complete.
async function payGrnMilestone(grn: { milestoneId: string | null }, utr: string | null, paidAt: Date) {
  if (!grn.milestoneId) return;
  const m = await prisma.paymentMilestone.findUnique({ where: { id: grn.milestoneId } });
  if (m && m.status !== 'PAID') {
    const delta = Math.round((m.inrAmount - milestonePaidAmount(m)) * 100) / 100;
    if (delta > 0) await prisma.paymentInstallment.create({ data: { milestoneId: m.id, docId: m.docId, amount: delta, utrNumber: utr, paymentReference: utr, paymentDate: paidAt } });
    await prisma.paymentMilestone.update({ where: { id: m.id }, data: { status: 'PAID', amountPaid: m.inrAmount, paymentDate: paidAt, utrNumber: utr, paymentReference: utr } });
  }
}

// Payment-approval email + sequential step chain now live in services/paymentChain
// (buildPaymentSteps / notifyCurrentPaymentStep / decidePaymentStep).

// ── GRN ─────────────────────────────────────────────────────────────────────
//
// Who sees what (Sprint PRD §7.2). A site engineer raises the GRN and must see
// PO items, quantities and enter the vendor's invoice value — but never the PO's
// unit price or total value: that is commercial data.
//
// `invoiceValue` is the engineer's OWN data entry, transcribed from the vendor
// invoice, so it is deliberately not masked on GRN endpoints (the generic
// maskFinancials would strip it and make the mandatory field unfillable). PO
// pricing is surfaced under the distinct `poUnitPrice` / `poTotalPrice` keys and
// nulled for anyone with hideFinancials.
function serializeGrn(grn: any, acc: Parameters<typeof maskFinancials>[1]) {
  const hide = shouldHideFinancials(acc);
  return {
    ...grn,
    amendments: parseJson(grn.amendments, []),
    poVisible: !hide,
    ...(grn.doc && { doc: { ...grn.doc, finalAmount: hide ? null : grn.doc.finalAmount } }),
    ...(grn.lineItems && {
      lineItems: grn.lineItems.map(({ lineItem, ...l }: any) => ({
        ...l,
        remainingToReceive: Math.max(l.poQty - l.previouslyReceivedQty, 0),
        poUnitPrice: hide ? null : lineItem?.unitPrice ?? null,
        poTotalPrice: hide ? null : lineItem?.totalPrice ?? null,
      })),
    }),
  };
}

router.get('/grns', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const grns = await prisma.gRN.findMany({ where: { projectId: req.params.projectId }, orderBy: { createdAt: 'desc' }, include: { doc: { select: { docNumber: true, type: true, finalAmount: true } } } });
  // Who raised each GRN — shown on the register so it is clear who to go back to.
  const creators = await creatorsById(grns.map((g) => g.raisedById));
  // Current pending approver for GRNs still awaiting approval (status OPEN).
  const pendingIds = grns.filter((g) => g.status === 'OPEN').map((g) => g.id);
  const pendingSteps = pendingIds.length
    ? await prisma.approvalStep.findMany({ where: { docType: 'GRN', docId: { in: pendingIds }, status: 'PENDING' }, select: { docId: true, approverName: true, approverRole: true } })
    : [];
  const pendingBy = new Map(pendingSteps.map((s) => [s.docId, s]));
  res.json({
    grns: grns.map((g) => ({
      ...serializeGrn(g, req.account),
      createdBy: (g.raisedById && creators.get(g.raisedById)) || null,
      pendingWith: pendingBy.get(g.id)?.approverName ?? null,
      pendingWithRole: pendingBy.get(g.id)?.approverRole ?? null,
    })),
  });
}));

// GET .../grns/available-docs — approved PO/WOs a GRN can be raised against.
// Gated on the GRN page (not pay/po/wo) so a site engineer with only the GRN
// grant can still pick a PO, and it never carries a rupee value.
router.get('/grns/available-docs', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, status: 'APPROVED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, type: true, docNumber: true, vendorName: true, docDate: true, _count: { select: { grns: true } } },
  });
  res.json({ docs: docs.map((d) => ({ ...d, grnCount: d._count.grns, _count: undefined })) });
}));

// POST .../grns — raise a GRN against an approved PO/WO (header auto-fills).
router.post('/grns', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const { docId } = z.object({ docId: z.string() }).parse(req.body);
  const doc = await prisma.procurementDoc.findFirst({ where: { id: docId, projectId: req.params.projectId }, include: { lineItems: { where: { isLeadTime: false }, orderBy: { sortOrder: 'asc' } } } });
  if (!doc) throw notFound('PO/WO not found');
  if (doc.status !== 'APPROVED') throw badRequest('GRN can only be raised against an approved PO/WO');

  // Previously received per line (sum of approved GRNs).
  const prior = await prisma.gRNLineItem.groupBy({ by: ['lineItemId'], where: { lineItem: { docId }, grn: { status: 'APPROVED' } }, _sum: { receiptQty: true } });
  const priorMap = new Map(prior.map((p) => [p.lineItemId, p._sum.receiptQty ?? 0]));

  // This record is the payment entry (surfaced as "Payment") — number it PAY-QAS-###.
  // The real goods-receipt register owns the GRN-QAS-### series now.
  const grnNumber = await nextDocNumber('PAY');
  const grn = await prisma.gRN.create({
    data: {
      projectId: req.params.projectId, docId, grnNumber, vendorName: doc.vendorName, siteAddress: doc.siteAddress || doc.shipTo, raisedById: req.user!.sub, status: 'DRAFT',
      lineItems: { create: doc.lineItems.map((li, i) => ({ lineItemId: li.id, srNo: i + 1, description: li.description, uom: li.uom, poQty: li.qty, previouslyReceivedQty: priorMap.get(li.id) ?? 0, receiptQty: 0, defectQty: 0, acceptedQty: 0 })) },
    },
    include: { lineItems: { orderBy: { srNo: 'asc' }, include: { lineItem: { select: { unitPrice: true, totalPrice: true } } } } },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_CREATE', entity: 'GRN', entityId: grn.id, details: { grnNumber, against: doc.docNumber } });
  res.status(201).json({ grn: serializeGrn(grn, req.account) });
}));

router.get('/grns/:grnId', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({
    where: { id: req.params.grnId, projectId: req.params.projectId },
    include: {
      lineItems: { orderBy: { srNo: 'asc' }, include: { lineItem: { select: { unitPrice: true, totalPrice: true } } } },
      doc: { select: { docNumber: true, type: true, finalAmount: true, vendorId: true } },
    },
  });
  if (!grn) throw notFound();
  const approval = await getChainState('GRN', grn.id);
  // Payment section (§3): the PO's milestones for the term dropdown and the
  // advance already paid, which auto-fills to compute the balance.
  const milestones = await milestonesForDoc(grn.docId);
  const advanceOnPo = await advancePaidOnDoc(grn.docId);
  // Attach each term's PI (uploaded on the PO) so picking the term in the GRN
  // form auto-fetches that term's PI (number / date / value / PDF).
  const parentDoc = await prisma.procurementDoc.findUnique({ where: { id: grn.docId }, select: { termPis: true } });
  const termPis = parseJson(parentDoc?.termPis, {}) as Record<string, any>;
  // Partial payments (Amisha A1/A3): a term can be paid across several Payment
  // entries. `committed` is what OTHER active entries already claim against each
  // term; `remaining` is what is still open to pay — so the dropdown shows how
  // much of e.g. the Advance is left, and the term stays selectable until full.
  const termGrns = await prisma.gRN.findMany({
    where: { docId: grn.docId, id: { not: grn.id }, milestoneId: { not: null }, status: { in: ['OPEN', 'APPROVED'] } },
    select: { milestoneId: true, amountToPay: true },
  });
  const claimsByTerm = new Map<string, (number | null)[]>();
  for (const tg of termGrns) {
    if (!tg.milestoneId) continue;
    const arr = claimsByTerm.get(tg.milestoneId) ?? [];
    arr.push(tg.amountToPay);
    claimsByTerm.set(tg.milestoneId, arr);
  }
  const milestonesWithPi = milestones.map((mm: any) => {
    // A claim with no explicit amount pays the whole term.
    let committedRaw = 0;
    for (const a of claimsByTerm.get(mm.id) ?? []) committedRaw += a != null ? a : (mm.inrAmount as number);
    const committed = Math.round(committedRaw * 100) / 100;
    const remaining = Math.round(Math.max(mm.inrAmount - committed, 0) * 100) / 100;
    return { ...mm, pi: termPis[mm.fieldKey] ?? null, committed, remaining };
  });
  // The vendor's KYC already lives on the vendor master, so the payment section
  // shows it rather than asking for it again — read-only, never re-uploaded here.
  const kycDocs = await vendorKycDocs(grn.doc?.vendorId ?? null);
  res.json({ grn: serializeGrn(grn, req.account), approval, milestones: milestonesWithPi, advanceOnPo, kycDocs });
}));

/** EVERY KYC document on file for a vendor (GST certificate, PAN, cancelled
 *  cheque, …) — the whole set, not just the newest one. */
export async function vendorKycDocs(vendorId: string | null) {
  if (!vendorId) return [];
  const docs = await prisma.procurementDocument.findMany({
    where: { vendorId, type: 'KYC' },
    orderBy: { uploadedAt: 'desc' },
    select: { id: true, kycKind: true, fileName: true, fileUrl: true },
  });
  return docs.map((d) => ({ id: d.id, kind: d.kycKind || 'KYC', fileName: d.fileName, fileUrl: d.fileUrl }));
}

// Accept null on optional fields — the client sends null (not undefined) for
// empty text inputs and for line-item remarks pulled straight from the DB.
// Numbers are coerced so string-typed inputs ("12324") validate cleanly.
const grnUpdate = z.object({
  vehicleNumber: z.string().nullable().optional(), driverName: z.string().nullable().optional(), deliveryChallanNumber: z.string().nullable().optional(),
  invoiceNumber: z.string().nullable().optional(), invoiceDate: z.string().nullable().optional(), invoiceValue: z.coerce.number().nullable().optional(), ewayBillNumber: z.string().nullable().optional(),
  // Payment (§3): which PO milestone is being paid, the PI that drives it, and
  // the (editable, possibly partial) amount to pay.
  milestoneId: z.string().nullable().optional(), milestoneKey: z.string().nullable().optional(), milestoneName: z.string().nullable().optional(),
  piNumber: z.string().nullable().optional(), piDate: z.string().nullable().optional(), paymentDueDate: z.string().nullable().optional(), piValue: z.coerce.number().nullable().optional(),
  amountToPay: z.coerce.number().nullable().optional(),
  lineItems: z.array(z.object({ id: z.string(), receiptQty: z.coerce.number().catch(0), defectQty: z.coerce.number().nullable().optional(), remarks: z.string().nullable().optional() })).optional(),
  // Required to amend an APPROVED GRN — the reason for the post-approval change.
  amendmentRemark: z.string().trim().max(2000).optional(),
});
router.patch('/grns/:grnId', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId }, include: { lineItems: true } });
  if (!grn) throw notFound();
  const b = grnUpdate.parse(req.body);

  // On a payment GRN the tax invoice legitimately arrives AFTER approval (§6), so
  // recording its number/date/value is the closing step, not an amendment — no
  // reason required. A patch that touches anything else is still an amendment.
  const TAX_INVOICE_FIELDS = ['invoiceNumber', 'invoiceDate', 'invoiceValue', 'ewayBillNumber'];
  const touched = Object.keys(b).filter((k) => k !== 'amendmentRemark' && (b as Record<string, unknown>)[k] !== undefined);
  const taxInvoiceOnly = touched.length > 0 && touched.every((k) => TAX_INVOICE_FIELDS.includes(k));
  const closingTaxInvoice = grn.status === 'APPROVED' && !!grn.milestoneId && taxInvoiceOnly;

  // An approved GRN may be amended, but only with a reason — logged for everyone.
  const isAmendment = grn.status === 'APPROVED' && !closingTaxInvoice;
  if (isAmendment && (!b.amendmentRemark || b.amendmentRemark.trim().length < 3)) {
    throw forbidden('This GRN is approved. To change it you must give a reason for the amendment (min 3 characters).');
  }
  const amendments = isAmendment
    ? appendAmendment(grn.amendments, { id: req.user!.sub, name: req.user!.name || 'User', email: req.user!.email || '' }, b.amendmentRemark!)
    : undefined;
  if (b.lineItems) {
    for (const li of b.lineItems) {
      const existing = grn.lineItems.find((x) => x.id === li.id);
      if (!existing) continue;
      const defect = li.defectQty ?? 0;
      await prisma.gRNLineItem.update({ where: { id: li.id }, data: { receiptQty: li.receiptQty, defectQty: defect, acceptedQty: Math.max(li.receiptQty - defect, 0), remarks: li.remarks } });
    }
  }
  const updated = await prisma.gRN.update({
    where: { id: grn.id },
    data: {
      ...(b.vehicleNumber !== undefined && { vehicleNumber: b.vehicleNumber }), ...(b.driverName !== undefined && { driverName: b.driverName }), ...(b.deliveryChallanNumber !== undefined && { deliveryChallanNumber: b.deliveryChallanNumber }),
      ...(b.invoiceNumber !== undefined && { invoiceNumber: b.invoiceNumber }), ...(b.invoiceDate !== undefined && { invoiceDate: b.invoiceDate ? new Date(b.invoiceDate) : null }), ...(b.invoiceValue !== undefined && { invoiceValue: b.invoiceValue }), ...(b.ewayBillNumber !== undefined && { ewayBillNumber: b.ewayBillNumber }),
      ...(b.milestoneId !== undefined && { milestoneId: b.milestoneId }), ...(b.milestoneKey !== undefined && { milestoneKey: b.milestoneKey }), ...(b.milestoneName !== undefined && { milestoneName: b.milestoneName }),
      ...(b.piNumber !== undefined && { piNumber: b.piNumber }), ...(b.piDate !== undefined && { piDate: b.piDate ? new Date(b.piDate) : null }), ...(b.paymentDueDate !== undefined && { paymentDueDate: b.paymentDueDate ? new Date(b.paymentDueDate) : null }), ...(b.piValue !== undefined && { piValue: b.piValue }),
      ...(b.amountToPay !== undefined && { amountToPay: b.amountToPay }),
      ...(amendments !== undefined && { amendments }),
    },
    include: { lineItems: { orderBy: { srNo: 'asc' }, include: { lineItem: { select: { unitPrice: true, totalPrice: true } } } } },
  });
  if (isAmendment) {
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_AMEND', entity: 'GRN', entityId: grn.id, details: { remark: b.amendmentRemark } });
  } else if (closingTaxInvoice) {
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_TAX_INVOICE', entity: 'GRN', entityId: grn.id, details: { invoiceNumber: b.invoiceNumber, invoiceValue: b.invoiceValue } });
  }
  // A DRAFT GRN's save (PI number/date/value, amount, due date, tax-invoice
  // details) isn't audited above, but it still changes what the FMS sheet shows —
  // so reflect EVERY successful save, not just approved-GRN amendments.
  scheduleSheetSync();
  res.json({ grn: serializeGrn(updated, req.account) });
}));

// Upload the Tax Invoice PDF. It arrives AFTER payment (§6): uploading it on a
// PAID GRN CLOSES the payment entry so it leaves Amisha's bucket. If payment has
// not happened yet it just attaches — the GRN can be "paid but still open".
router.post('/grns/:grnId/invoice', requireProjectMember, requireEdit('grn'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const fileUrl = `/uploads/${req.file.filename}`;
  const existing = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId }, select: { paymentStatus: true } });
  const closeNow = existing?.paymentStatus === 'PAID';
  const grn = await prisma.gRN.update({
    where: { id: req.params.grnId },
    data: { invoicePdfUrl: fileUrl, ...(closeNow && { paymentStatus: 'CLOSED', paymentClosedAt: new Date() }) },
  });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'TAX_INVOICE', fileName: req.file.originalname, fileUrl, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  if (closeNow) await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_PAYMENT_CLOSE', entity: 'GRN', entityId: grn.id, details: { via: 'tax-invoice' } });
  res.json({ ok: true, invoicePdfUrl: grn.invoicePdfUrl, paymentStatus: grn.paymentStatus });
}));

// Upload the Proforma Invoice (PI) — drives the payment and comes BEFORE the tax
// invoice (§3.1, §3.6). Stored under piPdfUrl on the GRN; PI number/date are
// entered/auto-captured on the form and saved via PATCH.
router.post('/grns/:grnId/pi', requireProjectMember, requireEdit('grn'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const fileUrl = `/uploads/${req.file.filename}`;
  const grn = await prisma.gRN.update({ where: { id: req.params.grnId }, data: { piPdfUrl: fileUrl } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'PROFORMA_INVOICE', fileName: req.file.originalname, fileUrl, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  // Read the PI so the number / date / value fill themselves. Best-effort: a
  // reader failure must never block the upload, so it is returned as a suggestion.
  const extracted = await extractPiFields(req.file.path, req.file.mimetype);
  scheduleSheetSync(); // reflect the new PI (link + read values) onto the FMS sheet
  res.json({ ok: true, piPdfUrl: grn.piPdfUrl, extracted });
}));

// Upload a photo of the received material (optional — Sprint PRD §7.2).
router.post('/grns/:grnId/photo', requireProjectMember, requireEdit('grn'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const fileUrl = `/uploads/${req.file.filename}`;
  const grn = await prisma.gRN.update({ where: { id: req.params.grnId }, data: { photoUrl: fileUrl } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'PHOTO', fileName: req.file.originalname, fileUrl, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  scheduleSheetSync();
  res.status(201).json({ ok: true, photoUrl: grn.photoUrl });
}));

// DELETE .../grns/:grnId — remove a DRAFT GRN only. Once approved it's a record.
router.delete('/grns/:grnId', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (grn.status !== 'DRAFT') throw forbidden('Only a draft GRN can be deleted. A submitted or approved GRN cannot be removed.');
  await prisma.approvalStep.deleteMany({ where: { docType: 'GRN', docId: grn.id } });
  await prisma.gRN.delete({ where: { id: grn.id } }); // GRN line items cascade
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_DELETE', entity: 'GRN', entityId: grn.id, details: { grnNumber: grn.grnNumber } });
  res.json({ ok: true });
}));

router.post('/grns/:grnId/submit', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (grn.status === 'OPEN') throw badRequest('Already awaiting approval.');
  // §1/§6: a payment GRN is submitted against the PI (the tax invoice arrives
  // later and closes it). A pure goods-receipt GRN still needs its tax invoice.
  if (grn.milestoneId) {
    if (!grn.piPdfUrl) throw badRequest('Upload the Proforma Invoice (PI) before submitting — payment is made against the PI.');
    if (grn.amountToPay == null || grn.amountToPay <= 0) throw badRequest('Enter the amount to pay before submitting.');
  } else if (!grn.invoiceNumber || !grn.invoiceDate || grn.invoiceValue == null || !grn.invoicePdfUrl) {
    throw badRequest('Invoice number, date, value and PDF are mandatory before submitting a GRN.');
  }
  // Approval flow removed for payments (user request): submitting finalises the
  // payment directly — NO approval chain, NO approval emails. It goes straight to
  // APPROVED, its payment term triggers (PENDING → TRIGGERED), the payment ladder
  // advances, and it flows onto the FMS sheet. Approval can be re-added later.
  const updated = await prisma.gRN.update({
    where: { id: grn.id },
    data: { status: 'APPROVED', approvedById: req.user!.sub, approvedAt: new Date() },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_SUBMIT', entity: 'GRN', entityId: grn.id, details: { directApprove: true } });
  // Trigger the linked term and advance the payment ladder, then push to the sheet.
  await onGrnApproved(updated);
  scheduleSheetSync();
  // Build the sequential Vendor-Payments step chain and email ONLY the first
  // step (any one of them approves → the next step is mailed, and so on). Only
  // for payment GRNs (a pure goods-receipt GRN has no payment to sign off).
  if (updated.milestoneId) { await buildPaymentSteps(updated); await notifyCurrentPaymentStep(updated); }
  res.json({ grn: updated });
}));

// POST /grns/:grnId/resubmit-approval — the payment was put ON_HOLD by management
// from the FMS "Approval Form"; after the creator corrects it, re-submitting clears
// the hold (releaseStatus → null / Pending) so management can review again. Only
// clears the release decision — the payment's own status/lifecycle is untouched.
router.post('/grns/:grnId/resubmit-approval', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (grn.releaseStatus !== 'ON_HOLD') throw badRequest('This payment is not on hold.');
  // → RESUBMITTED: goes back to the approver as "re-submitted". We KEEP the hold
  // remark (releaseRemark) so the approval form still shows what was asked to be
  // corrected. releaseAt = when it was re-submitted.
  await prisma.gRN.update({ where: { id: grn.id }, data: { releaseStatus: 'RESUBMITTED', releaseAt: new Date() } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PAYMENT_RESUBMIT_APPROVAL', entity: 'GRN', entityId: grn.id, details: { grnNumber: grn.grnNumber, previousRemark: grn.releaseRemark } });
  scheduleSheetSync();
  // Back for review → restart the chain at step 1 and mail that step only.
  await buildPaymentSteps(grn);
  await notifyCurrentPaymentStep(grn);
  // Return the FULLY-included GRN (lineItems + doc) — the client replaces its state
  // with this, so a partial payload would crash the form on g.lineItems.map(...).
  const full = await prisma.gRN.findFirst({
    where: { id: grn.id, projectId: req.params.projectId },
    include: {
      lineItems: { orderBy: { srNo: 'asc' }, include: { lineItem: { select: { unitPrice: true, totalPrice: true } } } },
      doc: { select: { docNumber: true, type: true, finalAmount: true, vendorId: true } },
    },
  });
  res.json({ grn: serializeGrn(full, req.account) });
}));

// POST /grns/:grnId/remind-approval — resend the Approval Form email to the
// payment approver(s) (Vendor Payments chain). Same email as on submit — a manual
// "Send Reminder" for a payment whose decision is still pending / on hold.
router.post('/grns/:grnId/remind-approval', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (!grn.milestoneId) throw badRequest('Only a payment can be sent for approval.');
  if (grn.releaseStatus === 'APPROVED') throw badRequest('This payment is already approved.');
  if (!isEmailEnabled()) throw badRequest('Email is not configured, so a reminder cannot be sent.');
  // Re-mail the CURRENT step only (don't restart progress). Build the chain if a
  // pre-existing payment never had one.
  await ensurePaymentSteps(grn);
  await notifyCurrentPaymentStep(grn);
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PAYMENT_APPROVAL_REMIND', entity: 'GRN', entityId: grn.id, details: { grnNumber: grn.grnNumber } });
  res.json({ ok: true });
}));

router.post('/grns/:grnId/approve', asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (grn.status !== 'OPEN') throw badRequest('GRN is not open for approval');
  const remarks = (typeof req.body?.remarks === 'string' ? req.body.remarks : undefined) || undefined;
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: 'GRN', docId: grn.id } });
  if (stepCount > 0) {
    const outcome = await recordDecision('GRN', grn.id, actor, 'APPROVE', remarks);
    if (outcome === 'COMPLETED') { await finalizeApproval('GRN', grn.id, actor.id); await onGrnApproved(grn); }
    await audit({ userId: actor.id, projectId: req.params.projectId, action: 'GRN_APPROVE', entity: 'GRN', entityId: grn.id, details: { outcome } });
    return res.json({ ok: true, outcome });
  }
  if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
  await finalizeApproval('GRN', grn.id, actor.id);
  await onGrnApproved(grn);
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'GRN_APPROVE', entity: 'GRN', entityId: grn.id, details: { legacy: true } });
  res.json({ ok: true, outcome: 'COMPLETED' });
}));

// Put a GRN on hold — back to the raiser with a note on what to correct.
router.post('/grns/:grnId/hold', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(1, 'Say what needs to be corrected.') }).parse(req.body);
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: 'GRN', docId: grn.id } });
  if (stepCount > 0) {
    await recordDecision('GRN', grn.id, actor, 'HOLD', reason);
    await markDocOnHold('GRN', grn.id, reason);
  } else {
    if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
    await markDocOnHold('GRN', grn.id, reason);
  }
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'GRN_HOLD', entity: 'GRN', entityId: grn.id, details: { reason } });
  res.json({ ok: true });
}));

router.post('/grns/:grnId/remind', requireProjectMember, asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  const actor = await resolveActor(req.account!.id);
  await remindCurrent('GRN', grn.id, actor);
  res.json({ ok: true });
}));

// ── Payment side: Accounts pay the vendor (§5–§6) ─────────────────────────────
// After the GRN is approved (milestone TRIGGERED), Accounts enter the UTR and
// Mark Paid. The GRN becomes PAID — but stays OPEN in Amisha's bucket until the
// tax invoice is uploaded, at which point it CLOSES. If the tax invoice is
// already on file, paying closes it immediately.
router.post('/grns/:grnId/mark-paid', requireProjectMember, requireSection('canMarkPaid'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (grn.status !== 'APPROVED') throw badRequest('Only an approved GRN can be marked paid.');
  if (grn.paymentStatus === 'PAID' || grn.paymentStatus === 'CLOSED') throw badRequest('This payment is already marked paid.');
  const b = z.object({ utrNumber: z.string().trim().min(1, 'A UTR / payment reference is required.'), paidAt: z.string().optional() }).parse(req.body ?? {});
  const paidAt = b.paidAt ? new Date(b.paidAt) : new Date();
  // Paid, but only CLOSE once the tax invoice is on file (§6).
  const closeNow = !!grn.invoicePdfUrl;
  const updated = await prisma.gRN.update({
    where: { id: grn.id },
    data: { paymentStatus: closeNow ? 'CLOSED' : 'PAID', utrNumber: b.utrNumber, paidAt, ...(closeNow && { paymentClosedAt: new Date() }) },
  });
  await payGrnMilestone(grn, b.utrNumber, paidAt);
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_MARK_PAID', entity: 'GRN', entityId: grn.id, details: { utr: b.utrNumber, closed: closeNow } });
  res.json({ grn: updated });
}));

// Optional payment-proof PDF (bank advice / UTR screenshot) shown on the entry.
router.post('/grns/:grnId/payment-proof', requireProjectMember, requireSection('canMarkPaid'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const fileUrl = `/uploads/${req.file.filename}`;
  const grn = await prisma.gRN.update({ where: { id: req.params.grnId }, data: { paymentProofUrl: fileUrl } });
  scheduleSheetSync();
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'PAYMENT_PROOF', fileName: req.file.originalname, fileUrl, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  res.json({ ok: true, paymentProofUrl: grn.paymentProofUrl });
}));

// The GRN PDF carries no PO pricing — only the vendor invoice data the raiser
// entered — so it is NOT behind requireFinancialView: the site engineer who
// raised it must be able to open their own document (Sprint PRD §7.3).
router.get('/grns/:grnId/pdf', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId }, include: { lineItems: { orderBy: { srNo: 'asc' } }, doc: { select: { docNumber: true } }, project: { select: { name: true } } } });
  if (!grn) throw notFound();
  // Clean GRN by default; ?approvals=1 adds the internal FINAL APPROVAL stamp.
  const withApprovals = req.query.approvals === '1';
  let approvals: { name: string; role: string | null; at: Date | null; remarks: string | null }[] | undefined;
  if (withApprovals) {
    const chain = await getChainState('GRN', grn.id);
    approvals = chain.steps
      .filter((s) => s.status === 'APPROVED')
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ name: s.approverName, role: s.approverRole, at: s.actedAt, remarks: s.remarks }));
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdfFileName(grn.grnNumber, grn.vendorName, grn.project?.name, withApprovals ? 'Approved' : undefined)}"`);
  renderGRNPdf({ ...grn, docNumber: grn.doc.docNumber, approvals } as any, res);
}));

// ── Goods Receipt (physical delivery at site) ────────────────────────────────
// A literal GRN: material arriving on site against an approved PO/WO. Separate
// from the payment record above (which is surfaced as "Payment"): it captures
// only the delivery (vehicle/driver/challan) and what was received per line.
// Shares the 'grn' page grant, so anyone who could open the old GRN sees it.
// A goods receipt is about the physical delivery, not the money — so no PO
// pricing is attached here (that lives on the Payment record). Just surface how
// much of each line is still outstanding to receive.
// Default columns a CUSTOM packing list starts with (from Amisha's Manifest cum
// Final Packing List — panels). Editable: she can rename / add / remove.
const DEFAULT_PACKING_COLUMNS = [
  { key: 'panelType', label: 'Panel Type' },
  { key: 'width', label: 'Width' },
  { key: 'length', label: 'Length' },
  { key: 'sqmtr', label: 'Sqmtr' },
  { key: 'bundleNo', label: 'Bundle No.' },
];
// The signed packing-list PDFs uploaded against a goods receipt (Phase 4). Stored
// as ProcurementDocument rows (type PACKING_LIST_SIGNED) so they inherit the
// durable GridFS storage + the /uploads read-fallback. Multiple are allowed.
export async function signedDocsFor(grnNumber: string) {
  const docs = await prisma.procurementDocument.findMany({
    where: { type: SIGNED_TYPE, linkedDocNumber: grnNumber, archived: false },
    orderBy: { uploadedAt: 'desc' },
    select: { id: true, fileName: true, fileUrl: true, uploadedAt: true },
  });
  return docs;
}

// Map a GoodsReceipt (+ project + lineItems) to the packing-list PDF shape. Used
// by both the authenticated download and the public site-engineer link.
export function packingListShape(gr: any) {
  return {
    grnNumber: gr.grnNumber,
    packingListNo: gr.packingListNo,
    status: gr.status,
    customerName: gr.project?.clientName ?? null,
    customerAddress: gr.siteAddress || gr.project?.siteLocation || null,
    clientPoNumber: gr.project?.clientPoNumber ?? null,
    invoiceNumber: gr.invoiceNumber,
    dispatchDate: gr.dispatchDate,
    deliveryDate: gr.deliveryDate,
    vehicleNumber: gr.vehicleNumber,
    vehicleSize: gr.vehicleSize,
    ewayBillNumber: gr.ewayBillNumber,
    customColumns: parseJson(gr.customColumns, []),
    lineItems: (gr.lineItems || []).map((l: any) => ({ srNo: l.srNo, description: l.description, receiptQty: l.receiptQty, customValues: parseJson(l.customValues, {}) })),
  };
}

function serializeGoodsReceipt(gr: any) {
  return {
    ...gr,
    customColumns: parseJson(gr.customColumns, []),
    ...(gr.lineItems && {
      lineItems: gr.lineItems.map((l: any) => ({
        ...l,
        customValues: parseJson(l.customValues, {}),
        remainingToReceive: Math.max(l.poQty - l.previouslyReceivedQty, 0),
      })),
    }),
  };
}

router.get('/goods-receipts', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const grs = await prisma.goodsReceipt.findMany({ where: { projectId: req.params.projectId }, orderBy: { createdAt: 'desc' }, include: { doc: { select: { docNumber: true, type: true, finalAmount: true } } } });
  const creators = await creatorsById(grs.map((g) => g.raisedById));
  res.json({ goodsReceipts: grs.map((g) => ({ ...serializeGoodsReceipt(g), createdBy: (g.raisedById && creators.get(g.raisedById)) || null })) });
}));

// Approved PO/WOs a goods receipt can be raised against (mirrors grns/available-docs
// but counts goods receipts, and carries no rupee value so a site engineer can pick one).
router.get('/goods-receipts/available-docs', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, status: 'APPROVED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, type: true, docNumber: true, vendorName: true, docDate: true, _count: { select: { goodsReceipts: true } } },
  });
  res.json({ docs: docs.map((d) => ({ ...d, grnCount: d._count.goodsReceipts, _count: undefined })) });
}));

// Raise a goods receipt against an approved PO/WO. Mode DIRECT (default) mirrors
// the PO lines (received qty per PO item). Mode CUSTOM starts a blank packing list
// that Amisha builds herself — her own rows and configurable columns (panel sizes
// etc. that the PO doesn't carry) — then the site engineer fills received qty.
router.post('/goods-receipts', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const { docId, mode } = z.object({ docId: z.string(), mode: z.enum(['DIRECT', 'CUSTOM']).optional() }).parse(req.body);
  const doc = await prisma.procurementDoc.findFirst({ where: { id: docId, projectId: req.params.projectId }, include: { lineItems: { where: { isLeadTime: false }, orderBy: { sortOrder: 'asc' } } } });
  if (!doc) throw notFound('PO/WO not found');
  if (doc.status !== 'APPROVED') throw badRequest('A goods receipt can only be raised against an approved PO/WO');

  const grnNumber = await nextDocNumber('GR');
  const base = { projectId: req.params.projectId, docId, grnNumber, vendorName: doc.vendorName, siteAddress: doc.siteAddress || doc.shipTo, raisedById: req.user!.sub, status: 'DRAFT' as const };
  let gr;
  if (mode === 'CUSTOM') {
    gr = await prisma.goodsReceipt.create({
      data: { ...base, mode: 'CUSTOM', customColumns: JSON.stringify(DEFAULT_PACKING_COLUMNS) },
      include: { lineItems: { orderBy: { srNo: 'asc' } }, project: { select: { clientName: true, siteLocation: true, clientPoNumber: true } } },
    });
  } else {
    // Previously received per line = sum of already-RECEIVED goods receipts for this PO.
    const prior = await prisma.goodsReceiptLine.groupBy({ by: ['lineItemId'], where: { gr: { docId, status: 'RECEIVED' } }, _sum: { receiptQty: true } });
    const priorMap = new Map(prior.map((p) => [p.lineItemId, p._sum.receiptQty ?? 0]));
    gr = await prisma.goodsReceipt.create({
      data: {
        ...base, mode: 'DIRECT',
        lineItems: { create: doc.lineItems.map((li, i) => ({ lineItemId: li.id, srNo: i + 1, description: li.description, uom: li.uom, poQty: li.qty, previouslyReceivedQty: priorMap.get(li.id) ?? 0, receiptQty: 0, defectQty: 0, acceptedQty: 0 })) },
      },
      include: { lineItems: { orderBy: { srNo: 'asc' } }, project: { select: { clientName: true, siteLocation: true, clientPoNumber: true } } },
    });
  }
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GOODS_RECEIPT_CREATE', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber, against: doc.docNumber, mode: mode || 'DIRECT' } });
  res.status(201).json({ goodsReceipt: serializeGoodsReceipt(gr) });
}));

router.get('/goods-receipts/:grId', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const gr = await prisma.goodsReceipt.findFirst({
    where: { id: req.params.grId, projectId: req.params.projectId },
    include: { lineItems: { orderBy: { srNo: 'asc' } }, doc: { select: { docNumber: true, type: true, finalAmount: true } }, project: { select: { clientName: true, siteLocation: true, clientPoNumber: true } } },
  });
  if (!gr) throw notFound();
  const signedDocs = await signedDocsFor(gr.grnNumber);
  res.json({ goodsReceipt: { ...serializeGoodsReceipt(gr), signedDocs } });
}));

const goodsReceiptUpdate = z.object({
  vehicleNumber: z.string().nullable().optional(), vehicleSize: z.string().nullable().optional(), driverName: z.string().nullable().optional(), deliveryChallanNumber: z.string().nullable().optional(),
  // Packing-list / delivery fields (Amisha interview 63/64).
  invoiceNumber: z.string().nullable().optional(), dispatchDate: z.string().nullable().optional(), deliveryDate: z.string().nullable().optional(), ewayBillNumber: z.string().nullable().optional(),
  remarks: z.string().nullable().optional(),
  // Mode 2 (custom packing list) — configurable columns Amisha builds.
  customColumns: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
  packingListNo: z.coerce.number().int().nullable().optional(),
  // For DIRECT, `id` is always present (PO-derived lines). For CUSTOM the client
  // may add new lines (no id) or drop lines, so id is optional and lines carry a
  // description + customValues.
  lineItems: z.array(z.object({ id: z.string().optional(), description: z.string().optional(), customValues: z.any().optional(), receiptQty: z.coerce.number().catch(0), defectQty: z.coerce.number().nullable().optional(), remarks: z.string().nullable().optional() })).optional(),
});
router.patch('/goods-receipts/:grId', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const gr = await prisma.goodsReceipt.findFirst({ where: { id: req.params.grId, projectId: req.params.projectId }, include: { lineItems: true } });
  if (!gr) throw notFound();
  if (gr.status !== 'DRAFT') throw badRequest('Only a draft goods receipt can be edited');
  const b = goodsReceiptUpdate.parse(req.body);
  if (b.lineItems && gr.mode === 'CUSTOM') {
    // Full sync: keep the sent lines, drop the removed ones, create the new ones.
    const keepIds = b.lineItems.filter((l) => l.id).map((l) => l.id!);
    if (keepIds.length) await prisma.goodsReceiptLine.deleteMany({ where: { grId: gr.id, id: { notIn: keepIds } } });
    else await prisma.goodsReceiptLine.deleteMany({ where: { grId: gr.id } });
    let sr = 0;
    for (const l of b.lineItems) {
      const accepted = Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0);
      const data = { srNo: ++sr, description: l.description ?? '', customValues: l.customValues != null ? JSON.stringify(l.customValues) : null, receiptQty: Number(l.receiptQty) || 0, defectQty: Number(l.defectQty) || 0, acceptedQty: accepted, remarks: l.remarks ?? undefined };
      if (l.id) await prisma.goodsReceiptLine.update({ where: { id: l.id }, data });
      else await prisma.goodsReceiptLine.create({ data: { ...data, grId: gr.id } });
    }
  } else if (b.lineItems) {
    // DIRECT — the PO lines are fixed; only received/defect/remarks are edited.
    for (const l of b.lineItems) {
      if (!l.id) continue;
      const accepted = Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0);
      await prisma.goodsReceiptLine.update({ where: { id: l.id }, data: { receiptQty: Number(l.receiptQty) || 0, defectQty: Number(l.defectQty) || 0, acceptedQty: accepted, remarks: l.remarks ?? undefined } });
    }
  }
  const updated = await prisma.goodsReceipt.update({
    where: { id: gr.id },
    data: {
      vehicleNumber: b.vehicleNumber ?? undefined, vehicleSize: b.vehicleSize ?? undefined, driverName: b.driverName ?? undefined, deliveryChallanNumber: b.deliveryChallanNumber ?? undefined, remarks: b.remarks ?? undefined,
      invoiceNumber: b.invoiceNumber ?? undefined, ewayBillNumber: b.ewayBillNumber ?? undefined,
      dispatchDate: b.dispatchDate ? new Date(b.dispatchDate) : (b.dispatchDate === null ? null : undefined),
      deliveryDate: b.deliveryDate ? new Date(b.deliveryDate) : (b.deliveryDate === null ? null : undefined),
      ...(b.customColumns && { customColumns: JSON.stringify(b.customColumns) }),
      ...(b.packingListNo !== undefined && { packingListNo: b.packingListNo }),
    },
    include: { lineItems: { orderBy: { srNo: 'asc' } }, doc: { select: { docNumber: true, type: true, finalAmount: true } }, project: { select: { clientName: true, siteLocation: true, clientPoNumber: true } } },
  });
  res.json({ goodsReceipt: serializeGoodsReceipt(updated) });
}));

// Assign a goods receipt to a site engineer + generate a no-login shareable link.
// The link opens the public GRN form (Phase 2) where the engineer records what
// actually arrived. Emails the link to the engineer (best-effort) and returns it
// so the raiser can also copy-and-share it manually.
router.post('/goods-receipts/:grId/assign', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const { siteEngineerEmail } = z.object({ siteEngineerEmail: z.string().email('Enter a valid email.') }).parse(req.body);
  const gr = await prisma.goodsReceipt.findFirst({ where: { id: req.params.grId, projectId: req.params.projectId }, include: { doc: { select: { docNumber: true } } } });
  if (!gr) throw notFound();
  if (gr.status !== 'DRAFT') throw badRequest('Only a draft goods receipt can be assigned.');
  // Reuse the existing token if already generated, so the link stays stable.
  const token = gr.linkToken || crypto.randomBytes(24).toString('hex');
  await prisma.goodsReceipt.update({ where: { id: gr.id }, data: { siteEngineerEmail, linkToken: token } });
  const link = `${appClientUrl()}/grn/${token}`;
  // Best-effort email — the link is returned regardless so the raiser can copy it.
  if (isEmailEnabled()) {
    try {
      await sendEmail({
        to: siteEngineerEmail,
        subject: `Goods Receipt to fill — ${gr.grnNumber} (against ${gr.doc?.docNumber || 'PO'})`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
          <p>Hi,</p>
          <p>Material has been dispatched against <strong>${gr.doc?.docNumber || 'a PO'}</strong>. Please open the Goods Receipt <strong>${gr.grnNumber}</strong> and record what actually arrived (vehicle, dates, e-way bill, and received quantity per item), then mark it completed.</p>
          <p style="margin:22px 0"><a href="${link}" style="background:#052379;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open Goods Receipt</a></p>
          <p style="font-size:12px;color:#64748b">Or paste this link in your browser:<br>${link}</p>
        </div>`,
      });
    } catch { /* email is best-effort; the link is still returned */ }
  }
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GOODS_RECEIPT_ASSIGN', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber, siteEngineerEmail } });
  res.json({ ok: true, link, siteEngineerEmail, emailed: isEmailEnabled() });
}));

// Confirm the delivery — locks the goods receipt as a RECEIVED record.
router.post('/goods-receipts/:grId/receive', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const gr = await prisma.goodsReceipt.findFirst({ where: { id: req.params.grId, projectId: req.params.projectId } });
  if (!gr) throw notFound();
  if (gr.status !== 'DRAFT') throw badRequest('Already received');
  const updated = await prisma.goodsReceipt.update({ where: { id: gr.id }, data: { status: 'RECEIVED', submittedAt: new Date() } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GOODS_RECEIPT_RECEIVE', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber } });
  res.json({ goodsReceipt: { ...updated, status: updated.status } });
}));

// POST .../goods-receipts/:grId/signed — upload a signed (& stamped) packing-list
// PDF. HARD requirement: PDF only (uploadPdf filters non-PDFs out). Multiple are
// allowed — each call adds one more signed copy.
router.post('/goods-receipts/:grId/signed', requireProjectMember, requireEdit('grn'), uploadPdf.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Please attach a PDF. Only PDF files are accepted for the signed packing list.');
  const gr = await prisma.goodsReceipt.findFirst({ where: { id: req.params.grId, projectId: req.params.projectId } });
  if (!gr) throw notFound();
  const fileUrl = `/uploads/${req.file.filename}`;
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: SIGNED_TYPE, fileName: req.file.originalname, fileUrl, linkedDocNumber: gr.grnNumber, vendorName: gr.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GOODS_RECEIPT_SIGNED_UPLOAD', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber, fileName: req.file.originalname } });
  res.status(201).json({ ok: true, signedDocs: await signedDocsFor(gr.grnNumber) });
}));

// POST .../goods-receipts/:grId/confirm-billing — Crystal's billing confirms the
// material is received (signed copy in hand). Closes the GRN and stops reminders.
router.post('/goods-receipts/:grId/confirm-billing', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const gr = await prisma.goodsReceipt.findFirst({ where: { id: req.params.grId, projectId: req.params.projectId } });
  if (!gr) throw notFound();
  if (gr.status !== 'RECEIVED') throw badRequest('Only a submitted goods receipt can be confirmed.');
  if (gr.billingConfirmedAt) throw badRequest('This goods receipt is already confirmed.');
  const signedCount = await prisma.procurementDocument.count({ where: { type: SIGNED_TYPE, linkedDocNumber: gr.grnNumber, archived: false } });
  if (signedCount === 0) throw badRequest('Upload the signed packing list before confirming.');
  const updated = await prisma.goodsReceipt.update({ where: { id: gr.id }, data: { billingConfirmedAt: new Date(), billingConfirmedById: req.user!.sub } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GOODS_RECEIPT_BILLING_CONFIRM', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber } });
  res.json({ goodsReceipt: { ...serializeGoodsReceipt(updated), signedDocs: await signedDocsFor(gr.grnNumber) } });
}));

// GET .../goods-receipts/:grId/pdf — the "Manifest cum Final Packing List" PDF.
// Ends in /pdf so the signed-link gate in requireAuth also serves it to Sheets.
router.get('/goods-receipts/:grId/pdf', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const gr = await prisma.goodsReceipt.findFirst({
    where: { id: req.params.grId, projectId: req.params.projectId },
    include: { lineItems: { orderBy: { srNo: 'asc' } }, project: { select: { clientName: true, siteLocation: true, clientPoNumber: true } } },
  });
  if (!gr) throw notFound();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="PackingList-${gr.grnNumber}.pdf"`);
  renderPackingListPdf(packingListShape(gr), res);
}));

router.post('/goods-receipts/:grId/photo', requireProjectMember, requireEdit('grn'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const fileUrl = `/uploads/${req.file.filename}`;
  const gr = await prisma.goodsReceipt.update({ where: { id: req.params.grId }, data: { photoUrl: fileUrl } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'PHOTO', fileName: req.file.originalname, fileUrl, linkedDocNumber: gr.grnNumber, vendorName: gr.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  res.status(201).json({ ok: true, photoUrl: gr.photoUrl });
}));

router.delete('/goods-receipts/:grId', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const gr = await prisma.goodsReceipt.findFirst({ where: { id: req.params.grId, projectId: req.params.projectId } });
  if (!gr) throw notFound();
  if (gr.status !== 'DRAFT') throw badRequest('Only a draft goods receipt can be deleted');
  await prisma.goodsReceipt.delete({ where: { id: gr.id } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GOODS_RECEIPT_DELETE', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber } });
  res.json({ ok: true });
}));

// ── Document repository ──────────────────────────────────────────────────────
router.get('/documents', requireProjectMember, requirePage('documents'), asyncHandler(async (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const docs = await prisma.procurementDocument.findMany({ where: { projectId: req.params.projectId, ...(type ? { type } : {}), archived: false }, orderBy: { uploadedAt: 'desc' } });
  res.json({ documents: docs });
}));

router.post('/documents', requireProjectMember, requireEdit('documents'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const b = z.object({ type: z.string().default('OTHER'), linkedDocNumber: z.string().optional(), vendorId: z.string().optional(), vendorName: z.string().optional() }).parse(req.body);
  const document = await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: b.type, fileName: req.file.originalname, fileUrl: `/uploads/${req.file.filename}`, mimeType: req.file.mimetype, linkedDocNumber: b.linkedDocNumber, vendorId: b.vendorId, vendorName: b.vendorName, uploadedById: req.user!.sub } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'DOC_UPLOAD', entity: 'ProcurementDocument', entityId: document.id, details: { type: b.type } });
  res.status(201).json({ document });
}));

// If vendor KYC: allow uploading against a vendor. `kycKind` drives the KYC
// status badge — COMPLETE needs GST certificate + PAN card + cancelled cheque.
router.post('/vendors/:vendorId/kyc', requireProjectMember, requireEdit('vendors'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const { kycKind } = z.object({ kycKind: z.enum(KYC_KINDS).default('OTHER') }).parse(req.body ?? {});
  const vendor = await prisma.vendor.findUnique({ where: { id: req.params.vendorId } });
  if (!vendor) throw notFound('Vendor not found');
  const document = await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'KYC', kycKind, fileName: req.file.originalname, fileUrl: `/uploads/${req.file.filename}`, mimeType: req.file.mimetype, vendorId: req.params.vendorId, vendorName: vendor.name, uploadedById: req.user!.sub } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'VENDOR_KYC_UPLOAD', entity: 'Vendor', entityId: req.params.vendorId, details: { kycKind } });
  // Read the GSTIN / PAN / CIN off the document so the Financial tab fills itself.
  // Never blocks the upload: on any failure `source` is 'none' and the user types
  // the fields as before. The values are only SUGGESTED — the user still saves.
  const extracted = await extractKycFields(req.file.path, req.file.mimetype);
  res.status(201).json({ document, extracted });
}));

// Re-read an already-uploaded KYC document (for files uploaded before this
// existed, or after a failed read). Same suggest-only contract as the upload.
router.post('/vendors/:vendorId/kyc/:docId/extract', requireProjectMember, requireEdit('vendors'), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDocument.findFirst({ where: { id: req.params.docId, vendorId: req.params.vendorId, type: 'KYC' } });
  if (!doc) throw notFound('KYC document not found for this vendor');

  const filename = path.basename(doc.fileUrl);
  let filePath = path.resolve(process.cwd(), 'uploads', filename);
  let temp: string | null = null;
  // A redeploy wipes the disk but not Atlas, so fall back to GridFS and stage the
  // bytes in a temp file — otherwise this would 400 for every older document.
  if (!fs.existsSync(filePath)) {
    const buf = await readFromDb(filename);
    if (!buf) throw badRequest('The file is no longer available — please re-upload it.');
    temp = path.join(os.tmpdir(), `kyc-${Date.now()}-${filename}`);
    fs.writeFileSync(temp, buf);
    filePath = temp;
  }
  try {
    const extracted = await extractKycFields(filePath, doc.mimeType ?? undefined);
    res.json({ extracted });
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
}));

// Remove a KYC document so a wrong/outdated file can be re-uploaded. Scoped to
// this vendor's KYC records only — it can never delete a PO/GRN/invoice.
router.delete('/vendors/:vendorId/kyc/:docId', requireProjectMember, requireEdit('vendors'), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDocument.findFirst({
    where: { id: req.params.docId, vendorId: req.params.vendorId, type: 'KYC' },
  });
  if (!doc) throw notFound('KYC document not found for this vendor');
  await prisma.procurementDocument.delete({ where: { id: doc.id } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'VENDOR_KYC_DELETE', entity: 'Vendor', entityId: req.params.vendorId, details: { kycKind: doc.kycKind, fileName: doc.fileName } });
  res.json({ ok: true });
}));

// ── Payment pipeline dashboard ──────────────────────────────────────────────
router.get('/payment-dashboard', requireProjectMember, requireAnyPage('pay', 'financials'), asyncHandler(async (req, res) => {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, status: 'APPROVED' },
    // PI (proforma) fields ride alongside the tax invoice: payment is made on the
    // PI, so the pipeline must show its number/value and link its PDF (§3/§6).
    include: {
      milestones: { include: { installments: { orderBy: { createdAt: 'asc' } } } },
      grns: { where: { status: 'APPROVED' }, select: { id: true, grnNumber: true, milestoneId: true, milestoneName: true, amountToPay: true, invoiceNumber: true, invoiceValue: true, invoicePdfUrl: true, piNumber: true, piValue: true, piPdfUrl: true } },
      // Physical goods receipts raised against this PO/WO — shown in the pipeline
      // regardless of status or milestone match (a PO can have several).
      goodsReceipts: { orderBy: { createdAt: 'desc' }, select: { id: true, grnNumber: true, status: true, receivedDate: true, vehicleNumber: true, driverName: true, deliveryChallanNumber: true } },
    },
  });
  const rows = docs.map((d) => {
    const invoiced = d.grns.reduce((s, g) => s + (g.invoiceValue ?? 0), 0);
    // Actual rupees paid — cumulative amountPaid (part-payments), legacy PAID rows
    // fall back to inrAmount via the helper.
    const paid = d.milestones.reduce((s, m) => s + milestonePaidAmount(m), 0);
    const advanced = d.milestones.filter((m) => m.fieldKey === 'advance').reduce((s, m) => s + milestonePaidAmount(m), 0);
    const triggered = d.milestones.filter((m) => m.status !== 'PENDING').length;
    const total = d.finalAmount;
    const now = Date.now();
    const delayed = d.milestones.some((m) => m.status === 'PENDING' && m.expectedDate && m.expectedDate.getTime() < now);
    // PO-level payment status — no approval step any more, so it follows the money:
    // TRIGGERED (a term is submitted/awaiting payment, or only partly paid) → PAID
    // (all triggered terms fully settled). Never "Approved".
    const anyOutstanding = d.milestones.some((m) => m.status === 'TRIGGERED' || m.status === 'PARTIALLY_PAID');
    const anyPaid = d.milestones.some((m) => m.status === 'PAID' || m.status === 'PARTIALLY_PAID');
    const payStatusLabel = !d.grns.length ? 'No Payment' : anyOutstanding ? 'Payment Triggered' : anyPaid ? 'Payment Paid' : 'Payment Triggered';
    // How much of each term is already claimed by its payment entries (part-payments
    // A1/A3), so the pipeline can flag what is still pending in red. A claim with no
    // explicit amount pays the whole term.
    const committedByTerm = new Map<string, number>();
    for (const g of d.grns) {
      if (!g.milestoneId) continue;
      const term = d.milestones.find((m) => m.id === g.milestoneId);
      const amt = g.amountToPay != null ? g.amountToPay : (term?.inrAmount ?? 0);
      committedByTerm.set(g.milestoneId, Math.round(((committedByTerm.get(g.milestoneId) ?? 0) + amt) * 100) / 100);
    }
    const termPending = (mid: string | null | undefined, inr: number) => {
      if (!mid) return 0;
      const committed = committedByTerm.get(mid) ?? 0;
      return committed > 0 ? Math.round(Math.max(inr - committed, 0) * 100) / 100 : 0;
    };
    return {
      docId: d.id, type: d.type, docNumber: d.docNumber, vendorName: d.vendorName,
      totalValue: d.basicAmount, gstAmount: d.gstAmount, totalWithGst: total,
      amountInvoiced: invoiced, amountAdvanced: advanced, amountPaid: paid, amountPending: Math.round((total - paid) * 100) / 100,
      progressPct: total > 0 ? Math.round((paid / total) * 1000) / 10 : 0,
      milestonesTriggered: triggered, milestonesTotal: d.milestones.length,
      grnStatus: payStatusLabel, delayed,
      grns: d.grns.map((g) => {
        const term = d.milestones.find((m) => m.id === g.milestoneId);
        return { id: g.id, grnNumber: g.grnNumber, milestoneId: g.milestoneId, milestoneName: g.milestoneName, amountToPay: g.amountToPay, termPending: term ? termPending(g.milestoneId, term.inrAmount) : 0, invoiceNumber: g.invoiceNumber, invoiceValue: g.invoiceValue, invoicePdfUrl: g.invoicePdfUrl, piNumber: g.piNumber, piValue: g.piValue, piPdfUrl: g.piPdfUrl };
      }),
      goodsReceipts: d.goodsReceipts.map((g) => ({ id: g.id, grnNumber: g.grnNumber, status: g.status, receivedDate: g.receivedDate, vehicleNumber: g.vehicleNumber, driverName: g.driverName, deliveryChallanNumber: g.deliveryChallanNumber })),
      milestones: d.milestones.sort((a, b) => a.sortOrder - b.sortOrder).map((m) => ({
        id: m.id, name: m.name, percentage: m.percentage, inrAmount: m.inrAmount, status: m.status,
        // Part-payment tracking (Amisha PRD A1/A3): how much is paid vs still pending.
        amountPaid: milestonePaidAmount(m), remaining: milestoneRemaining(m),
        // Committed by payment entries vs still-open balance (shown in red).
        committed: committedByTerm.get(m.id) ?? 0, pending: termPending(m.id, m.inrAmount),
        triggerCondition: m.triggerCondition, expectedDate: m.expectedDate, actualTriggerDate: m.actualTriggerDate,
        paymentDate: m.paymentDate, paymentReference: m.paymentReference,
        utrNumber: m.utrNumber, paymentProofUrl: m.paymentProofUrl,
        installments: m.installments.map((i) => ({ id: i.id, amount: i.amount, utrNumber: i.utrNumber, paymentReference: i.paymentReference, paymentDate: i.paymentDate, remarks: i.remarks })),
        // A term triggers on submit (so it shows in the pipeline), but Accounts can
        // only pay it once its OWN payment is approved — used to gate "Mark Paid".
        paymentApproved: d.grns.some((g) => g.milestoneId === m.id),
      })),
    };
  });
  const summary = {
    totalPO: rows.filter((r) => r.type === 'PO').reduce((s, r) => s + r.totalWithGst, 0),
    totalWO: rows.filter((r) => r.type === 'WO').reduce((s, r) => s + r.totalWithGst, 0),
    totalInvoiced: rows.reduce((s, r) => s + r.amountInvoiced, 0),
    totalPaid: rows.reduce((s, r) => s + r.amountPaid, 0),
    totalPending: rows.reduce((s, r) => s + r.amountPending, 0),
    delayAlerts: rows.filter((r) => r.delayed).length,
  };

  // Per-vendor payment rollup: last payment date, last UTR, running total paid
  // (Sprint PRD §9.1 "Display in dashboard").
  const byVendor = new Map<string, { vendorName: string; amountPaid: number; lastPaymentDate: Date | null; lastUtr: string | null }>();
  for (const d of docs) {
    const key = d.vendorName || '—';
    const v = byVendor.get(key) ?? { vendorName: key, amountPaid: 0, lastPaymentDate: null, lastUtr: null };
    for (const m of d.milestones) {
      const mp = milestonePaidAmount(m);
      if (mp <= 0) continue;
      v.amountPaid += mp;
      if (m.paymentDate && (!v.lastPaymentDate || m.paymentDate > v.lastPaymentDate)) {
        v.lastPaymentDate = m.paymentDate;
        v.lastUtr = m.utrNumber ?? m.paymentReference ?? null;
      }
    }
    byVendor.set(key, v);
  }
  const vendors = [...byVendor.values()].filter((v) => v.amountPaid > 0).sort((a, b) => b.amountPaid - a.amountPaid);

  res.json(maskFinancials({ rows, summary, vendors }, req.account));
}));

export default router;
