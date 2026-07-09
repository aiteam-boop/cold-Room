import { Router } from 'express';
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
import { deliveryInfo } from '../services/delivery';
import { chainForAmount, validateChain, type MatrixDocType } from '../services/approvalMatrix';
import {
  buildChain, recordDecision, remindCurrent, finalizeApproval, markDocRejected,
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
    overrides: parseJson(d.overrides, {}),
    amendments: parseJson(d.amendments, []),
    paymentTotalPct: paymentTotalPct(d),
    // Derived, never stored (G7). Only when the caller loaded the GRNs.
    ...(Array.isArray(d.grns) ? { delivery: deliveryInfo(d, d.grns) } : {}),
  };
}

// GET .../docs?type=PO|WO
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
  res.json({
    docs: maskFinancials(
      docs.map((d) => ({
        id: d.id, type: d.type, docNumber: d.docNumber, status: d.status, vendorName: d.vendorName,
        docDate: d.docDate, basicAmount: d.basicAmount, finalAmount: d.finalAmount, esignApplied: d.esignApplied,
        counts: d._count,
        delivery: deliveryInfo(d, d.grns), // G7 — promised vs actual, derived
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
      await prisma.procurementLineItem.create({ data: { docId: existing.id, srNo: li.srNo ?? order + 1, description: li.description, uom: li.uom ?? null, qty: li.qty, unitPrice: li.unitPrice, totalPrice: Math.round(total * 100) / 100, isLeadTime: !!li.isLeadTime, leadTimeText: li.leadTimeText ?? null, boqItemId: li.boqItemId ?? null, sortOrder: order++ } });
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

  // Value-threshold matrix (G6). When the matrix governs this doc type it decides
  // the chain: an empty selection is filled in from the document's value, and a
  // hand-picked one must still contain everybody the matrix requires — so a large
  // PO cannot be routed around Finance.
  const matrix = await chainForAmount(doc.type as MatrixDocType, req.params.projectId, doc.finalAmount);
  if (matrix.configured && matrix.steps.length) {
    if (chain.length === 0) {
      chain = matrix.steps.map((s) => s.approverId);
    } else {
      const check = await validateChain(doc.type as MatrixDocType, req.params.projectId, doc.finalAmount, chain);
      if (!check.ok) throw badRequest(check.message, { missing: check.missing, amount: doc.finalAmount });
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

router.post('/docs/:docId/reject', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  if (doc.status !== 'PENDING_APPROVAL') throw badRequest('Document is not pending approval');
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: doc.type, docId: doc.id } });
  if (stepCount > 0) {
    await recordDecision(doc.type as DocType, doc.id, actor, 'REJECT', reason);
    await markDocRejected(doc.type as DocType, doc.id, reason);
  } else {
    if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
    await markDocRejected(doc.type as DocType, doc.id, reason);
    if (doc.createdById) await notifyUser(doc.createdById, { type: 'DOC_REJECTED', title: `${doc.type} rejected`, message: `${doc.docNumber} was rejected: ${reason}`, projectId: req.params.projectId, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${req.params.projectId}` });
  }
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'PROC_DOC_REJECT', entity: 'ProcurementDoc', entityId: doc.id, details: { reason } });
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

// GET .../docs/:docId/pdf — render the PO/WO PDF.
router.get('/docs/:docId/pdf', requireProjectMember, requireAnyPage(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId }, include: { lineItems: { orderBy: { sortOrder: 'asc' } } } });
  if (!doc) throw notFound();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.docNumber}.pdf"`);
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
  res.json({ grns: grns.map((g) => serializeGrn(g, req.account)) });
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
      doc: { select: { docNumber: true, type: true, finalAmount: true } },
    },
  });
  if (!grn) throw notFound();
  const approval = await getChainState('GRN', grn.id);
  res.json({ grn: serializeGrn(grn, req.account), approval });
}));

// Accept null on optional fields — the client sends null (not undefined) for
// empty text inputs and for line-item remarks pulled straight from the DB.
// Numbers are coerced so string-typed inputs ("12324") validate cleanly.
const grnUpdate = z.object({
  vehicleNumber: z.string().nullable().optional(), driverName: z.string().nullable().optional(), deliveryChallanNumber: z.string().nullable().optional(),
  invoiceNumber: z.string().nullable().optional(), invoiceDate: z.string().nullable().optional(), invoiceValue: z.coerce.number().nullable().optional(), ewayBillNumber: z.string().nullable().optional(),
  lineItems: z.array(z.object({ id: z.string(), receiptQty: z.coerce.number().catch(0), defectQty: z.coerce.number().nullable().optional(), remarks: z.string().nullable().optional() })).optional(),
  // Required to amend an APPROVED GRN — the reason for the post-approval change.
  amendmentRemark: z.string().trim().max(2000).optional(),
});
router.patch('/grns/:grnId', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId }, include: { lineItems: true } });
  if (!grn) throw notFound();
  const b = grnUpdate.parse(req.body);

  // An approved GRN may be amended, but only with a reason — logged for everyone.
  const isAmendment = grn.status === 'APPROVED';
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
      ...(amendments !== undefined && { amendments }),
    },
    include: { lineItems: { orderBy: { srNo: 'asc' }, include: { lineItem: { select: { unitPrice: true, totalPrice: true } } } } },
  });
  if (isAmendment) {
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_AMEND', entity: 'GRN', entityId: grn.id, details: { remark: b.amendmentRemark } });
  }
  res.json({ grn: serializeGrn(updated, req.account) });
}));

// Upload GRN invoice PDF (mandatory before submit).
router.post('/grns/:grnId/invoice', requireProjectMember, requireEdit('grn'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const grn = await prisma.gRN.update({ where: { id: req.params.grnId }, data: { invoicePdfUrl: `/uploads/${req.file.filename}` } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'TAX_INVOICE', fileName: req.file.originalname, fileUrl: `/uploads/${req.file.filename}`, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  res.json({ ok: true, invoicePdfUrl: grn.invoicePdfUrl });
}));

// Upload a photo of the received material (optional — Sprint PRD §7.2).
router.post('/grns/:grnId/photo', requireProjectMember, requireEdit('grn'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const fileUrl = `/uploads/${req.file.filename}`;
  const grn = await prisma.gRN.update({ where: { id: req.params.grnId }, data: { photoUrl: fileUrl } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'PHOTO', fileName: req.file.originalname, fileUrl, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  res.status(201).json({ ok: true, photoUrl: grn.photoUrl });
}));

router.post('/grns/:grnId/submit', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (grn.status === 'OPEN') throw badRequest('Already awaiting approval.');
  if (!grn.invoiceNumber || !grn.invoiceDate || grn.invoiceValue == null || !grn.invoicePdfUrl) throw badRequest('Invoice number, date, value and PDF are mandatory before submitting a GRN.');
  const isResubmit = grn.status === 'APPROVED';
  let chain = z.object({ chain: z.array(z.string()).optional() }).parse(req.body ?? {}).chain ?? [];

  // A GRN's value is the invoice it certifies, so the same matrix applies (G6).
  const matrix = await chainForAmount('GRN', req.params.projectId, grn.invoiceValue);
  if (matrix.configured && matrix.steps.length) {
    if (chain.length === 0) chain = matrix.steps.map((s) => s.approverId);
    else {
      const check = await validateChain('GRN', req.params.projectId, grn.invoiceValue, chain);
      if (!check.ok) throw badRequest(check.message, { missing: check.missing, amount: grn.invoiceValue });
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
    await notifyProjectRoles(req.params.projectId, ['ADMIN', 'SUPERVISOR'], { type: 'GRN_SUBMITTED', title: 'GRN awaiting approval', message: `${grn.grnNumber} (${grn.vendorName || 'vendor'}), invoice ${rs(grn.invoiceValue ?? 0)} — review needed.`, relatedDocType: 'GRN', relatedDocId: grn.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
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
    if (outcome === 'COMPLETED') await finalizeApproval('GRN', grn.id, actor.id);
    await audit({ userId: actor.id, projectId: req.params.projectId, action: 'GRN_APPROVE', entity: 'GRN', entityId: grn.id, details: { outcome } });
    return res.json({ ok: true, outcome });
  }
  if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
  await finalizeApproval('GRN', grn.id, actor.id);
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'GRN_APPROVE', entity: 'GRN', entityId: grn.id, details: { legacy: true } });
  res.json({ ok: true, outcome: 'COMPLETED' });
}));

router.post('/grns/:grnId/reject', asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: 'GRN', docId: grn.id } });
  if (stepCount > 0) {
    await recordDecision('GRN', grn.id, actor, 'REJECT', reason);
    await markDocRejected('GRN', grn.id, reason);
  } else {
    if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
    await markDocRejected('GRN', grn.id, reason);
  }
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'GRN_REJECT', entity: 'GRN', entityId: grn.id, details: { reason } });
  res.json({ ok: true });
}));

router.post('/grns/:grnId/remind', requireProjectMember, asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  const actor = await resolveActor(req.account!.id);
  await remindCurrent('GRN', grn.id, actor);
  res.json({ ok: true });
}));

// The GRN PDF carries no PO pricing — only the vendor invoice data the raiser
// entered — so it is NOT behind requireFinancialView: the site engineer who
// raised it must be able to open their own document (Sprint PRD §7.3).
router.get('/grns/:grnId/pdf', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId }, include: { lineItems: { orderBy: { srNo: 'asc' } }, doc: { select: { docNumber: true } } } });
  if (!grn) throw notFound();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${grn.grnNumber}.pdf"`);
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
  res.status(201).json({ document });
}));

// ── Payment pipeline dashboard ──────────────────────────────────────────────
router.get('/payment-dashboard', requireProjectMember, requireAnyPage('pay', 'financials'), asyncHandler(async (req, res) => {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, status: 'APPROVED' },
    include: { milestones: true, grns: { where: { status: 'APPROVED' }, select: { id: true, grnNumber: true, invoiceNumber: true, invoiceValue: true, invoicePdfUrl: true } } },
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
      grns: d.grns.map((g) => ({ id: g.id, grnNumber: g.grnNumber, invoiceNumber: g.invoiceNumber, invoiceValue: g.invoiceValue, invoicePdfUrl: g.invoicePdfUrl })),
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
