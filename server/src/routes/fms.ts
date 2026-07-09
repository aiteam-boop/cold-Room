// FMS — Vendor Payment Entry (Procurement/Finance Flow PRD v2 §4).
// Mounted at /api/projects/:projectId/fms.
//
// Amisha records a payment to a vendor against a PO. Balance auto-computes, the
// PO's payment-terms % and vendor details are fetched on PO-select, a GST toggle
// controls whether the amount is GST-inclusive, and the finance approval chain
// (Supriya → Shivani → Alok → Tarakant → Sir, configurable) runs through the
// shared ApprovalStep engine with docType = 'PAYMENT'.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requireEdit, requirePage, requireSection } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { hasSection } from '../lib/permissions';
import {
  buildChain, recordDecision, finalizeApproval, markDocRejected,
  getChainState, resolveActor, remindCurrent, type DocType,
} from '../services/approvalChain';
import { notifyProjectRoles } from '../services/notify';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const parseJson = (s: string | null | undefined, fallback: unknown) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
const rs = (n: number) => 'Rs. ' + (n || 0).toLocaleString('en-IN');

// Next FMS-#### number, project-independent so it's globally unique.
async function nextPaymentNumber(): Promise<string> {
  const last = await prisma.vendorPayment.findFirst({ orderBy: { createdAt: 'desc' }, select: { paymentNumber: true } });
  const n = last?.paymentNumber?.match(/(\d+)$/);
  const next = (n ? parseInt(n[1], 10) : 0) + 1;
  return `FMS-${String(next).padStart(4, '0')}`;
}

// Sum of already-approved-or-paid payments against a PO (for the balance calc).
async function paidAgainstDoc(docId: string, excludeId?: string): Promise<number> {
  const rows = await prisma.vendorPayment.findMany({
    where: { docId, status: { in: ['APPROVED', 'PAID'] }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { amountToPay: true },
  });
  return rows.reduce((s, r) => s + r.amountToPay, 0);
}

function serialize(p: any) {
  return { ...p, payTermsSnapshot: parseJson(p.payTermsSnapshot, null) };
}

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', requireProjectMember, requirePage('fms'), asyncHandler(async (req, res) => {
  const payments = await prisma.vendorPayment.findMany({
    where: { projectId: req.params.projectId },
    orderBy: { createdAt: 'desc' },
    include: { doc: { select: { docNumber: true } } },
  });
  res.json({ payments: payments.map((p) => ({ ...serialize(p), poNumber: p.poNumber || p.doc?.docNumber || null })) });
}));

// ── PO options + fetch (for the form) ─────────────────────────────────────────
// The approved POs the user can pay against, and — for a chosen PO — its
// payment-terms %, vendor and amount, plus what has already been paid.
router.get('/po-options', requireProjectMember, requirePage('fms'), asyncHandler(async (req, res) => {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: req.params.projectId, type: { in: ['PO', 'WO'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, docNumber: true, vendorId: true, vendorName: true, finalAmount: true, status: true },
  });
  res.json({ pos: docs });
}));

router.get('/po/:docId', requireProjectMember, requirePage('fms'), asyncHandler(async (req, res) => {
  const doc = await prisma.procurementDoc.findFirst({
    where: { id: req.params.docId, projectId: req.params.projectId },
    include: { vendor: { select: { id: true, name: true, kycDocs: { where: { type: 'KYC' }, select: { fileUrl: true }, take: 1 } } } },
  });
  if (!doc) throw notFound('PO not found');
  const alreadyPaid = await paidAgainstDoc(doc.id);
  res.json({
    docId: doc.id, docNumber: doc.docNumber,
    vendorId: doc.vendorId, vendorName: doc.vendorName,
    finalAmount: doc.finalAmount, gstEnabled: doc.gstEnabled, gstPct: doc.gstPct,
    // The payment-terms % the FMS form pre-fills (fetched from the PO).
    payTerms: {
      advance: doc.payAdvancePct, beforeDelivery: doc.payBeforeDeliveryPct, running: doc.payRunningPct,
      postDelivery: doc.payPostDeliveryPct, postCompletion: doc.payPostCompletionPct, retention: doc.payRetentionPct,
    },
    alreadyPaid,
    // A KYC PDF already on file for the vendor, if any (auto-attach).
    kycPdfUrl: doc.vendor?.kycDocs?.[0]?.fileUrl ?? null,
  });
}));

// ── Detail ─────────────────────────────────────────────────────────────────────
router.get('/:id', requireProjectMember, requirePage('fms'), asyncHandler(async (req, res) => {
  const p = await prisma.vendorPayment.findFirst({
    where: { id: req.params.id, projectId: req.params.projectId },
    include: { doc: { select: { docNumber: true } } },
  });
  if (!p) throw notFound('Payment not found');
  const approval = await getChainState('PAYMENT', p.id);
  res.json({ payment: { ...serialize(p), poNumber: p.poNumber || p.doc?.docNumber || null }, approval });
}));

// ── Create / edit ──────────────────────────────────────────────────────────────
const upsertSchema = z.object({
  piNumber: z.string().nullable().optional(),
  piDate: z.string().nullable().optional(),
  vendorId: z.string().nullable().optional(),
  vendorName: z.string().nullable().optional(),
  docId: z.string().nullable().optional(),
  poNumber: z.string().nullable().optional(),
  paymentType: z.enum(['ADVANCE', 'BALANCE', 'FULL']).optional(),
  fullAmount: z.coerce.number().optional(),
  amountToPay: z.coerce.number().optional(),
  gstInclusive: z.boolean().optional(),
  gstPct: z.coerce.number().optional(),
  payTermsSnapshot: z.any().optional(),
  remark: z.string().nullable().optional(),
});

/** Balance = full − (paid so far against this PO + this entry's amount). */
async function computeBalance(docId: string | null | undefined, fullAmount: number, amountToPay: number, excludeId?: string): Promise<number> {
  const priorPaid = docId ? await paidAgainstDoc(docId, excludeId) : 0;
  return Math.round((fullAmount - priorPaid - amountToPay) * 100) / 100;
}

router.post('/', requireProjectMember, requireEdit('fms'), asyncHandler(async (req, res) => {
  const b = upsertSchema.parse(req.body);
  const paymentNumber = await nextPaymentNumber();
  const fullAmount = b.fullAmount ?? 0;
  const amountToPay = b.amountToPay ?? 0;
  const balance = await computeBalance(b.docId, fullAmount, amountToPay);

  const payment = await prisma.vendorPayment.create({
    data: {
      projectId: req.params.projectId, paymentNumber, filledById: req.user!.sub,
      piNumber: b.piNumber ?? null, piDate: b.piDate ? new Date(b.piDate) : null,
      vendorId: b.vendorId ?? null, vendorName: b.vendorName ?? null,
      docId: b.docId ?? null, poNumber: b.poNumber ?? null,
      paymentType: b.paymentType ?? 'ADVANCE',
      fullAmount, amountToPay, balance,
      gstInclusive: b.gstInclusive ?? false, gstPct: b.gstPct ?? 18,
      payTermsSnapshot: b.payTermsSnapshot !== undefined ? JSON.stringify(b.payTermsSnapshot) : null,
      remark: b.remark ?? null,
      status: 'DRAFT',
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'FMS_CREATE', entity: 'VendorPayment', entityId: payment.id, details: { paymentNumber } });
  res.status(201).json({ payment: serialize(payment) });
}));

router.patch('/:id', requireProjectMember, requireEdit('fms'), asyncHandler(async (req, res) => {
  const existing = await prisma.vendorPayment.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!existing) throw notFound('Payment not found');
  if (existing.status === 'APPROVED' || existing.status === 'PAID') throw forbidden('An approved payment is locked.');
  const b = upsertSchema.parse(req.body);

  const fullAmount = b.fullAmount ?? existing.fullAmount;
  const amountToPay = b.amountToPay ?? existing.amountToPay;
  const docId = b.docId !== undefined ? b.docId : existing.docId;
  const balance = await computeBalance(docId, fullAmount, amountToPay, existing.id);

  const payment = await prisma.vendorPayment.update({
    where: { id: existing.id },
    data: {
      ...(b.piNumber !== undefined && { piNumber: b.piNumber }),
      ...(b.piDate !== undefined && { piDate: b.piDate ? new Date(b.piDate) : null }),
      ...(b.vendorId !== undefined && { vendorId: b.vendorId }),
      ...(b.vendorName !== undefined && { vendorName: b.vendorName }),
      ...(b.docId !== undefined && { docId: b.docId }),
      ...(b.poNumber !== undefined && { poNumber: b.poNumber }),
      ...(b.paymentType !== undefined && { paymentType: b.paymentType }),
      fullAmount, amountToPay, balance,
      ...(b.gstInclusive !== undefined && { gstInclusive: b.gstInclusive }),
      ...(b.gstPct !== undefined && { gstPct: b.gstPct }),
      ...(b.payTermsSnapshot !== undefined && { payTermsSnapshot: JSON.stringify(b.payTermsSnapshot) }),
      ...(b.remark !== undefined && { remark: b.remark }),
    },
  });
  res.json({ payment: serialize(payment) });
}));

router.delete('/:id', requireProjectMember, requireEdit('fms'), asyncHandler(async (req, res) => {
  const existing = await prisma.vendorPayment.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!existing) throw notFound('Payment not found');
  if (existing.status === 'APPROVED' || existing.status === 'PAID') throw forbidden('An approved payment cannot be deleted.');
  await prisma.approvalStep.deleteMany({ where: { docType: 'PAYMENT', docId: existing.id } });
  await prisma.vendorPayment.delete({ where: { id: existing.id } });
  res.json({ ok: true });
}));

// ── Attachments (PI + KYC) ───────────────────────────────────────────────────
router.post('/:id/pi', requireProjectMember, requireEdit('fms'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const payment = await prisma.vendorPayment.update({ where: { id: req.params.id }, data: { piPdfUrl: `/uploads/${req.file.filename}` } });
  res.json({ ok: true, piPdfUrl: payment.piPdfUrl });
}));
router.post('/:id/kyc', requireProjectMember, requireEdit('fms'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const payment = await prisma.vendorPayment.update({ where: { id: req.params.id }, data: { kycPdfUrl: `/uploads/${req.file.filename}` } });
  res.json({ ok: true, kycPdfUrl: payment.kycPdfUrl });
}));

// ── Approval workflow (finance chain) ─────────────────────────────────────────
router.post('/:id/submit', requireProjectMember, requireEdit('fms'), asyncHandler(async (req, res) => {
  const p = await prisma.vendorPayment.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!p) throw notFound();
  if (p.status === 'PENDING_APPROVAL') throw badRequest('Already awaiting approval.');
  if (p.amountToPay <= 0) throw badRequest('Enter an amount to pay before submitting.');
  const chain = z.object({ chain: z.array(z.string()).optional() }).parse(req.body ?? {}).chain ?? [];

  const updated = await prisma.vendorPayment.update({ where: { id: p.id }, data: { status: 'PENDING_APPROVAL' } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'FMS_SUBMIT', entity: 'VendorPayment', entityId: p.id, details: { chainLength: chain.length } });
  if (chain.length) {
    const actor = await resolveActor(req.account!.id);
    await buildChain('PAYMENT', p.id, req.params.projectId, chain, actor);
  } else {
    await notifyProjectRoles(req.params.projectId, ['ADMIN'], { type: 'PAYMENT_SUBMITTED', title: 'Payment pending approval', message: `${p.paymentNumber} (${p.vendorName || 'vendor'}) ${rs(p.amountToPay)} needs approval.`, relatedDocType: 'VendorPayment', relatedDocId: p.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  }
  res.json({ payment: serialize(updated) });
}));

router.post('/:id/recall', requireProjectMember, requireEdit('fms'), asyncHandler(async (req, res) => {
  const p = await prisma.vendorPayment.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!p) throw notFound();
  if (p.status !== 'PENDING_APPROVAL') throw badRequest('Only pending payments can be recalled.');
  const updated = await prisma.vendorPayment.update({ where: { id: p.id }, data: { status: 'DRAFT' } });
  await prisma.approvalStep.deleteMany({ where: { docType: 'PAYMENT', docId: p.id } });
  res.json({ payment: serialize(updated) });
}));

// approve/reject — no requireProjectMember, so finance approvers who aren't
// project members can still act (mirrors the PO/GRN approve routes).
router.post('/:id/approve', asyncHandler(async (req, res) => {
  const p = await prisma.vendorPayment.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!p) throw notFound();
  if (p.status !== 'PENDING_APPROVAL') throw badRequest('Payment is not pending approval.');
  const remarks = typeof req.body?.remarks === 'string' ? req.body.remarks : undefined;
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: 'PAYMENT', docId: p.id } });
  if (stepCount > 0) {
    const outcome = await recordDecision('PAYMENT', p.id, actor, 'APPROVE', remarks);
    if (outcome === 'COMPLETED') await finalizeApproval('PAYMENT', p.id, actor.id);
    await audit({ userId: actor.id, projectId: req.params.projectId, action: 'FMS_APPROVE', entity: 'VendorPayment', entityId: p.id, details: { outcome } });
    return res.json({ ok: true, outcome });
  }
  if (!hasSection(req.account, 'canApprove')) throw forbidden('You do not have approval permission');
  await finalizeApproval('PAYMENT', p.id, actor.id);
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'FMS_APPROVE', entity: 'VendorPayment', entityId: p.id, details: { outcome: 'COMPLETED' } });
  res.json({ ok: true, outcome: 'COMPLETED' });
}));

router.post('/:id/reject', asyncHandler(async (req, res) => {
  const p = await prisma.vendorPayment.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!p) throw notFound();
  if (p.status !== 'PENDING_APPROVAL') throw badRequest('Payment is not pending approval.');
  const { reason } = z.object({ reason: z.string().trim().min(1, 'A reason is required.') }).parse(req.body);
  const actor = await resolveActor(req.account!.id);
  const stepCount = await prisma.approvalStep.count({ where: { docType: 'PAYMENT', docId: p.id } });
  if (stepCount > 0) await recordDecision('PAYMENT', p.id, actor, 'REJECT', reason);
  await markDocRejected('PAYMENT', p.id, reason);
  await audit({ userId: actor.id, projectId: req.params.projectId, action: 'FMS_REJECT', entity: 'VendorPayment', entityId: p.id, details: { reason } });
  res.json({ ok: true });
}));

router.post('/:id/remind', requireProjectMember, asyncHandler(async (req, res) => {
  const actor = await resolveActor(req.account!.id);
  await remindCurrent('PAYMENT', req.params.id, actor);
  res.json({ ok: true });
}));

// Finance marks the approved payment as actually paid (records UTR).
router.post('/:id/mark-paid', requireProjectMember, requireSection('canMarkPaid'), asyncHandler(async (req, res) => {
  const p = await prisma.vendorPayment.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!p) throw notFound();
  if (p.status !== 'APPROVED') throw badRequest('Only an approved payment can be marked paid.');
  const b = z.object({ paymentReference: z.string().trim().optional(), paidAt: z.string().optional() }).parse(req.body ?? {});
  const payment = await prisma.vendorPayment.update({
    where: { id: p.id },
    data: { status: 'PAID', paidAt: b.paidAt ? new Date(b.paidAt) : new Date(), paymentReference: b.paymentReference ?? null },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'FMS_MARK_PAID', entity: 'VendorPayment', entityId: p.id, details: { ref: b.paymentReference } });
  res.json({ payment: serialize(payment) });
}));

export default router;
