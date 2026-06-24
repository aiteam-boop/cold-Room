import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import {
  requireAuth, requireProjectMember,
  requirePage, requireEdit, requireAnyPage, requireAnyEdit, requireSection, requireFinancialView,
} from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import {
  COMPANY, nextDocNumber, computeTotals, buildMilestones, paymentTotalPct,
  defaultPOTerms, defaultWOTerms,
} from '../services/procurement';
import { renderProcurementPdf, renderGRNPdf } from '../services/procurementPdf';
import { notifyUser, notifyProjectRoles } from '../services/notify';

const rs = (n: number) => 'Rs. ' + (n || 0).toLocaleString('en-IN');

const router = Router({ mergeParams: true });
router.use(requireAuth);

// Pages that share the procurement docs endpoints (Payment Pipeline / PO / WO).
const DOC_PAGES = ['pay', 'po', 'wo'] as const;
function kyc(count: number) { return count >= 4 ? 'Complete' : count >= 1 ? 'Partial' : 'Missing'; }

// ── Project-scoped vendor search (site-filtered) ────────────────────────────
router.get('/vendors', requireProjectMember, requirePage('vendors'), asyncHandler(async (req, res) => {
  const vendors = await prisma.vendor.findMany({
    where: { siteMappings: { some: { projectId: req.params.projectId } } },
    orderBy: { name: 'asc' },
    include: { _count: { select: { kycDocs: true } } },
  });
  res.json({ vendors: vendors.map((v) => ({ id: v.id, name: v.name, type: v.type, address: v.address, gstin: v.gstin, contactPerson: v.contactPerson, phones: v.phones, email: v.email, kycStatus: kyc(v._count.kycDocs) })) });
}));

// Inline create vendor + map to this project (FR-MC-27).
router.post('/vendors', requireProjectMember, requireEdit('vendors'), asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().min(1), type: z.enum(['VENDOR', 'CONTRACTOR']).default('VENDOR'), contactPerson: z.string().optional(), phones: z.string().optional(), address: z.string().optional(), email: z.string().optional(), gstin: z.string().optional(), pan: z.string().optional(), bankAccount: z.string().optional(), ifsc: z.string().optional() }).parse(req.body);
  const vendor = await prisma.vendor.create({ data: { ...b, createdById: req.user!.sub, siteMappings: { create: { projectId: req.params.projectId } } } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'VENDOR_CREATE_INLINE', entity: 'Vendor', entityId: vendor.id });
  res.status(201).json({ vendor });
}));

// ── PO / WO documents ───────────────────────────────────────────────────────

function serializeDoc(d: any) {
  return {
    ...d,
    termsSections: d.termsSections ? JSON.parse(d.termsSections) : [],
    payTriggers: d.payTriggers ? JSON.parse(d.payTriggers) : {},
    overrides: d.overrides ? JSON.parse(d.overrides) : {},
    paymentTotalPct: paymentTotalPct(d),
  };
}

// GET .../docs?type=PO|WO
router.get('/docs', requireProjectMember, requireAnyPage(...DOC_PAGES), asyncHandler(async (req, res) => {
  const type = req.query.type === 'WO' ? 'WO' : req.query.type === 'PO' ? 'PO' : undefined;
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, ...(type ? { type } : {}) },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { lineItems: true, grns: true, milestones: true } } },
  });
  res.json({ docs: maskFinancials(docs.map((d) => ({ id: d.id, type: d.type, docNumber: d.docNumber, status: d.status, vendorName: d.vendorName, docDate: d.docDate, basicAmount: d.basicAmount, finalAmount: d.finalAmount, esignApplied: d.esignApplied, counts: d._count })), req.account) });
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
      termsSections: JSON.stringify(b.type === 'PO' ? defaultPOTerms() : defaultWOTerms()),
      createdById: req.user!.sub,
      lineItems: { create: { srNo: 1, description: '', qty: 0, unitPrice: 0, totalPrice: 0, sortOrder: 0 } },
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_CREATE', entity: 'ProcurementDoc', entityId: doc.id, details: { type: b.type, docNumber } });
  res.status(201).json({ doc: serializeDoc(doc) });
}));

// GET .../docs/:docId — full document.
router.get('/docs/:docId', requireProjectMember, requireAnyPage(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({
    where: { id: req.params.docId, projectId: req.params.projectId },
    include: { lineItems: { orderBy: { sortOrder: 'asc' } }, milestones: { orderBy: { sortOrder: 'asc' } }, grns: { select: { id: true, grnNumber: true, status: true, invoiceValue: true } } },
  });
  if (!doc) throw notFound('Document not found');
  res.json({ doc: maskFinancials(serializeDoc(doc), req.account) });
}));

const lineSchema = z.object({ id: z.string().optional(), srNo: z.coerce.number().optional(), description: z.string().default(''), uom: z.string().optional().nullable(), qty: z.coerce.number().catch(0).default(0), unitPrice: z.coerce.number().catch(0).default(0), totalPrice: z.coerce.number().optional(), isLeadTime: z.boolean().optional(), leadTimeText: z.string().optional().nullable() });
// Accept null on optional string fields — the client sends null for the
// address field that doesn't apply (siteAddress on a PO, shipTo on a WO).
const nstr = z.string().nullable().optional();
// Coerce numeric fields so values typed as strings ("25") validate cleanly.
const num = z.coerce.number().optional();
const updateSchema = z.object({
  vendorId: z.string().nullable().optional(),
  vendorName: nstr, vendorAddress: nstr, vendorGstin: nstr, vendorContact: nstr, vendorPhone: nstr,
  againstQuotation: nstr, invoiceTo: nstr, shipTo: nstr, siteAddress: nstr,
  gstEnabled: z.boolean().optional(), gstPct: num,
  basicAmount: num, gstAmount: num, finalAmount: num,
  payAdvancePct: num, payBeforeDeliveryPct: num, payRunningPct: num,
  payPostDeliveryPct: num, payPostCompletionPct: num, payRetentionPct: num,
  payTriggers: z.any().optional(), termsSections: z.array(z.object({ title: z.string(), text: z.string().default('') })).optional(),
  overrides: z.any().optional(),
  lineItems: z.array(lineSchema).optional(),
});

// PATCH .../docs/:docId — edit any field (manual override everywhere).
router.patch('/docs/:docId', requireProjectMember, requireAnyEdit(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const existing = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!existing) throw notFound('Document not found');
  if (existing.status === 'APPROVED') throw forbidden('Approved documents are locked.');
  const b = updateSchema.parse(req.body);

  // Replace line items if provided + recompute totals.
  let totals = { basicAmount: existing.basicAmount, gstAmount: existing.gstAmount, finalAmount: existing.finalAmount };
  if (b.lineItems) {
    await prisma.procurementLineItem.deleteMany({ where: { docId: existing.id } });
    let order = 0;
    for (const li of b.lineItems) {
      const total = li.isLeadTime ? 0 : (li.totalPrice ?? li.qty * li.unitPrice);
      await prisma.procurementLineItem.create({ data: { docId: existing.id, srNo: li.srNo ?? order + 1, description: li.description, uom: li.uom ?? null, qty: li.qty, unitPrice: li.unitPrice, totalPrice: Math.round(total * 100) / 100, isLeadTime: !!li.isLeadTime, leadTimeText: li.leadTimeText ?? null, sortOrder: order++ } });
    }
    totals = computeTotals(b.lineItems.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, totalPrice: l.totalPrice, isLeadTime: l.isLeadTime })), b.gstEnabled ?? existing.gstEnabled, b.gstPct ?? existing.gstPct, { basicAmount: b.basicAmount, gstAmount: b.gstAmount, finalAmount: b.finalAmount });
  } else if (b.basicAmount != null || b.gstAmount != null || b.finalAmount != null || b.gstPct != null || b.gstEnabled != null) {
    const lines = await prisma.procurementLineItem.findMany({ where: { docId: existing.id } });
    totals = computeTotals(lines, b.gstEnabled ?? existing.gstEnabled, b.gstPct ?? existing.gstPct, { basicAmount: b.basicAmount, gstAmount: b.gstAmount, finalAmount: b.finalAmount });
  }

  const doc = await prisma.procurementDoc.update({
    where: { id: existing.id },
    data: {
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
      ...(b.termsSections !== undefined && { termsSections: JSON.stringify(b.termsSections) }),
      ...(b.overrides !== undefined && { overrides: JSON.stringify(b.overrides) }),
    },
    include: { lineItems: { orderBy: { sortOrder: 'asc' } }, milestones: { orderBy: { sortOrder: 'asc' } } },
  });
  res.json({ doc: serializeDoc(doc) });
}));

// POST .../docs/:docId/submit — submit for approval (validates 100% payment).
router.post('/docs/:docId/submit', requireProjectMember, requireAnyEdit(...DOC_PAGES), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound('Document not found');
  if (doc.status === 'APPROVED') throw badRequest('Already approved');
  const total = paymentTotalPct(doc);
  if (Math.abs(total - 100) > 0.01) throw badRequest(`Payment terms must total 100% (currently ${total}%).`);
  const updated = await prisma.procurementDoc.update({ where: { id: doc.id }, data: { status: 'PENDING_APPROVAL' } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_SUBMIT', entity: 'ProcurementDoc', entityId: doc.id });
  await notifyProjectRoles(req.params.projectId, ['ADMIN'], { type: 'DOC_SUBMITTED', title: `${doc.type} pending approval`, message: `${doc.docNumber} (${doc.vendorName || 'vendor'}) for ${rs(doc.finalAmount)} needs approval.`, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
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

// POST .../docs/:docId/approve — AA sir approves: e-sign, lock, milestones, PDF.
router.post('/docs/:docId/approve', requireProjectMember, requireSection('canApprove'), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  if (doc.status !== 'PENDING_APPROVAL') throw badRequest('Document is not pending approval');

  const milestones = buildMilestones(doc);
  await prisma.$transaction([
    prisma.paymentMilestone.deleteMany({ where: { docId: doc.id } }),
    prisma.paymentMilestone.createMany({ data: milestones.map((m) => ({ ...m, docId: doc.id })) }),
    prisma.procurementDoc.update({ where: { id: doc.id }, data: { status: 'APPROVED', esignApplied: true, approvedById: req.user!.sub, approvedAt: new Date(), lockedAt: new Date() } }),
  ]);
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_APPROVE', entity: 'ProcurementDoc', entityId: doc.id, details: { milestones: milestones.length } });

  // Register the generated PDF in the repository.
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: doc.type, fileName: `${doc.docNumber}.pdf`, fileUrl: `/api/projects/${req.params.projectId}/procurement/docs/${doc.id}/pdf`, linkedDocNumber: doc.docNumber, vendorId: doc.vendorId, vendorName: doc.vendorName, uploadedById: req.user!.sub } });
  if (doc.createdById) await notifyUser(doc.createdById, { type: 'DOC_APPROVED', title: `${doc.type} approved`, message: `${doc.docNumber} has been approved and e-signed.`, projectId: req.params.projectId, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${req.params.projectId}` });
  await notifyProjectRoles(req.params.projectId, ['MANAGEMENT'], { type: 'DOC_APPROVED', title: `${doc.type} approved — payment pipeline active`, message: `${doc.docNumber} (${doc.vendorName || 'vendor'}) approved. ${milestones.length} payment milestone(s) ready.`, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  res.json({ ok: true });
}));

router.post('/docs/:docId/reject', requireProjectMember, requireSection('canApprove'), asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId } });
  if (!doc) throw notFound();
  if (doc.status !== 'PENDING_APPROVAL') throw badRequest('Document is not pending approval');
  await prisma.procurementDoc.update({ where: { id: doc.id }, data: { status: 'DRAFT', rejectionReason: reason } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'PROC_DOC_REJECT', entity: 'ProcurementDoc', entityId: doc.id, details: { reason } });
  if (doc.createdById) await notifyUser(doc.createdById, { type: 'DOC_REJECTED', title: `${doc.type} rejected`, message: `${doc.docNumber} was rejected: ${reason}`, projectId: req.params.projectId, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${req.params.projectId}` });
  res.json({ ok: true });
}));

// GET .../docs/:docId/pdf — render the PO/WO PDF.
router.get('/docs/:docId/pdf', requireProjectMember, requireAnyPage(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({ where: { id: req.params.docId, projectId: req.params.projectId }, include: { lineItems: { orderBy: { sortOrder: 'asc' } } } });
  if (!doc) throw notFound();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${doc.docNumber}.pdf"`);
  renderProcurementPdf({ ...doc, termsSections: doc.termsSections ? JSON.parse(doc.termsSections) : [] } as any, res);
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

router.post('/docs/:docId/milestones/:mid/pay', requireProjectMember, requireSection('canMarkPaid'), asyncHandler(async (req, res) => {
  const b = z.object({ paymentDate: z.string().optional(), paymentReference: z.string().optional(), remarks: z.string().optional() }).parse(req.body ?? {});
  const m = await prisma.paymentMilestone.findFirst({ where: { id: req.params.mid, docId: req.params.docId } });
  if (!m) throw notFound();
  const updated = await prisma.paymentMilestone.update({ where: { id: m.id }, data: { status: 'PAID', paymentDate: b.paymentDate ? new Date(b.paymentDate) : new Date(), paymentReference: b.paymentReference, remarks: b.remarks } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'MILESTONE_PAY', entity: 'PaymentMilestone', entityId: m.id });
  res.json({ milestone: maskFinancials(updated, req.account) });
}));

// PATCH a milestone (manual override of name/amount/date).
router.patch('/docs/:docId/milestones/:mid', requireProjectMember, requireAnyEdit(...DOC_PAGES), requireFinancialView, asyncHandler(async (req, res) => {
  const b = z.object({ name: z.string().optional(), triggerCondition: z.string().optional(), inrAmount: z.number().optional(), expectedDate: z.string().nullable().optional() }).parse(req.body);
  const updated = await prisma.paymentMilestone.update({ where: { id: req.params.mid }, data: { ...(b.name !== undefined && { name: b.name }), ...(b.triggerCondition !== undefined && { triggerCondition: b.triggerCondition }), ...(b.inrAmount !== undefined && { inrAmount: b.inrAmount }), ...(b.expectedDate !== undefined && { expectedDate: b.expectedDate ? new Date(b.expectedDate) : null }) } });
  res.json({ milestone: updated });
}));

// ── GRN ─────────────────────────────────────────────────────────────────────
router.get('/grns', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const grns = await prisma.gRN.findMany({ where: { projectId: req.params.projectId }, orderBy: { createdAt: 'desc' }, include: { doc: { select: { docNumber: true, type: true } } } });
  res.json({ grns: maskFinancials(grns, req.account) });
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
    include: { lineItems: { orderBy: { srNo: 'asc' } } },
  });
  res.status(201).json({ grn });
}));

router.get('/grns/:grnId', requireProjectMember, requirePage('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId }, include: { lineItems: { orderBy: { srNo: 'asc' } }, doc: { select: { docNumber: true, type: true } } } });
  if (!grn) throw notFound();
  res.json({ grn: maskFinancials(grn, req.account) });
}));

const grnUpdate = z.object({
  vehicleNumber: z.string().optional(), driverName: z.string().optional(), deliveryChallanNumber: z.string().optional(),
  invoiceNumber: z.string().optional(), invoiceDate: z.string().optional(), invoiceValue: z.number().optional(), ewayBillNumber: z.string().optional(),
  lineItems: z.array(z.object({ id: z.string(), receiptQty: z.number(), defectQty: z.number().optional(), remarks: z.string().optional() })).optional(),
});
router.patch('/grns/:grnId', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId }, include: { lineItems: true } });
  if (!grn) throw notFound();
  if (grn.status === 'APPROVED') throw forbidden('GRN locked after approval');
  const b = grnUpdate.parse(req.body);
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
    },
    include: { lineItems: { orderBy: { srNo: 'asc' } } },
  });
  res.json({ grn: maskFinancials(updated, req.account) });
}));

// Upload GRN invoice PDF (mandatory before submit).
router.post('/grns/:grnId/invoice', requireProjectMember, requireEdit('grn'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const grn = await prisma.gRN.update({ where: { id: req.params.grnId }, data: { invoicePdfUrl: `/uploads/${req.file.filename}` } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'TAX_INVOICE', fileName: req.file.originalname, fileUrl: `/uploads/${req.file.filename}`, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  res.json({ ok: true, invoicePdfUrl: grn.invoicePdfUrl });
}));

router.post('/grns/:grnId/submit', requireProjectMember, requireEdit('grn'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (!grn.invoiceNumber || !grn.invoiceDate || grn.invoiceValue == null || !grn.invoicePdfUrl) throw badRequest('Invoice number, date, value and PDF are mandatory before submitting a GRN.');
  const updated = await prisma.gRN.update({ where: { id: grn.id }, data: { status: 'OPEN' } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_SUBMIT', entity: 'GRN', entityId: grn.id });
  await notifyProjectRoles(req.params.projectId, ['ADMIN', 'SUPERVISOR'], { type: 'GRN_SUBMITTED', title: 'GRN awaiting approval', message: `${grn.grnNumber} (${grn.vendorName || 'vendor'}), invoice ${rs(grn.invoiceValue ?? 0)} — review needed.`, relatedDocType: 'GRN', relatedDocId: grn.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  res.json({ grn: updated });
}));

router.post('/grns/:grnId/approve', requireProjectMember, requireSection('canApprove'), asyncHandler(async (req, res) => {
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  if (grn.status !== 'OPEN') throw badRequest('GRN is not open for approval');
  await prisma.gRN.update({ where: { id: grn.id }, data: { status: 'APPROVED', approvedById: req.user!.sub, approvedAt: new Date() } });
  await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'GRN', fileName: `${grn.grnNumber}.pdf`, fileUrl: `/api/projects/${req.params.projectId}/procurement/grns/${grn.id}/pdf`, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, uploadedById: req.user!.sub } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GRN_APPROVE', entity: 'GRN', entityId: grn.id });
  if (grn.raisedById) await notifyUser(grn.raisedById, { type: 'GRN_APPROVED', title: 'GRN approved', message: `${grn.grnNumber} has been approved.`, projectId: req.params.projectId, relatedDocType: 'GRN', relatedDocId: grn.id, link: `/projects/${req.params.projectId}` });
  await notifyProjectRoles(req.params.projectId, ['MANAGEMENT'], { type: 'GRN_APPROVED', title: 'GRN approved — invoice received', message: `${grn.grnNumber} approved. Invoice ${rs(grn.invoiceValue ?? 0)} added to payment pipeline.`, relatedDocType: 'GRN', relatedDocId: grn.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  res.json({ ok: true });
}));

router.post('/grns/:grnId/reject', requireProjectMember, requireSection('canApprove'), asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
  const grn = await prisma.gRN.findFirst({ where: { id: req.params.grnId, projectId: req.params.projectId } });
  if (!grn) throw notFound();
  await prisma.gRN.update({ where: { id: grn.id }, data: { status: 'REJECTED', rejectionReason: reason } });
  res.json({ ok: true });
}));

router.get('/grns/:grnId/pdf', requireProjectMember, requirePage('grn'), requireFinancialView, asyncHandler(async (req, res) => {
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

// If vendor KYC: allow uploading against a vendor.
router.post('/vendors/:vendorId/kyc', requireProjectMember, requireEdit('vendors'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const vendor = await prisma.vendor.findUnique({ where: { id: req.params.vendorId } });
  const document = await prisma.procurementDocument.create({ data: { projectId: req.params.projectId, type: 'KYC', fileName: req.file.originalname, fileUrl: `/uploads/${req.file.filename}`, mimeType: req.file.mimetype, vendorId: req.params.vendorId, vendorName: vendor?.name, uploadedById: req.user!.sub } });
  res.status(201).json({ document });
}));

// ── Payment pipeline dashboard ──────────────────────────────────────────────
router.get('/payment-dashboard', requireProjectMember, requireAnyPage('pay', 'financials'), asyncHandler(async (req, res) => {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, status: 'APPROVED' },
    include: { milestones: true, grns: { where: { status: 'APPROVED' }, select: { invoiceValue: true } } },
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
      milestones: d.milestones.sort((a, b) => a.sortOrder - b.sortOrder).map((m) => ({
        id: m.id, name: m.name, percentage: m.percentage, inrAmount: m.inrAmount, status: m.status,
        triggerCondition: m.triggerCondition, expectedDate: m.expectedDate, actualTriggerDate: m.actualTriggerDate,
        paymentDate: m.paymentDate, paymentReference: m.paymentReference,
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
  res.json(maskFinancials({ rows, summary }, req.account));
}));

export default router;
