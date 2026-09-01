// Sequential approval for a payment's TAX INVOICE — mirrors the Vendor Payment
// "Approval Form" flow (paymentChain.ts), but for the invoice. Once the tax
// invoice is uploaded, "Submit Invoice for Approval" walks the SAME payment
// approval chain step-by-step: only the current step's approver(s) are mailed a
// no-login page to Approve / Hold the INVOICE. Progress is tracked with
// ApprovalStep rows (docType 'INVOICE', docId = GRN id) — the same table the
// PO / WO / payment chains use, so no new step table is needed. The invoice
// approval page also shows the payment's own approval status + UTR for reference.

import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { resolveAutoChain } from './fixedChain';
import { parseApprover } from '../lib/permissions';
import { sendEmail, appBaseUrl, isEmailEnabled, approvalCcEmail, approvalEmailHtml } from './email';
import { signApiPath } from '../lib/signedUrl';

export interface InvoiceGrn {
  id: string; grnNumber: string; docId: string; projectId: string; vendorName: string | null;
  invoiceReleaseToken: string | null; amountToPay: number | null; piValue: number | null;
  invoicePdfUrl: string | null; invoiceNumber: string | null; invoiceValue: number | null;
  utrNumber: string | null; releaseStatus: string | null;
}

const INVOICE = 'INVOICE';
const PAYMENT = 'PAYMENT'; // the invoice reuses the SAME chain configured for payments

/** Create the invoice step chain from the Vendor Payments config (first step
 *  PENDING, the rest WAITING). Always rebuilds — used on (re)submit. */
export async function buildInvoiceSteps(grn: InvoiceGrn): Promise<number> {
  const amount = grn.invoiceValue ?? grn.amountToPay ?? grn.piValue ?? 0;
  const auto = await resolveAutoChain(PAYMENT, grn.projectId, amount).catch(() => null);
  const groups = auto?.groups ?? [];
  await prisma.approvalStep.deleteMany({ where: { docType: INVOICE, docId: grn.id } });
  if (!groups.length) return 0; // no chain configured → notify falls back to CC

  const ids = [...new Set(groups.flat())];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, approver: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const placed = new Set<string>();
  const rows = groups.flatMap((g, gi) => g.flatMap((id) => {
    if (placed.has(id)) return [];
    placed.add(id);
    const u = byId.get(id);
    if (!u) return [];
    return [{
      docType: INVOICE, docId: grn.id, projectId: grn.projectId, order: gi + 1,
      approverId: u.id, approverName: u.name, approverEmail: u.email, approverRole: parseApprover(u.approver).approvalRole,
      status: gi === 0 ? 'PENDING' : 'WAITING',
    }];
  }));
  if (rows.length) await prisma.approvalStep.createMany({ data: rows });
  return rows.length;
}

/** Build the invoice step chain only if it doesn't exist yet (used by "Send
 *  Reminder" on an invoice submitted before the chain existed). */
export async function ensureInvoiceSteps(grn: InvoiceGrn): Promise<void> {
  const n = await prisma.approvalStep.count({ where: { docType: INVOICE, docId: grn.id } });
  if (n === 0) await buildInvoiceSteps(grn);
}

/** Email the CURRENT step's approver(s) the Invoice Approval-Form link. Any one
 *  of them can approve. Falls back to the whole chain / auditor CC when no step
 *  chain exists. Best-effort — never throws into the request. */
export async function notifyCurrentInvoiceStep(grn: InvoiceGrn): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    let token = grn.invoiceReleaseToken;
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await prisma.gRN.update({ where: { id: grn.id }, data: { invoiceReleaseToken: token } }); }

    const steps = await prisma.approvalStep.findMany({ where: { docType: INVOICE, docId: grn.id }, orderBy: { order: 'asc' } });
    const pending = steps.filter((s) => s.status === 'PENDING');
    let emails: string[] = [];
    let stepOrder = 1;
    if (pending.length) {
      stepOrder = Math.min(...pending.map((s) => s.order));
      emails = pending.filter((s) => s.order === stepOrder).map((s) => s.approverEmail).filter((e): e is string => !!e);
    } else {
      // No step chain → legacy: email the whole resolved chain at once.
      const amount = grn.invoiceValue ?? grn.amountToPay ?? grn.piValue ?? 0;
      const auto = await resolveAutoChain(PAYMENT, grn.projectId, amount).catch(() => null);
      const ids = auto?.approverIds ?? [];
      if (ids.length) {
        const us = await prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { email: true } });
        emails = us.map((u) => u.email).filter((e): e is string => !!e);
      }
    }
    if (!emails.length) { const cc = approvalCcEmail(); if (cc) emails = [cc]; }
    if (!emails.length) return;

    const po = await prisma.procurementDoc.findUnique({ where: { id: grn.docId }, select: { docNumber: true } });
    const link = `${appBaseUrl()}/api/public/invoice-approval/${token}?step=${stepOrder}`;
    const invUrl = grn.invoicePdfUrl ? `${appBaseUrl()}${grn.invoicePdfUrl.startsWith('/api/') ? signApiPath(grn.invoicePdfUrl) : grn.invoicePdfUrl}` : null;
    const lines = [`The tax invoice for payment <strong>${grn.grnNumber}</strong>${po?.docNumber ? ` (against ${po.docNumber})` : ''}${grn.vendorName ? ` — ${grn.vendorName}` : ''} needs your decision.`];
    if (grn.invoiceNumber) lines.push(`Invoice No.: <strong>${grn.invoiceNumber}</strong>`);
    if (invUrl) lines.push(`Tax Invoice: <a href="${invUrl}" style="color:#052379;font-weight:600;text-decoration:none">📄 View Invoice</a>`);
    if (grn.releaseStatus === 'APPROVED') lines.push(`Payment: <strong style="color:#16a34a">✓ Payment approved</strong>`);
    if (grn.utrNumber) lines.push(`UTR / Payment Ref: <strong>${grn.utrNumber}</strong>`);
    lines.push('Open the Approval Form to review the Invoice / PO / PI / KYC and Approve or put it On Hold. Your decision shows next to the payment in CRMCTS.');
    const html = approvalEmailHtml({ heading: `Invoice approval needed — ${grn.grnNumber}`, lines, actionUrl: link, actionLabel: 'Open Invoice Approval Form' });
    // ONE email with everyone on this step in "To" (shared form link, any one can
    // approve); the auditor is always kept in CC by default.
    const toList = [...new Set(emails)];
    try { await sendEmail({ to: toList.join(', '), cc: approvalCcEmail(), subject: `Invoice approval needed — ${grn.grnNumber}${po?.docNumber ? ` (${po.docNumber})` : ''}`, html }); } catch { /* best-effort */ }
  } catch { /* email is best-effort */ }
}

export type InvOutcome = 'ADVANCED' | 'COMPLETED' | 'ON_HOLD' | 'STALE';

/** Record a decision from the Invoice Approval Form on the CURRENT step.
 *  Mirrors decidePaymentStep, writing the invoiceRelease* fields on the GRN. */
export async function decideInvoiceStep(grnId: string, decision: 'APPROVED' | 'ON_HOLD', by: string | null, remark: string | null, linkStep?: number | null): Promise<InvOutcome> {
  const steps = await prisma.approvalStep.findMany({ where: { docType: INVOICE, docId: grnId }, orderBy: { order: 'asc' } });
  const pending = steps.filter((s) => s.status === 'PENDING');

  if (decision === 'ON_HOLD') {
    if (pending.length) {
      const o = Math.min(...pending.map((s) => s.order));
      await prisma.approvalStep.updateMany({ where: { id: { in: pending.filter((s) => s.order === o).map((s) => s.id) } }, data: { status: 'ON_HOLD', actedAt: new Date(), remarks: remark } });
    }
    await prisma.gRN.update({ where: { id: grnId }, data: { invoiceReleaseStatus: 'ON_HOLD', invoiceReleaseAt: new Date(), invoiceReleaseBy: by, invoiceReleaseRemark: remark } });
    return 'ON_HOLD';
  }

  // No step chain (unconfigured) → single all-at-once decision.
  if (!pending.length) {
    await prisma.gRN.update({ where: { id: grnId }, data: { invoiceReleaseStatus: 'APPROVED', invoiceReleaseAt: new Date(), invoiceReleaseBy: by, invoiceReleaseRemark: remark } });
    return 'COMPLETED';
  }

  const currentOrder = Math.min(...pending.map((s) => s.order));
  if (linkStep && linkStep !== currentOrder) return 'STALE'; // an already-passed step's link

  const group = pending.filter((s) => s.order === currentOrder);
  await prisma.approvalStep.update({ where: { id: group[0].id }, data: { status: 'APPROVED', actedAt: new Date(), remarks: remark } });
  if (group.length > 1) await prisma.approvalStep.updateMany({ where: { id: { in: group.slice(1).map((s) => s.id) } }, data: { status: 'SKIPPED', actedAt: new Date() } });

  const higher = steps.filter((s) => s.order > currentOrder);
  if (higher.length) {
    const nextOrder = Math.min(...higher.map((s) => s.order));
    await prisma.approvalStep.updateMany({ where: { id: { in: higher.filter((s) => s.order === nextOrder).map((s) => s.id) } }, data: { status: 'PENDING' } });
    await prisma.gRN.update({ where: { id: grnId }, data: { invoiceReleaseStatus: null, invoiceReleaseAt: new Date(), invoiceReleaseBy: by, invoiceReleaseRemark: remark } });
    return 'ADVANCED';
  }
  await prisma.gRN.update({ where: { id: grnId }, data: { invoiceReleaseStatus: 'APPROVED', invoiceReleaseAt: new Date(), invoiceReleaseBy: by, invoiceReleaseRemark: remark } });
  return 'COMPLETED';
}
