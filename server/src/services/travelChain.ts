// Sequential approval for the Travel module — mirrors the invoice/payment chains
// (invoiceChain.ts) but for travel. Two independent chains, both driven by the
// generic ApprovalStep table + the "Approval Chains — who signs, in order" config:
//   • docType 'TRAVEL'          → the travel REQUEST (e.g. Akash approves).
//   • docType 'TRAVEL_EXPENSE'  → the post-trip EXPENSE (e.g. Ops any-of → Akash).
// Only the current step's approver(s) are mailed a no-login Approval Form. Progress
// lives in ApprovalStep rows; the plan/expense carry a release* mirror for quick
// status + the public token page. Nothing here touches the PO/Payment decision code.

import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { resolveAutoChain } from './fixedChain';
import { parseApprover } from '../lib/permissions';
import { sendEmail, appBaseUrl, appClientUrl, isEmailEnabled, approvalCcEmail, approvalEmailHtml } from './email';

const TRAVEL = 'TRAVEL';
const TRAVEL_EXPENSE = 'TRAVEL_EXPENSE';

// ── Generic step machinery (shared by both chains) ───────────────────────────

export async function buildSteps(docType: string, docId: string, projectId: string, amount: number): Promise<number> {
  const auto = await resolveAutoChain(docType as any, projectId || '', amount).catch(() => null);
  const groups = auto?.groups ?? [];
  await prisma.approvalStep.deleteMany({ where: { docType, docId } });
  if (!groups.length) return 0; // no chain configured → notify falls back to CC

  const ids = [...new Set(groups.flat())];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, approver: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  // Which approver(s) in the configured chain are flagged to BOOK & UPLOAD the
  // ticket (Travel Request only) — copied onto the step so the Approval Form can
  // show them an upload field.
  const cfg = await prisma.approvalChainConfig.findMany({ where: { docType, approverId: { in: ids } }, select: { approverId: true, canUploadTicket: true } });
  const uploader = new Map(cfg.map((c) => [c.approverId, !!c.canUploadTicket]));
  const placed = new Set<string>();
  const rows = groups.flatMap((g, gi) => g.flatMap((id) => {
    if (placed.has(id)) return [];
    placed.add(id);
    const u = byId.get(id);
    if (!u) return [];
    return [{
      docType, docId, projectId: projectId || 'GLOBAL', order: gi + 1,
      approverId: u.id, approverName: u.name, approverEmail: u.email, approverRole: parseApprover(u.approver).approvalRole,
      status: gi === 0 ? 'PENDING' : 'WAITING', uploadsTicket: uploader.get(u.id) ?? false,
    }];
  }));
  if (rows.length) await prisma.approvalStep.createMany({ data: rows });
  return rows.length;
}

/** Emails for the CURRENT pending step (any one can approve). Falls back to the
 *  whole resolved chain, then the auditor CC. */
export async function currentStepEmails(docType: string, docId: string, projectId: string, amount: number): Promise<{ emails: string[]; stepOrder: number }> {
  const steps = await prisma.approvalStep.findMany({ where: { docType, docId }, orderBy: { order: 'asc' } });
  const pending = steps.filter((s) => s.status === 'PENDING');
  if (pending.length) {
    const stepOrder = Math.min(...pending.map((s) => s.order));
    const emails = pending.filter((s) => s.order === stepOrder).map((s) => s.approverEmail).filter((e): e is string => !!e);
    return { emails, stepOrder };
  }
  const auto = await resolveAutoChain(docType as any, projectId || '', amount).catch(() => null);
  const ids = auto?.approverIds ?? [];
  if (ids.length) {
    const us = await prisma.user.findMany({ where: { id: { in: ids }, active: true }, select: { email: true } });
    return { emails: us.map((u) => u.email).filter((e): e is string => !!e), stepOrder: 1 };
  }
  return { emails: [], stepOrder: 1 };
}

export type StepOutcome = 'ADVANCED' | 'COMPLETED' | 'ON_HOLD' | 'STALE' | 'NO_CHAIN';

/** Record a decision on the current step. Returns the outcome; the caller mirrors
 *  the release* fields + status onto the plan/expense. */
export async function decideStep(docType: string, docId: string, decision: 'APPROVED' | 'ON_HOLD', remark: string | null, linkStep?: number | null): Promise<StepOutcome> {
  const steps = await prisma.approvalStep.findMany({ where: { docType, docId }, orderBy: { order: 'asc' } });
  const pending = steps.filter((s) => s.status === 'PENDING');

  if (decision === 'ON_HOLD') {
    if (pending.length) {
      const o = Math.min(...pending.map((s) => s.order));
      await prisma.approvalStep.updateMany({ where: { id: { in: pending.filter((s) => s.order === o).map((s) => s.id) } }, data: { status: 'ON_HOLD', actedAt: new Date(), remarks: remark } });
    }
    return 'ON_HOLD';
  }

  if (!steps.length) return 'NO_CHAIN';         // unconfigured → single all-at-once approval
  if (!pending.length) return 'COMPLETED';      // nothing left pending → already done

  const currentOrder = Math.min(...pending.map((s) => s.order));
  if (linkStep && linkStep !== currentOrder) return 'STALE';

  const group = pending.filter((s) => s.order === currentOrder);
  await prisma.approvalStep.update({ where: { id: group[0].id }, data: { status: 'APPROVED', actedAt: new Date(), remarks: remark } });
  if (group.length > 1) await prisma.approvalStep.updateMany({ where: { id: { in: group.slice(1).map((s) => s.id) } }, data: { status: 'SKIPPED', actedAt: new Date() } });

  const higher = steps.filter((s) => s.order > currentOrder);
  if (higher.length) {
    const nextOrder = Math.min(...higher.map((s) => s.order));
    await prisma.approvalStep.updateMany({ where: { id: { in: higher.filter((s) => s.order === nextOrder).map((s) => s.id) } }, data: { status: 'PENDING' } });
    return 'ADVANCED';
  }
  return 'COMPLETED';
}

/** Current chain state for display (who's signed, whose turn). */
export async function travelChainState(docType: 'TRAVEL' | 'TRAVEL_EXPENSE', docId: string) {
  const steps = await prisma.approvalStep.findMany({ where: { docType, docId }, orderBy: { order: 'asc' } });
  const approved = steps.filter((s) => s.status === 'APPROVED' || s.status === 'SKIPPED').length;
  return {
    total: steps.length, approved,
    steps: steps.map((s) => ({ order: s.order, name: s.approverName, role: s.approverRole, status: s.status, actedAt: s.actedAt, remarks: s.remarks, uploadsTicket: s.uploadsTicket })),
  };
}

// ── TRAVEL REQUEST chain (docType 'TRAVEL') ──────────────────────────────────

interface PlanLike {
  id: string; planNumber: string; projectId: string | null; employeeName: string; destination: string | null;
  fromDate: Date; toDate: Date; totalAdvance: number; releaseToken: string | null;
  // Optional richer fields (Ticket-Request style) surfaced in the approval email.
  mLevel?: string | null; designation?: string | null; department?: string | null; origin?: string | null; purpose?: string | null;
  travelMode?: string | null; tripType?: string | null; ticketPrice?: number | null; ticketFileUrl?: string | null; days?: number | null; isNonCrystal?: boolean;
}

export async function buildTravelSteps(plan: PlanLike): Promise<number> {
  return buildSteps(TRAVEL, plan.id, plan.projectId ?? '', plan.totalAdvance ?? 0);
}

export async function notifyCurrentTravelStep(plan: PlanLike): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    let token = plan.releaseToken;
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await prisma.travelPlan.update({ where: { id: plan.id }, data: { releaseToken: token } }); }
    const { emails, stepOrder } = await currentStepEmails(TRAVEL, plan.id, plan.projectId ?? '', plan.totalAdvance ?? 0);
    let to = emails;
    if (!to.length) { const cc = approvalCcEmail(); if (cc) to = [cc]; }
    if (!to.length) return;
    const link = `${appBaseUrl()}/api/public/travel-approval/${token}?type=request&step=${stepOrder}`;
    const win = `${plan.fromDate.toISOString().slice(0, 10)} → ${plan.toDate.toISOString().slice(0, 10)}${plan.days ? ` · ${plan.days} day(s)` : ''}`;
    const route = [plan.origin, plan.destination].filter(Boolean).join(' → ') || (plan.destination ?? '—');
    const who = `<strong>${plan.employeeName}</strong>${plan.isNonCrystal ? ' (Non-Crystal)' : ''}${plan.mLevel ? ` · ${plan.mLevel}` : ''}${plan.designation ? ` · ${plan.designation}` : ''}${plan.department ? ` · ${plan.department}` : ''}`;
    const lines = [
      `A travel request <strong>${plan.planNumber}</strong> needs your approval.`,
      `Traveller: ${who}`,
      `Route: <strong>${route}</strong>`,
      `Dates: <strong>${win}</strong>`,
    ];
    if (plan.travelMode) lines.push(`Mode: <strong>${plan.travelMode}</strong>`);
    if (plan.tripType) lines.push(`Ticket for: <strong>${plan.tripType === 'going' ? 'Going only' : plan.tripType === 'return' ? 'Return only' : 'Going + Return'}</strong>`);
    if (plan.ticketPrice != null && plan.ticketPrice > 0) lines.push(`Ticket price: <strong>₹${Math.round(plan.ticketPrice).toLocaleString('en-IN')}</strong>`);
    if (plan.totalAdvance > 0) lines.push(`Advance requested: <strong>₹${Math.round(plan.totalAdvance).toLocaleString('en-IN')}</strong>`);
    if (plan.ticketFileUrl) lines.push(`Ticket: <a href="${appBaseUrl()}${plan.ticketFileUrl}" style="color:#052379;font-weight:600;text-decoration:none">📎 View ticket</a>`);
    if (plan.purpose) lines.push(`Purpose: ${plan.purpose}`);
    lines.push('Open the Approval Form to review the trip and Approve or put it On Hold.');
    const html = approvalEmailHtml({ heading: `Travel approval needed — ${plan.planNumber}`, lines, actionUrl: link, actionLabel: 'Open Travel Approval Form' });
    try { await sendEmail({ to: [...new Set(to)].join(', '), cc: approvalCcEmail(), subject: `Travel approval needed — ${plan.planNumber} · ${plan.employeeName}`, html }); } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

// After the tech entry's FINAL approval, tell the traveller what was approved —
// "your expenses are approved, ₹X will be reimbursed/adjusted." Best-effort.
export async function notifyEmployeeTechApproved(planId: string): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    const plan = await prisma.travelPlan.findUnique({ where: { id: planId } });
    if (!plan?.employeeId) return;
    const user = await prisma.user.findUnique({ where: { id: plan.employeeId }, select: { email: true, name: true } });
    if (!user?.email) return;
    const t = ((): any => { try { return plan.techApproved ? JSON.parse(plan.techApproved) : {}; } catch { return {}; } })();
    const grand = ['travel', 'food', 'hotel', 'other', 'misc'].reduce((s, k) => s + (Number(t[k]) || 0), 0);
    const adv = Number(plan.totalAdvance) || 0;
    const rupee = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
    const lines = [
      `Hi ${user.name},`,
      `Your trip expenses for <strong>${plan.planNumber}</strong> have been <strong>approved</strong>.`,
      `Approved amount: <strong>${rupee(grand)}</strong>`,
    ];
    if (adv > 0) { const net = grand - adv; lines.push(`Advance already taken: <strong>${rupee(adv)}</strong>`); lines.push(net >= 0 ? `To be reimbursed to you: <strong>${rupee(net)}</strong>` : `To be recovered from you: <strong>${rupee(Math.abs(net))}</strong>`); }
    const html = approvalEmailHtml({ heading: `Trip expenses approved — ${plan.planNumber}`, lines, actionUrl: `${appClientUrl()}/travel`, actionLabel: 'Open Travel' });
    await sendEmail({ to: user.email, subject: `Trip expenses approved — ${plan.planNumber} · ${rupee(grand)}`, html });
  } catch { /* best-effort */ }
}

// When Stage 2 approves and a Stage-3 (Final approval / Sir) approver is set, email
// them that a trip's expenses await their final approval. They open a no-login
// Final-Approval Form (advance held + per-category stage breakdown + day-wise
// spend) and Approve / Reject right there — just like the Advance / Payment forms.
export async function notifyTechStage3Approver(planId: string): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    const plan = await prisma.travelPlan.findUnique({ where: { id: planId } });
    if (!plan) return;
    const cfg = await prisma.travelConfig.findFirst({ where: { projectId: null } });
    if (!cfg?.stage3Id) return;
    const user = await prisma.user.findUnique({ where: { id: cfg.stage3Id }, select: { email: true, name: true } });
    if (!user?.email) return;
    // Token for the public Final-Approval Form (reused if already minted).
    let token = plan.techApprovalToken;
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await prisma.travelPlan.update({ where: { id: plan.id }, data: { techApprovalToken: token } }); }
    const t = ((): any => { try { return plan.techStage2 ? JSON.parse(plan.techStage2) : {}; } catch { return {}; } })();
    const totals = t?.totals || {};
    const grand = ['travel', 'food', 'hotel', 'other', 'misc'].reduce((s, k) => s + (Number(totals[k]) || 0), 0);
    // Advance the traveller already holds (plan advance + active New Advance).
    let raised = 0;
    if (plan.employeeId) {
      const advs = await prisma.pettyCashEntry.findMany({ where: { personId: plan.employeeId, category: 'Advance to Technician' } });
      raised = advs.filter((r) => !['VOID', 'REJECTED', 'PENDING_APPROVAL'].includes(r.status)).reduce((s, r) => s + (Number(r.sanctionedAmount ?? r.amount) || 0), 0);
    }
    const advReceived = (Number(plan.totalAdvance) || 0) + raised;
    const rupee = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
    const lines = [
      `Hi ${user.name},`,
      `A trip's expenses need your <strong>final approval</strong>.`,
      `Trip: <strong>${plan.planNumber}</strong> · ${plan.employeeName}`,
      `Advance received: <strong>${rupee(advReceived)}</strong>${raised > 0 ? ` <span style="color:#94a3b8">(incl. ${rupee(raised)} New Advance)</span>` : ''}`,
      `Amount approved so far (Stage 2): <strong>${rupee(grand)}</strong>`,
      `Open the Final-Approval Form to see the per-category stage breakdown and the day-wise spend, then Approve or Reject.`,
    ];
    const link = `${appBaseUrl()}/api/public/tech-approval/${token}`;
    const html = approvalEmailHtml({ heading: `Final approval needed — ${plan.planNumber}`, lines, actionUrl: link, actionLabel: 'Open Final Approval Form' });
    await sendEmail({ to: user.email, subject: `Final approval needed — ${plan.planNumber} · ${plan.employeeName}`, html });
  } catch { /* best-effort */ }
}

export async function decideTravelStep(planId: string, decision: 'APPROVED' | 'ON_HOLD', by: string | null, remark: string | null, linkStep?: number | null): Promise<StepOutcome> {
  const outcome = await decideStep(TRAVEL, planId, decision, remark, linkStep);
  if (outcome === 'STALE') return outcome;
  if (decision === 'ON_HOLD') {
    await prisma.travelPlan.update({ where: { id: planId }, data: { status: 'ON_HOLD', releaseStatus: 'ON_HOLD', releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
    return outcome;
  }
  if (outcome === 'ADVANCED') {
    await prisma.travelPlan.update({ where: { id: planId }, data: { releaseStatus: null, releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
  } else { // COMPLETED | NO_CHAIN
    await prisma.travelPlan.update({ where: { id: planId }, data: { status: 'APPROVED', releaseStatus: 'APPROVED', releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
  }
  return outcome;
}

// ── TRAVEL EXPENSE chain (docType 'TRAVEL_EXPENSE') ──────────────────────────

interface ExpenseLike { id: string; expenseNumber: string; planId: string; totalAmount: number; releaseToken: string | null; }

export async function buildExpenseSteps(exp: ExpenseLike, projectId: string | null): Promise<number> {
  return buildSteps(TRAVEL_EXPENSE, exp.id, projectId ?? '', exp.totalAmount ?? 0);
}

export async function notifyCurrentExpenseStep(exp: ExpenseLike, plan: PlanLike): Promise<void> {
  if (!isEmailEnabled()) return;
  try {
    let token = exp.releaseToken;
    if (!token) { token = crypto.randomBytes(24).toString('hex'); await prisma.travelExpense.update({ where: { id: exp.id }, data: { releaseToken: token } }); }
    const { emails, stepOrder } = await currentStepEmails(TRAVEL_EXPENSE, exp.id, plan.projectId ?? '', exp.totalAmount ?? 0);
    let to = emails;
    if (!to.length) { const cc = approvalCcEmail(); if (cc) to = [cc]; }
    if (!to.length) return;
    const link = `${appBaseUrl()}/api/public/travel-approval/${token}?type=expense&step=${stepOrder}`;
    const lines = [
      `The travel expense <strong>${exp.expenseNumber}</strong> for <strong>${plan.employeeName}</strong> (trip ${plan.planNumber}) needs your decision.`,
      `Total claimed: <strong>₹${Math.round(exp.totalAmount).toLocaleString('en-IN')}</strong>`,
      'Open the Approval Form to review each expense line + supporting documents and Approve or put it On Hold.',
    ];
    const html = approvalEmailHtml({ heading: `Travel expense approval — ${exp.expenseNumber}`, lines, actionUrl: link, actionLabel: 'Open Expense Approval Form' });
    try { await sendEmail({ to: [...new Set(to)].join(', '), cc: approvalCcEmail(), subject: `Travel expense approval — ${exp.expenseNumber} · ${plan.employeeName}`, html }); } catch { /* best-effort */ }
  } catch { /* best-effort */ }
}

export async function decideExpenseStep(expId: string, decision: 'APPROVED' | 'ON_HOLD', by: string | null, remark: string | null, linkStep?: number | null): Promise<StepOutcome> {
  const outcome = await decideStep(TRAVEL_EXPENSE, expId, decision, remark, linkStep);
  if (outcome === 'STALE') return outcome;
  if (decision === 'ON_HOLD') {
    await prisma.travelExpense.update({ where: { id: expId }, data: { status: 'ON_HOLD', releaseStatus: 'ON_HOLD', releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
    return outcome;
  }
  if (outcome === 'ADVANCED') {
    await prisma.travelExpense.update({ where: { id: expId }, data: { releaseStatus: null, releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
  } else { // COMPLETED | NO_CHAIN → fully approved
    await prisma.travelExpense.update({ where: { id: expId }, data: { status: 'APPROVED', releaseStatus: 'APPROVED', releaseAt: new Date(), releaseBy: by, releaseRemark: remark } });
  }
  return outcome;
}
