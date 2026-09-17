// Sequential approval for a RAISED ADVANCE — mirrors the Travel request chain but
// for a PettyCashEntry advance (docType 'ADVANCE'). Reuses the generic ApprovalStep
// engine + the "Approval Chains" config, so the fixed chain is set once in Settings
// and every raised advance flows through it. Only the current step's approver(s) get
// a no-login Approval Form by email; the entry carries approvalToken/approvalStatus
// as a quick mirror. Nothing here touches the PO/Travel decision code.
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { buildSteps, currentStepEmails, decideStep, type StepOutcome } from './travelChain';
import { sendEmail, appBaseUrl, isEmailEnabled, approvalCcEmail, approvalEmailHtml } from './email';

const ADVANCE = 'ADVANCE';
const inr = (n: number) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

interface AdvLike {
  id: string; entryNumber: string; amount: number; technician: string | null;
  projectId: string | null; description: string | null; recordedByName: string | null;
  approvalToken: string | null;
}

/** Build (or rebuild) the advance's approval steps from the 'ADVANCE' chain config. */
export async function buildAdvanceSteps(adv: AdvLike): Promise<number> {
  return buildSteps(ADVANCE, adv.id, adv.projectId ?? '', adv.amount ?? 0);
}

/** Current chain state for display. */
export async function advanceChainState(advId: string) {
  const steps = await prisma.approvalStep.findMany({ where: { docType: ADVANCE, docId: advId }, orderBy: { order: 'asc' } });
  const approved = steps.filter((s) => s.status === 'APPROVED' || s.status === 'SKIPPED').length;
  return { total: steps.length, approved, steps: steps.map((s) => ({ order: s.order, name: s.approverName, role: s.approverRole, status: s.status, actedAt: s.actedAt, remarks: s.remarks })) };
}

/** Email the current step's approver(s) a no-login Approval Form link. */
export async function notifyCurrentAdvanceStep(adv: AdvLike): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    let token = adv.approvalToken;
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await prisma.pettyCashEntry.update({ where: { id: adv.id }, data: { approvalToken: token } }); }
    const { emails, stepOrder } = await currentStepEmails(ADVANCE, adv.id, adv.projectId ?? '', adv.amount ?? 0);
    let to = emails;
    if (!to.length) { const cc = approvalCcEmail(); if (cc) to = [cc]; }
    if (!to.length) return;
    let projectName: string | null = null;
    if (adv.projectId) { const p = await prisma.project.findUnique({ where: { id: adv.projectId }, select: { name: true } }); projectName = p?.name ?? null; }
    const link = `${appBaseUrl()}/api/public/advance-approval/${token}?step=${stepOrder}`;
    const lines = [
      `An advance <strong>${adv.entryNumber}</strong> needs your approval.`,
      `For: <strong>${adv.technician || '—'}</strong>`,
      `Amount: <strong>${inr(adv.amount)}</strong>`,
    ];
    if (projectName) lines.push(`Site / Project: <strong>${projectName}</strong>`);
    if (adv.description) lines.push(`Note: ${adv.description}`);
    if (adv.recordedByName) lines.push(`Raised by: ${adv.recordedByName}`);
    lines.push('Open the Approval Form to Approve or put it On Hold.');
    const html = approvalEmailHtml({ heading: `Advance approval needed — ${adv.entryNumber}`, lines, actionUrl: link, actionLabel: 'Open Advance Approval Form' });
    try { await sendEmail({ to: [...new Set(to)].join(', '), cc: approvalCcEmail(), subject: `Advance approval needed — ${adv.entryNumber} · ${adv.technician || ''}`, html }); } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

/** Record a decision on the current step; mirror status onto the entry. On the
 *  final approval the advance becomes CONFIRMED (active + counted in cash-in-hand). */
export async function decideAdvanceStep(advId: string, decision: 'APPROVED' | 'ON_HOLD', by: string | null, remark: string | null, linkStep?: number | null): Promise<StepOutcome> {
  const outcome = await decideStep(ADVANCE, advId, decision, remark, linkStep);
  if (outcome === 'STALE') return outcome;
  if (decision === 'ON_HOLD') {
    await prisma.pettyCashEntry.update({ where: { id: advId }, data: { approvalStatus: 'ON_HOLD', decidedBy: by, decidedAt: new Date(), decisionRemark: remark } });
    return outcome;
  }
  if (outcome === 'ADVANCED') {
    await prisma.pettyCashEntry.update({ where: { id: advId }, data: { approvalStatus: null } });
    const adv = await prisma.pettyCashEntry.findUnique({ where: { id: advId } });
    if (adv) await notifyCurrentAdvanceStep(adv as any);
  } else { // COMPLETED | NO_CHAIN → approval done; now waiting for Accounts (FMS UTR/VR).
    // status APPROVED = "Approved · Account pending"; the FMS reverse-sync flips it
    // to CONFIRMED once the UTR/VR land in the sheet.
    await prisma.pettyCashEntry.update({ where: { id: advId }, data: { status: 'APPROVED', approvalStatus: 'APPROVED', decidedBy: by, decidedAt: new Date(), decisionRemark: remark } });
  }
  return outcome;
}
