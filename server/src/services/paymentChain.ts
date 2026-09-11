// Sequential approval for Vendor Payments (the PAY-QAS "Approval Form" flow).
//
// Before this, the payment mail went to EVERYONE in the Vendor Payments chain at
// once and any one decision closed it. Now it walks the chain STEP BY STEP, just
// like a PO: only the current step's approver(s) are mailed; any one of them
// approving advances to the next step; the last step's approval is the final
// sign-off (releaseStatus = APPROVED). On Hold at any step freezes it.
//
// Progress is tracked with ApprovalStep rows (docType 'PAYMENT', docId = GRN id) —
// the same table the PO/WO chain uses — so no schema change is needed. The
// payment form is a no-login link, so each step's email carries ?step=<order>;
// decide() refuses a stale link whose step has already passed (prevents a step-1
// approver from accidentally completing a later step).

import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { resolveAutoChain } from './fixedChain';
import { parseApprover } from '../lib/permissions';
import { sendEmail, appBaseUrl, isEmailEnabled, approvalCcEmail, approvalEmailHtml, escapeHtml } from './email';
import { signApiPath } from '../lib/signedUrl';

export interface PayGrn {
  id: string; grnNumber: string; docId: string; projectId: string; vendorName: string | null;
  releaseToken: string | null; amountToPay: number | null; piValue: number | null;
  piPdfUrl: string | null; piNumber: string | null; ledgerHead?: string | null;
}

const PAYMENT = 'PAYMENT';

/** Create the step chain for a payment from the Vendor Payments config (first
 *  step PENDING, the rest WAITING). Always rebuilds — used on (re)submit. */
export async function buildPaymentSteps(grn: PayGrn): Promise<number> {
  const amount = grn.amountToPay ?? grn.piValue ?? 0;
  const auto = await resolveAutoChain(PAYMENT, grn.projectId, amount).catch(() => null);
  const groups = auto?.groups ?? [];
  await prisma.approvalStep.deleteMany({ where: { docType: PAYMENT, docId: grn.id } });
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
      docType: PAYMENT, docId: grn.id, projectId: grn.projectId, order: gi + 1,
      approverId: u.id, approverName: u.name, approverEmail: u.email, approverRole: parseApprover(u.approver).approvalRole,
      status: gi === 0 ? 'PENDING' : 'WAITING',
    }];
  }));
  if (rows.length) await prisma.approvalStep.createMany({ data: rows });
  return rows.length;
}

/** Build the step chain only if it doesn't exist yet (used by "Send Reminder"
 *  on a payment created before this flow). */
export async function ensurePaymentSteps(grn: PayGrn): Promise<void> {
  const n = await prisma.approvalStep.count({ where: { docType: PAYMENT, docId: grn.id } });
  if (n === 0) await buildPaymentSteps(grn);
}

/** Email the CURRENT step's approver(s) the Approval-Form link. Any one of them
 *  can approve. Falls back to the whole chain / auditor CC when no step chain
 *  exists (legacy / unconfigured). Best-effort — never throws into the request. */
export async function notifyCurrentPaymentStep(grn: PayGrn): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    let token = grn.releaseToken;
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await prisma.gRN.update({ where: { id: grn.id }, data: { releaseToken: token } }); }

    const steps = await prisma.approvalStep.findMany({ where: { docType: PAYMENT, docId: grn.id }, orderBy: { order: 'asc' } });
    const pending = steps.filter((s) => s.status === 'PENDING');
    let emails: string[] = [];
    let stepOrder = 1;
    if (pending.length) {
      stepOrder = Math.min(...pending.map((s) => s.order));
      emails = pending.filter((s) => s.order === stepOrder).map((s) => s.approverEmail).filter((e): e is string => !!e);
    } else {
      // No step chain → legacy: email the whole resolved chain at once.
      const amount = grn.amountToPay ?? grn.piValue ?? 0;
      const auto = await resolveAutoChain(PAYMENT, grn.projectId, amount).catch(() => null);
      const ids = auto?.approverIds ?? [];
      if (ids.length) {
        const us = await prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { email: true } });
        emails = us.map((u) => u.email).filter((e): e is string => !!e);
      }
    }
    if (!emails.length) { const cc = approvalCcEmail(); if (cc) emails = [cc]; }
    if (!emails.length) return;

    const po = await prisma.procurementDoc.findUnique({ where: { id: grn.docId }, select: { docNumber: true, basicAmount: true, finalAmount: true, gstEnabled: true, gstPct: true } });
    const link = `${appBaseUrl()}/api/public/payment-approval/${token}?step=${stepOrder}`;
    const piUrl = grn.piPdfUrl ? `${appBaseUrl()}${grn.piPdfUrl.startsWith('/api/') ? signApiPath(grn.piPdfUrl) : grn.piPdfUrl}` : null;
    const rup = (n: number) => `₹${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
    const lines = [`A payment <strong>${grn.grnNumber}</strong>${po?.docNumber ? ` (against ${po.docNumber})` : ''}${grn.vendorName ? ` — ${grn.vendorName}` : ''} needs your decision.`];
    // Amount actually being paid + the PO value breakup (Basic / GST / Final) so
    // the approver sees the split, not just one lump figure.
    const payAmt = grn.amountToPay ?? grn.piValue ?? 0;
    lines.push(`Amount to pay: <strong>${rup(payAmt)}</strong>`);
    if (po?.basicAmount != null) {
      const gstAmt = Math.round(((po.finalAmount ?? 0) - (po.basicAmount ?? 0)) * 100) / 100;
      const gstBit = po.gstEnabled && po.gstPct != null ? ` &nbsp;·&nbsp; GST (${po.gstPct}%): <strong>${rup(gstAmt)}</strong>` : '';
      lines.push(`PO value — Basic: <strong>${rup(po.basicAmount)}</strong>${gstBit} &nbsp;·&nbsp; Final (with GST): <strong>${rup(po.finalAmount ?? 0)}</strong>`);
    }
    if (piUrl) lines.push(`Proforma Invoice${grn.piNumber ? ` (PI ${grn.piNumber})` : ''}: <a href="${piUrl}" style="color:#052379;font-weight:600;text-decoration:none">📄 View PI</a>`);
    // Ledger Head — free-text remark from the Payment, so the approver sees it here.
    const ledger = grn.ledgerHead ?? (await prisma.gRN.findUnique({ where: { id: grn.id }, select: { ledgerHead: true } }).catch(() => null))?.ledgerHead ?? null;
    if (ledger) lines.push(`Ledger Head: <strong>${escapeHtml(ledger)}</strong>`);
    lines.push('Open the Approval Form to review the PO / PI / GRN / KYC / amount and Approve or put it On Hold. Your decision shows on the FMS sheet and in the app.');
    const html = approvalEmailHtml({ heading: `Payment approval needed — ${grn.grnNumber}`, lines, actionUrl: link, actionLabel: 'Open Approval Form' });
    // ONE email with everyone on this step in "To" (they share the same form link,
    // any one can approve) — not a separate mail each. The auditor is ALWAYS kept
    // in CC by default, as before, even if they're also a step approver.
    const toList = [...new Set(emails)];
    try { await sendEmail({ to: toList.join(', '), cc: approvalCcEmail(), subject: `Payment approval needed — ${grn.grnNumber}${po?.docNumber ? ` (${po.docNumber})` : ''}`, html }); } catch { /* best-effort */ }
  } catch { /* email is best-effort */ }
}

export type PayOutcome = 'ADVANCED' | 'COMPLETED' | 'ON_HOLD' | 'STALE';

/** Record a decision from the Approval Form on the CURRENT step.
 *  APPROVE: any one passes the step → advance, or finalise if it was the last.
 *  HOLD: freeze the payment (releaseStatus ON_HOLD).
 *  `linkStep` is the step the email link was for — a stale link (its step already
 *  passed) is refused so a step-1 approver can't complete a later step. */
export async function decidePaymentStep(grnId: string, decision: 'APPROVED' | 'ON_HOLD', by: string | null, remark: string | null, linkStep?: number | null): Promise<PayOutcome> {
  const steps = await prisma.approvalStep.findMany({ where: { docType: PAYMENT, docId: grnId }, orderBy: { order: 'asc' } });
  const pending = steps.filter((s) => s.status === 'PENDING');

  if (decision === 'ON_HOLD') {
    if (pending.length) {
      const o = Math.min(...pending.map((s) => s.order));
      await prisma.approvalStep.updateMany({ where: { id: { in: pending.filter((s) => s.order === o).map((s) => s.id) } }, data: { status: 'ON_HOLD', actedAt: new Date(), remarks: remark } });
    }
    await prisma.gRN.update({ where: { id: grnId }, data: { releaseStatus: 'ON_HOLD', releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
    return 'ON_HOLD';
  }

  // No step chain (unconfigured) → single all-at-once decision, as before.
  if (!pending.length) {
    await prisma.gRN.update({ where: { id: grnId }, data: { releaseStatus: 'APPROVED', releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
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
    // Not final yet — record who signed this step but keep releaseStatus pending.
    await prisma.gRN.update({ where: { id: grnId }, data: { releaseStatus: null, releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
    return 'ADVANCED';
  }
  await prisma.gRN.update({ where: { id: grnId }, data: { releaseStatus: 'APPROVED', releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
  return 'COMPLETED';
}
