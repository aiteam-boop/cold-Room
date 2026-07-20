import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import {
  requireAuth, requireProjectMember,
  requirePage, requireEdit, requireAnyPage, requireAnyEdit, requireSection, requireFinancialView,
} from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { extractPiFields } from '../services/piExtract';
import { scheduleSheetSync } from '../services/sheetsSync';
import {
  COMPANY, nextDocNumber, computeTotals, paymentTotalPct,
  defaultPOSections, defaultWOSections,
  normalizeTermsSections, assertTermsMutationsAllowed,
} from '../services/procurement';
import { renderProcurementPdf, renderGRNPdf } from '../services/procurementPdf';
import { notifyUser, notifyProjectRoles } from '../services/notify';
import { hasSection, shouldHideFinancials } from '../lib/permissions';
import { KYC_KINDS, VENDOR_TYPES, BOQ_CATEGORIES } from '../lib/enums';
import { kycStatus, normalizeRateChart, rateFor } from '../services/vendorProfile';
import { extractKycFields } from '../services/kycExtract';
import { readFromDb } from '../lib/fileStore';
import { deliveryInfo } from '../services/delivery';
import { chainForAmount, validateChain, type MatrixDocType } from '../services/approvalMatrix';
import { resolveAutoChain } from '../services/fixedChain';
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
  res.json({
    docs: maskFinancials(
      docs.map((d) => ({
        id: d.id, type: d.type, docNumber: d.docNumber, status: d.status, vendorName: d.vendorName,
        docDate: d.docDate, basicAmount: d.basicAmount, finalAmount: d.finalAmount, esignApplied: d.esignApplied,
        counts: d._count,
        delivery: deliveryInfo(d, d.grns), // G7 — promised vs actual, derived
        createdBy: (d.createdById && creators.get(d.createdById)) || null,
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

const lineSchema = z.object({
  id: z.string().optional(), srNo: z.coerce.number().optional(), description: z.string().default(''),
  uom: z.string().optional().nullable(), qty: z.coerce.number().catch(0).default(0),
  unitPrice: z.coerce.number().catch(0).default(0), totalPrice: z.coerce.number().optional(),
  isLeadTime: z.boolean().optional(), leadTimeText: z.string().optional().nullable(),
  customValues: z.any().optional(), // { [colKey]: value } for user-added columns
  // Links this PO line back to the BOQ item it fulfils — the join that powers
  // the BOQ Cost view (Sprint PRD §6.3). Optional but strongly recommended.
  boqItemId: z.string().nullable().optional(),
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
      await prisma.procurementLineItem.create({ data: { docId: existing.id, srNo: li.srNo ?? order + 1, description: li.description, uom: li.uom ?? null, qty: li.qty, unitPrice: li.unitPrice, totalPrice: Math.round(total * 100) / 100, isLeadTime: !!li.isLeadTime, leadTimeText: li.leadTimeText ?? null, customValues: li.customValues != null ? JSON.stringify(li.customValues) : null, boqItemId: li.boqItemId ?? null, sortOrder: order++ } });
    }
    totals = computeTotals(b.lineItems.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, totalPrice: l.totalPrice, isLeadTime: l.isLeadTime })), b.gstEnabled ?? existing.gstEnabled, b.gstPct ?? existing.gstPct, { basicAmount: b.basicAmount, gstAmount: b.gstAmount, finalAmount: b.finalAmount });
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

  // 1) FIXED chain (admin-configured in Users → Approval Chain) wins. When one
  //    exists the document routes through it automatically — the creator never
  //    picks approvers. Any value-mandated approver missing from it is appended
  //    by resolveAutoChain, so Finance still can't be bypassed.
  const auto = await resolveAutoChain(doc.type as MatrixDocType, req.params.projectId, doc.finalAmount);
  if (auto.source === 'fixed') {
    chain = auto.approverIds;
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
    await buildChain(doc.type as DocType, doc.id, req.params.projectId, chain, actor);
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
  if (doc.status !== 'DRAFT') throw forbidden('Only a draft can be deleted. Submitted or approved documents cannot be removed.');
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
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdfFileName(doc.docNumber, doc.vendorName, doc.project?.name)}"`);
  renderProcurementPdf({ ...doc, termsSections: normalizeTermsSections(parseJson(doc.termsSections, [])) } as any, res);
}));

// ── Payment milestones ──────────────────────────────────────────────────────
router.post('/docs/:docId/milestones/:mid/trigger', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const { date } = z.object({ date: z.string().optional() }).parse(req.body ?? {});
  const m = await prisma.paymentMilestone.findFirst({ where: { id: req.params.mid, docId: req.params.docId } });
  if (!m) throw notFound('Milestone not found');
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
    paymentDate: z.string().optional(),
    paymentReference: z.string().optional(),
    utrNumber: z.string().trim().min(1, 'UTR number is required.'),
    remarks: z.string().optional(),
  }).parse(req.body ?? {});
  const m = await prisma.paymentMilestone.findFirst({ where: { id: req.params.mid, docId: req.params.docId } });
  if (!m) throw notFound();

  // Cap payments at the actual invoiced amount: you cannot pay a vendor more than
  // the total value of their APPROVED GRN invoices for this PO/WO.
  if (m.status !== 'PAID') {
    const [grns, alreadyPaid] = await Promise.all([
      prisma.gRN.findMany({ where: { docId: req.params.docId, status: 'APPROVED' }, select: { invoiceValue: true } }),
      prisma.paymentMilestone.findMany({ where: { docId: req.params.docId, status: 'PAID' }, select: { inrAmount: true } }),
    ]);
    const invoiced = grns.reduce((s, g) => s + (g.invoiceValue ?? 0), 0);
    const paidSoFar = alreadyPaid.reduce((s, x) => s + x.inrAmount, 0);
    if (invoiced <= 0) throw badRequest('No approved GRN invoice yet — approve a GRN before marking payments paid.');
    if (Math.round((paidSoFar + m.inrAmount) * 100) / 100 > Math.round(invoiced * 100) / 100) {
      throw badRequest(`This payment (${rs(m.inrAmount)}) would exceed the invoiced amount. Invoiced ${rs(invoiced)}, already paid ${rs(paidSoFar)}, remaining payable ${rs(Math.max(invoiced - paidSoFar, 0))}.`);
    }
  }

  const updated = await prisma.paymentMilestone.update({
    where: { id: m.id },
    data: {
      status: 'PAID',
      paymentDate: b.paymentDate ? new Date(b.paymentDate) : new Date(),
      utrNumber: b.utrNumber,
      // Keep the legacy free-text reference populated (older rows and the sheets
      // export read it); default it to the UTR when nothing else was given.
      paymentReference: b.paymentReference || b.utrNumber,
      remarks: b.remarks,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'MILESTONE_PAY', entity: 'PaymentMilestone', entityId: m.id, details: { utrNumber: b.utrNumber, paymentDate: updated.paymentDate } });
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
    select: { id: true, name: true, fieldKey: true, percentage: true, inrAmount: true, status: true },
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

// Accounts recorded the UTR: mark the linked milestone PAID with the reference.
async function payGrnMilestone(grn: { milestoneId: string | null }, utr: string | null, paidAt: Date) {
  if (!grn.milestoneId) return;
  const m = await prisma.paymentMilestone.findUnique({ where: { id: grn.milestoneId } });
  if (m && m.status !== 'PAID') {
    await prisma.paymentMilestone.update({ where: { id: m.id }, data: { status: 'PAID', paymentDate: paidAt, utrNumber: utr, paymentReference: utr } });
  }
}

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
  res.json({
    grns: grns.map((g) => ({
      ...serializeGrn(g, req.account),
      createdBy: (g.raisedById && creators.get(g.raisedById)) || null,
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

  const grnNumber = await nextDocNumber('GRN');
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
  // The vendor's KYC already lives on the vendor master, so the payment section
  // shows it rather than asking for it again — read-only, never re-uploaded here.
  const kycDocs = await vendorKycDocs(grn.doc?.vendorId ?? null);
  res.json({ grn: serializeGrn(grn, req.account), approval, milestones, advanceOnPo, kycDocs });
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
  const isResubmit = grn.status === 'APPROVED';
  let chain = z.object({ chain: z.array(z.string()).optional() }).parse(req.body ?? {}).chain ?? [];

  // The value that drives the approval matrix (G6): the amount being paid for a
  // payment GRN, else the tax-invoice value it certifies.
  const chainAmount = grn.milestoneId ? (grn.amountToPay ?? grn.piValue ?? 0) : (grn.invoiceValue ?? 0);
  // Fixed admin chain wins (auto-routed, no popup); otherwise legacy matrix flow.
  const autoGrn = await resolveAutoChain('GRN', req.params.projectId, chainAmount);
  if (autoGrn.source === 'fixed') {
    chain = autoGrn.approverIds;
  } else {
    const matrix = await chainForAmount('GRN', req.params.projectId, chainAmount);
    if (matrix.configured && matrix.steps.length) {
      if (chain.length === 0) chain = matrix.steps.map((s) => s.approverId);
      else {
        const check = await validateChain('GRN', req.params.projectId, chainAmount, chain);
        if (!check.ok) throw badRequest(check.message, { missing: check.missing, amount: chainAmount });
      }
    }
  }

  const updated = await prisma.gRN.update({
    where: { id: grn.id },
    data: { status: 'OPEN', ...(isResubmit && { approvedById: null, approvedAt: null }) },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: isResubmit ? 'GRN_RESUBMIT' : 'GRN_SUBMIT', entity: 'GRN', entityId: grn.id, details: { chainLength: chain.length, resubmit: isResubmit } });
  if (chain.length) {
    const actor = await resolveActor(req.account!.id);
    await buildChain('GRN', grn.id, req.params.projectId, chain, actor);
  } else {
    await notifyProjectRoles(req.params.projectId, ['ADMIN', 'SUPERVISOR'], { type: 'GRN_SUBMITTED', title: 'GRN awaiting approval', message: `${grn.grnNumber} (${grn.vendorName || 'vendor'}), ${rs(chainAmount)} — review needed.`, relatedDocType: 'GRN', relatedDocId: grn.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  }
  res.json({ grn: updated });
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
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdfFileName(grn.grnNumber, grn.vendorName, grn.project?.name)}"`);
  renderGRNPdf({ ...grn, docNumber: grn.doc.docNumber } as any, res);
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
    include: { milestones: true, grns: { where: { status: 'APPROVED' }, select: { id: true, grnNumber: true, invoiceNumber: true, invoiceValue: true, invoicePdfUrl: true, piNumber: true, piValue: true, piPdfUrl: true } } },
  });
  const rows = docs.map((d) => {
    const invoiced = d.grns.reduce((s, g) => s + (g.invoiceValue ?? 0), 0);
    const paid = d.milestones.filter((m) => m.status === 'PAID').reduce((s, m) => s + m.inrAmount, 0);
    const advanced = d.milestones.filter((m) => m.fieldKey === 'advance' && m.status === 'PAID').reduce((s, m) => s + m.inrAmount, 0);
    const triggered = d.milestones.filter((m) => m.status !== 'PENDING').length;
    const total = d.finalAmount;
    const now = Date.now();
    const delayed = d.milestones.some((m) => m.status === 'PENDING' && m.expectedDate && m.expectedDate.getTime() < now);
    return {
      docId: d.id, type: d.type, docNumber: d.docNumber, vendorName: d.vendorName,
      totalValue: d.basicAmount, gstAmount: d.gstAmount, totalWithGst: total,
      amountInvoiced: invoiced, amountAdvanced: advanced, amountPaid: paid, amountPending: Math.round((total - paid) * 100) / 100,
      progressPct: total > 0 ? Math.round((paid / total) * 1000) / 10 : 0,
      milestonesTriggered: triggered, milestonesTotal: d.milestones.length,
      grnStatus: d.grns.length ? 'GRN Approved' : 'No GRN', delayed,
      grns: d.grns.map((g) => ({ id: g.id, grnNumber: g.grnNumber, invoiceNumber: g.invoiceNumber, invoiceValue: g.invoiceValue, invoicePdfUrl: g.invoicePdfUrl, piNumber: g.piNumber, piValue: g.piValue, piPdfUrl: g.piPdfUrl })),
      milestones: d.milestones.sort((a, b) => a.sortOrder - b.sortOrder).map((m) => ({
        id: m.id, name: m.name, percentage: m.percentage, inrAmount: m.inrAmount, status: m.status,
        triggerCondition: m.triggerCondition, expectedDate: m.expectedDate, actualTriggerDate: m.actualTriggerDate,
        paymentDate: m.paymentDate, paymentReference: m.paymentReference,
        utrNumber: m.utrNumber, paymentProofUrl: m.paymentProofUrl,
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
      if (m.status !== 'PAID') continue;
      v.amountPaid += m.inrAmount;
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
