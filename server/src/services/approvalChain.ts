// Sequential approval-chain engine, shared by the PO/WO/GRN routes AND the
// one-click email-link endpoint. Manages ApprovalStep + ApprovalAction rows and
// runs the document-specific finalize side-effects on the last approval.

import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { notifyUser } from './notify';
import { sendEmail, approvalEmailHtml, approvalDocEmailHtml, appBaseUrl, appClientUrl, isEmailEnabled } from './email';
import { buildMilestones, normalizeTermsSections } from './procurement';
import { renderProcurementPdf, renderGRNPdf, renderToBuffer } from './procurementPdf';
import { parseApprover, approverHandlesType, approvalTypeForDoc, type ApprovalType } from '../lib/permissions';
import { isAdmin } from '../lib/enums';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

export type DocType = 'PO' | 'WO' | 'GRN' | 'PAYMENT';

// PO/WO map to their own approval type; GRN is GRN; a vendor PAYMENT (FMS) maps
// to the VENDOR_PAYMENT approver type.
const approvalTypeFor = (docType: DocType): ApprovalType => approvalTypeForDoc(docType);

export interface ActorInfo { id: string; name: string; email?: string | null; role?: string | null; isAdmin: boolean }

// Build an ActorInfo (name/email/approval-role) from a user id for logging.
export async function resolveActor(userId: string): Promise<ActorInfo> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, approver: true } });
  const prof = parseApprover(u?.approver);
  return { id: userId, name: u?.name ?? 'User', email: u?.email ?? null, role: prof.approvalRole || u?.role || null, isAdmin: u?.role === 'ADMIN' };
}

// ── Tokens for one-click email approval ──────────────────────────────────────
export function signApprovalToken(p: { stepId: string; docType: DocType; docId: string; approverId: string }): string {
  return jwt.sign(p, JWT_SECRET, { expiresIn: '14d' });
}
export function verifyApprovalToken(token: string): { stepId: string; docType: DocType; docId: string; approverId: string } | null {
  try { return jwt.verify(token, JWT_SECRET) as any; } catch { return null; }
}

// ── Document summary (generic across PO/WO/GRN) ──────────────────────────────
interface DocSummary { number: string; projectId: string; createdById: string | null; label: string; link: string }
async function docSummary(docType: DocType, docId: string): Promise<DocSummary | null> {
  if (docType === 'PAYMENT') {
    const p = await prisma.vendorPayment.findUnique({ where: { id: docId }, select: { paymentNumber: true, projectId: true, filledById: true } });
    if (!p) return null;
    return { number: p.paymentNumber, projectId: p.projectId, createdById: p.filledById, label: 'Payment', link: `/projects/${p.projectId}` };
  }
  if (docType === 'GRN') {
    const g = await prisma.gRN.findUnique({ where: { id: docId }, select: { grnNumber: true, projectId: true, raisedById: true } });
    if (!g) return null;
    return { number: g.grnNumber, projectId: g.projectId, createdById: g.raisedById, label: 'GRN', link: `/projects/${g.projectId}` };
  }
  const d = await prisma.procurementDoc.findUnique({ where: { id: docId }, select: { docNumber: true, projectId: true, createdById: true, type: true } });
  if (!d) return null;
  return { number: d.docNumber, projectId: d.projectId, createdById: d.createdById, label: d.type, link: `/projects/${d.projectId}` };
}

// ── Rich data for the approval email + the review page ───────────────────────
// Vendor, amounts and line items for the summary, plus the API path to the
// document's PDF (signed by the route so the approver can view it without
// logging in). Shared by notifyStep (email) and routes/approvals.ts (page).
export interface ApprovalDocData {
  label: string;          // PO / WO / GRN
  docLabelLong: string;   // Purchase Order / Work Order / Goods Receipt Note
  number: string;
  vendorName: string | null;
  projectName: string | null;
  totalLabel: string;
  totalAmount: number | null;
  rows: { description: string; qty: number | null; unitPrice: number | null; total: number | null }[];
  pdfPath: string | null; // /api/... path to the PDF, or null (e.g. PAYMENT)
  projectId: string;
}

export async function approvalDocData(docType: DocType, docId: string): Promise<ApprovalDocData | null> {
  if (docType === 'GRN') {
    const g = await prisma.gRN.findUnique({
      where: { id: docId },
      include: { lineItems: { orderBy: { srNo: 'asc' } }, project: { select: { name: true } } },
    });
    if (!g) return null;
    return {
      label: 'GRN', docLabelLong: 'Goods Receipt Note', number: g.grnNumber,
      vendorName: g.vendorName, projectName: g.project?.name ?? null,
      totalLabel: 'Invoice Value', totalAmount: g.invoiceValue ?? null,
      // The engineer's own receipt data — quantities, no PO pricing.
      rows: g.lineItems.map((l) => ({ description: l.description, qty: l.receiptQty, unitPrice: null, total: null })),
      pdfPath: `/api/projects/${g.projectId}/procurement/grns/${g.id}/pdf`, projectId: g.projectId,
    };
  }
  if (docType === 'PAYMENT') {
    const p = await prisma.vendorPayment.findUnique({ where: { id: docId }, select: { paymentNumber: true, projectId: true } });
    if (!p) return null;
    return { label: 'Payment', docLabelLong: 'Vendor Payment', number: p.paymentNumber, vendorName: null, projectName: null, totalLabel: 'Amount', totalAmount: null, rows: [], pdfPath: null, projectId: p.projectId };
  }
  const d = await prisma.procurementDoc.findUnique({
    where: { id: docId },
    include: { lineItems: { where: { isLeadTime: false }, orderBy: { sortOrder: 'asc' } }, project: { select: { name: true } } },
  });
  if (!d) return null;
  return {
    label: d.type, docLabelLong: d.type === 'WO' ? 'Work Order' : 'Purchase Order', number: d.docNumber,
    vendorName: d.vendorName, projectName: d.project?.name ?? null,
    totalLabel: 'Final Amount', totalAmount: Math.round(d.finalAmount),
    rows: d.lineItems.map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice, total: l.totalPrice })),
    pdfPath: `/api/projects/${d.projectId}/procurement/docs/${d.id}/pdf`, projectId: d.projectId,
  };
}

// Render the document's PDF to a Buffer so it can be attached to the approval
// email — the approver opens the whole PO/WO/GRN straight from their inbox.
const safeJson = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
export async function buildApprovalPdf(docType: DocType, docId: string): Promise<{ filename: string; buffer: Buffer } | null> {
  if (docType === 'GRN') {
    const grn = await prisma.gRN.findUnique({ where: { id: docId }, include: { lineItems: { orderBy: { srNo: 'asc' } }, doc: { select: { docNumber: true } } } });
    if (!grn) return null;
    const buffer = await renderToBuffer((s) => renderGRNPdf({ ...grn, docNumber: grn.doc.docNumber } as any, s));
    return { filename: `${grn.grnNumber}.pdf`, buffer };
  }
  if (docType === 'PAYMENT') return null; // no printable document
  const doc = await prisma.procurementDoc.findUnique({ where: { id: docId }, include: { lineItems: { orderBy: { sortOrder: 'asc' } } } });
  if (!doc) return null;
  const buffer = await renderToBuffer((s) => renderProcurementPdf({ ...doc, termsSections: normalizeTermsSections(safeJson(doc.termsSections)) } as any, s));
  return { filename: `${doc.docNumber}.pdf`, buffer };
}

async function logAction(docType: DocType, docId: string, stepId: string | null, actor: ActorInfo, action: string, remarks?: string) {
  await prisma.approvalAction.create({
    data: { docType, docId, stepId, actorId: actor.id || null, actorName: actor.name, actorEmail: actor.email ?? null, actorRole: actor.role ?? null, action, remarks: remarks ?? null },
  });
}

// Notify the approver whose turn it is — in-app + (if configured) email with a
// secure one-click link.
async function notifyStep(step: { id: string; docType: string; docId: string; approverId: string; approverEmail: string | null; approverName: string; order?: number; approverRole?: string | null }, doc: DocSummary, kind: 'NEW' | 'REMINDER') {
  const title = kind === 'REMINDER' ? `Reminder: ${doc.label} ${doc.number} awaiting approval` : `Approval needed: ${doc.label} ${doc.number}`;
  const message = `${doc.label} ${doc.number} is awaiting your approval.`;
  // Link to the self-contained Approvals page — the approver may not be a member
  // of the document's project, so we must NOT send them to the project workspace.
  await notifyUser(step.approverId, { type: 'APPROVAL_PENDING', title, message, projectId: doc.projectId, relatedDocType: step.docType, relatedDocId: step.docId, link: '/approvals' });
  if (!isEmailEnabled() || !step.approverEmail) return;

  const token = signApprovalToken({ stepId: step.id, docType: step.docType as DocType, docId: step.docId, approverId: step.approverId });
  const base = `${appBaseUrl()}/api/approvals/act?token=${encodeURIComponent(token)}`;

  // Rich email with the document summary + a full-PDF review page. Fall back to
  // the plain template if the document can't be loaded for some reason.
  const data = await approvalDocData(step.docType as DocType, step.docId);
  if (data) {
    const total = await prisma.approvalStep.count({ where: { docType: step.docType, docId: step.docId } });
    const stage = step.order ? `${step.approverRole || 'Approver'} · step ${step.order} of ${total}` : (step.approverRole || null);
    // No PDF attachment: the full document is shown on the review page that the
    // Approve / Reject buttons open (helper buildApprovalPdf is kept for reuse).
    await sendEmail({
      to: step.approverEmail,
      subject: title,
      html: approvalDocEmailHtml({
        label: data.label, docLabelLong: data.docLabelLong, number: data.number,
        vendorName: data.vendorName, projectName: data.projectName, stage,
        totalLabel: data.totalLabel, totalAmount: data.totalAmount, rows: data.rows,
        approverName: step.approverName,
        // Approve / Reject → the review page (shows the full PDF, no login needed).
        // Open Dashboard → the app itself, which asks the approver to sign in.
        approveUrl: `${base}&intent=approve`, rejectUrl: `${base}&intent=reject`,
        reviewUrl: `${appClientUrl()}/approvals`,
        reminder: kind === 'REMINDER',
      }),
    });
    return;
  }
  await sendEmail({
    to: step.approverEmail, subject: title,
    html: approvalEmailHtml({ heading: title, lines: [`Hi ${step.approverName},`, message, 'Review and record your decision using the button below.'], actionUrl: base, actionLabel: 'Review & Approve' }),
  });
}

// ── Build the chain on submit ────────────────────────────────────────────────
export async function buildChain(docType: DocType, docId: string, projectId: string, approverIds: string[], actor: ActorInfo) {
  if (!approverIds.length) throw new Error('Select at least one approver for the chain.');
  const type = approvalTypeFor(docType);
  const users = await prisma.user.findMany({ where: { id: { in: approverIds }, active: true }, select: { id: true, name: true, email: true, approver: true, role: true } });
  const byId = new Map(users.map((u) => [u.id, u]));

  // Preserve the order the creator chose; validate each is a valid approver.
  // Admins can approve any document type, so they are always allowed in a chain
  // even without an explicit approver profile.
  const steps = approverIds.map((id, i) => {
    const u = byId.get(id);
    if (!u) throw new Error('An approver in the chain no longer exists.');
    const prof = parseApprover(u.approver);
    const admin = isAdmin(u.role);
    if (!admin && !approverHandlesType(prof, type)) throw new Error(`${u.name} is not authorised to approve ${type}.`);
    return { order: i + 1, approverId: u.id, approverName: u.name, approverEmail: u.email, approverRole: prof.approvalRole || (admin ? 'Admin' : null), status: i === 0 ? 'PENDING' : 'WAITING' };
  });

  // Clear any prior chain (re-submit) then create fresh.
  await prisma.approvalStep.deleteMany({ where: { docType, docId } });
  await prisma.approvalStep.createMany({ data: steps.map((s) => ({ ...s, docType, docId, projectId })) });
  await logAction(docType, docId, null, actor, 'SUBMITTED');

  const doc = await docSummary(docType, docId);
  const first = await prisma.approvalStep.findFirst({ where: { docType, docId, order: 1 } });
  if (doc && first) await notifyStep(first, doc, 'NEW');
}

// ── Chain state (for the timeline) ───────────────────────────────────────────
export async function getChainState(docType: DocType, docId: string) {
  const [steps, actions] = await Promise.all([
    prisma.approvalStep.findMany({ where: { docType, docId }, orderBy: { order: 'asc' } }),
    prisma.approvalAction.findMany({ where: { docType, docId }, orderBy: { at: 'asc' } }),
  ]);
  const current = steps.find((s) => s.status === 'PENDING') || null;
  const approved = steps.filter((s) => s.status === 'APPROVED').length;
  return { steps, actions, currentStepId: current?.id ?? null, currentApproverId: current?.approverId ?? null, approved, total: steps.length };
}

export type Outcome = 'ADVANCED' | 'COMPLETED' | 'REJECTED';

// Record an approve/reject on the CURRENT step. Authorises actor = current
// approver, or an admin override. Returns the outcome; the caller finalizes.
export async function recordDecision(docType: DocType, docId: string, actor: ActorInfo, decision: 'APPROVE' | 'REJECT', remarks?: string): Promise<Outcome> {
  const steps = await prisma.approvalStep.findMany({ where: { docType, docId }, orderBy: { order: 'asc' } });
  const current = steps.find((s) => s.status === 'PENDING');
  if (!current) throw new Error('There is no pending approval step for this document.');
  if (current.approverId !== actor.id && !actor.isAdmin) throw new Error('Only the current approver can act on this step.');

  const doc = await docSummary(docType, docId);

  if (decision === 'REJECT') {
    await prisma.approvalStep.update({ where: { id: current.id }, data: { status: 'REJECTED', actedAt: new Date(), remarks: remarks ?? null } });
    await logAction(docType, docId, current.id, actor, 'REJECTED', remarks);
    if (doc?.createdById) await notifyUser(doc.createdById, { type: 'APPROVAL_REJECTED', title: `${doc.label} ${doc.number} rejected`, message: `${actor.name} rejected it${remarks ? `: ${remarks}` : '.'}`, projectId: doc.projectId, relatedDocType: docType, relatedDocId: docId, link: doc.link });
    return 'REJECTED';
  }

  await prisma.approvalStep.update({ where: { id: current.id }, data: { status: 'APPROVED', actedAt: new Date(), remarks: remarks ?? null } });
  await logAction(docType, docId, current.id, actor, 'APPROVED', remarks);

  const next = steps.find((s) => s.order > current.order && s.status === 'WAITING');
  if (next) {
    await prisma.approvalStep.update({ where: { id: next.id }, data: { status: 'PENDING' } });
    if (doc) await notifyStep(next, doc, 'NEW');
    return 'ADVANCED';
  }
  return 'COMPLETED';
}

// Re-notify the current pending approver.
export async function remindCurrent(docType: DocType, docId: string, actor: ActorInfo) {
  const current = await prisma.approvalStep.findFirst({ where: { docType, docId, status: 'PENDING' }, orderBy: { order: 'asc' } });
  if (!current) throw new Error('No approval is currently pending.');
  const doc = await docSummary(docType, docId);
  if (doc) await notifyStep(current, doc, 'REMINDER');
  await logAction(docType, docId, current.id, actor, 'REMINDED');
}

// ── Finalize (document-specific side-effects on last approval) ───────────────
// Called by the route/email endpoint when recordDecision returns 'COMPLETED'.
export async function finalizeApproval(docType: DocType, docId: string, actorId: string) {
  if (docType === 'PAYMENT') {
    const p = await prisma.vendorPayment.findUnique({ where: { id: docId } });
    if (!p) return;
    await prisma.vendorPayment.update({ where: { id: p.id }, data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() } });
    if (p.filledById) await notifyUser(p.filledById, { type: 'PAYMENT_APPROVED', title: 'Payment approved', message: `${p.paymentNumber} has been fully approved.`, projectId: p.projectId, relatedDocType: 'VendorPayment', relatedDocId: p.id, link: `/projects/${p.projectId}` });
    return;
  }
  if (docType === 'GRN') {
    const grn = await prisma.gRN.findUnique({ where: { id: docId } });
    if (!grn) return;
    await prisma.gRN.update({ where: { id: grn.id }, data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() } });
    await prisma.procurementDocument.create({ data: { projectId: grn.projectId, type: 'GRN', fileName: `${grn.grnNumber}.pdf`, fileUrl: `/api/projects/${grn.projectId}/procurement/grns/${grn.id}/pdf`, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, uploadedById: actorId } });
    if (grn.raisedById) await notifyUser(grn.raisedById, { type: 'GRN_APPROVED', title: 'GRN approved', message: `${grn.grnNumber} has been fully approved.`, projectId: grn.projectId, relatedDocType: 'GRN', relatedDocId: grn.id, link: `/projects/${grn.projectId}` });
    return;
  }
  const doc = await prisma.procurementDoc.findUnique({ where: { id: docId } });
  if (!doc) return;
  const milestones = buildMilestones(doc);
  await prisma.$transaction([
    prisma.paymentMilestone.deleteMany({ where: { docId: doc.id } }),
    prisma.paymentMilestone.createMany({ data: milestones.map((m) => ({ ...m, docId: doc.id })) }),
    prisma.procurementDoc.update({ where: { id: doc.id }, data: { status: 'APPROVED', esignApplied: true, approvedById: actorId, approvedAt: new Date(), lockedAt: new Date() } }),
  ]);
  await prisma.procurementDocument.create({ data: { projectId: doc.projectId, type: doc.type, fileName: `${doc.docNumber}.pdf`, fileUrl: `/api/projects/${doc.projectId}/procurement/docs/${doc.id}/pdf`, linkedDocNumber: doc.docNumber, vendorId: doc.vendorId, vendorName: doc.vendorName, uploadedById: actorId } });
  if (doc.createdById) await notifyUser(doc.createdById, { type: 'DOC_APPROVED', title: `${doc.type} approved`, message: `${doc.docNumber} has been fully approved and e-signed.`, projectId: doc.projectId, relatedDocType: 'ProcurementDoc', relatedDocId: doc.id, link: `/projects/${doc.projectId}` });
}

// Set the parent document's status after a rejection.
export async function markDocRejected(docType: DocType, docId: string, reason: string) {
  if (docType === 'PAYMENT') {
    await prisma.vendorPayment.update({ where: { id: docId }, data: { status: 'REJECTED', rejectionReason: reason } });
  } else if (docType === 'GRN') {
    await prisma.gRN.update({ where: { id: docId }, data: { status: 'REJECTED', rejectionReason: reason } });
  } else {
    await prisma.procurementDoc.update({ where: { id: docId }, data: { status: 'DRAFT', rejectionReason: reason } });
  }
}
