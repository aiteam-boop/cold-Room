// Sequential approval-chain engine, shared by the PO/WO/GRN routes AND the
// one-click email-link endpoint. Manages ApprovalStep + ApprovalAction rows and
// runs the document-specific finalize side-effects on the last approval.

import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { notifyUser } from './notify';
import { sendEmail, approvalEmailHtml, approvalDocEmailHtml, appBaseUrl, appClientUrl, isEmailEnabled, approvalCcEmail } from './email';
import { buildMilestones, normalizeTermsSections } from './procurement';
import { renderProcurementPdf, renderGRNPdf, renderToBuffer } from './procurementPdf';
import { parseApprover, approverHandlesType, approvalTypeForDoc, type ApprovalType } from '../lib/permissions';
import { isAdmin } from '../lib/enums';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

export type DocType = 'PO' | 'WO' | 'TO' | 'GRN' | 'PAYMENT';

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
/** One post-approval amendment: the reason the raiser gave when they changed it. */
export interface DocAmendment { remark: string; byName: string; at: string }

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
  // Amendments made after a previous approval. A document only carries these once
  // it has been amended and sent back, so a non-empty list means THIS approval is
  // a re-approval — the approver must see why, and what was changed.
  amendments: DocAmendment[];
  // Budget vs Actual for a PO/WO (BOQ & Budget PRD §5): what each BOQ item was
  // budgeted at vs what this document spends on it, so the approver sees the
  // variance right in the approval. Empty when nothing is budgeted/compared.
  budget?: BudgetRow[];
  // Per-payment-term Proforma Invoices uploaded on the PO, so the approver can
  // see each term's PI (number / value / link) while approving.
  termPis?: { term: string; piNumber: string | null; piValue: number | null; piPdfPath: string | null }[];
}

export interface BudgetRow {
  description: string;
  budget: number | null;
  actual: number | null;
  variance: number | null;
  variancePct: number | null;
  wholePo?: boolean;
}

// Compute the Budget-vs-Actual rows for a PO/WO — the same view as the builder's
// panel: line-linked BOQ items plus the ones the raiser picked to compare, each
// with its frozen budget and this document's spend on it.
async function budgetRowsForDoc(
  projectId: string,
  lineItems: { boqItemId: string | null; qty: number; unitPrice: number }[],
  budgetCompareJson: string | null,
  poBasic: number,
): Promise<BudgetRow[]> {
  const linkedIds = [...new Set(lineItems.filter((l) => l.boqItemId).map((l) => l.boqItemId as string))];
  let compareIds: string[] = [];
  try { const a = budgetCompareJson ? JSON.parse(budgetCompareJson) : []; if (Array.isArray(a)) compareIds = a; } catch { /* */ }
  const ids = [...new Set([...linkedIds, ...compareIds])];
  if (!ids.length) return [];

  const [budgetLines, items] = await Promise.all([
    prisma.bOQBudgetLine.findMany({ where: { projectId, boqItemId: { in: ids } }, select: { boqItemId: true, budgetAmount: true } }),
    prisma.bOQItem.findMany({ where: { id: { in: ids } }, select: { id: true, description: true } }),
  ]);
  const budgetBy = new Map(budgetLines.map((b) => [b.boqItemId, b.budgetAmount]));
  const descBy = new Map(items.map((i) => [i.id, i.description]));
  const noLinks = linkedIds.length === 0;

  const rows: BudgetRow[] = [];
  for (const id of ids) {
    const budget = budgetBy.get(id) ?? null;
    const linked = lineItems.filter((l) => l.boqItemId === id).reduce((s, l) => s + (Number(l.qty) * Number(l.unitPrice) || 0), 0);
    // Same fallback as the builder: a compare-only item on a PO with no line links
    // is measured against the whole PO, so the variance is still visible.
    const isCompareOnly = !linkedIds.includes(id);
    const actual = linked > 0 ? linked : (isCompareOnly && noLinks ? poBasic : 0);
    const wholePo = actual > 0 && linked === 0;
    const variance = budget != null && actual > 0 ? Math.round((actual - budget) * 100) / 100 : null;
    const variancePct = variance != null && budget ? Math.round((variance / budget) * 1000) / 10 : null;
    rows.push({ description: descBy.get(id) ?? '—', budget, actual: actual || null, variance, variancePct, wholePo });
  }
  // Only worth showing if at least one row has a budget to compare against.
  return rows.some((r) => r.budget != null) ? rows : [];
}

// `amendments` is stored as a JSON array of { at, byId, byName, byEmail, remark }.
// Oldest → newest; the last entry is the reason for the current resubmission.
export function parseAmendments(json: string | null | undefined): DocAmendment[] {
  try {
    const arr = json ? JSON.parse(json) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a) => a && typeof a.remark === 'string' && a.remark.trim())
      .map((a) => ({ remark: String(a.remark), byName: String(a.byName || 'User'), at: String(a.at || '') }));
  } catch { return []; }
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
      amendments: parseAmendments(g.amendments),
    };
  }
  if (docType === 'PAYMENT') {
    const p = await prisma.vendorPayment.findUnique({ where: { id: docId }, select: { paymentNumber: true, projectId: true } });
    if (!p) return null;
    return { label: 'Payment', docLabelLong: 'Vendor Payment', number: p.paymentNumber, vendorName: null, projectName: null, totalLabel: 'Amount', totalAmount: null, rows: [], pdfPath: null, projectId: p.projectId, amendments: [] };
  }
  const d = await prisma.procurementDoc.findUnique({
    where: { id: docId },
    include: { lineItems: { where: { isLeadTime: false }, orderBy: { sortOrder: 'asc' } }, project: { select: { name: true } } },
  });
  if (!d) return null;
  const poBasic = d.lineItems.reduce((s, l) => s + (Number(l.qty) * Number(l.unitPrice) || 0), 0);
  const budget = await budgetRowsForDoc(
    d.projectId,
    d.lineItems.map((l) => ({ boqItemId: l.boqItemId ?? null, qty: l.qty, unitPrice: l.unitPrice })),
    d.budgetCompareItemIds,
    poBasic,
  );
  return {
    label: d.type, docLabelLong: d.type === 'WO' ? 'Work Order' : d.type === 'TO' ? 'Transport Order' : 'Purchase Order', number: d.docNumber,
    vendorName: d.vendorName, projectName: d.project?.name ?? null,
    totalLabel: 'Final Amount', totalAmount: Math.round(d.finalAmount),
    rows: d.lineItems.map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice, total: l.totalPrice })),
    pdfPath: `/api/projects/${d.projectId}/procurement/docs/${d.id}/pdf`, projectId: d.projectId,
    amendments: parseAmendments(d.amendments),
    budget,
    termPis: parseTermPis(d.termPis),
  };
}

// Parse the PO's per-term Proforma Invoices into the approver-facing list.
const TERM_NAMES: Record<string, string> = { advance: 'Advance', beforeDelivery: 'Before Delivery', running: 'Running', postDelivery: 'Post Delivery', postCompletion: 'Post Completion', retention: 'Retention' };
function parseTermPis(json: string | null | undefined): { term: string; piNumber: string | null; piValue: number | null; piPdfPath: string | null }[] {
  let raw: Record<string, any> = {};
  try { raw = json ? JSON.parse(json) : {}; } catch { return []; }
  return Object.entries(raw)
    .filter(([, v]) => v && (v.piPdfUrl || v.piNumber || v.piValue != null))
    .map(([k, v]: [string, any]) => ({ term: TERM_NAMES[k] || k, piNumber: v.piNumber ?? null, piValue: v.piValue ?? null, piPdfPath: v.piPdfUrl ?? null }));
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
  // Loaded up front so the in-app notification — not just the email — can say
  // WHY a re-approval is being asked for.
  const data = await approvalDocData(step.docType as DocType, step.docId);
  const latestAmendment = data?.amendments?.length ? data.amendments[data.amendments.length - 1] : null;

  const title = kind === 'REMINDER'
    ? `Reminder: ${doc.label} ${doc.number} awaiting approval`
    : latestAmendment
      ? `Re-approval needed: ${doc.label} ${doc.number} (amended)`
      : `Approval needed: ${doc.label} ${doc.number}`;
  const message = latestAmendment
    ? `${doc.label} ${doc.number} was amended after approval and resubmitted. Reason: “${latestAmendment.remark}” — ${latestAmendment.byName}.`
    : `${doc.label} ${doc.number} is awaiting your approval.`;
  // Link to the self-contained Approvals page — the approver may not be a member
  // of the document's project, so we must NOT send them to the project workspace.
  await notifyUser(step.approverId, { type: 'APPROVAL_PENDING', title, message, projectId: doc.projectId, relatedDocType: step.docType, relatedDocId: step.docId, link: '/approvals' });
  if (!isEmailEnabled() || !step.approverEmail) return;

  const token = signApprovalToken({ stepId: step.id, docType: step.docType as DocType, docId: step.docId, approverId: step.approverId });
  const base = `${appBaseUrl()}/api/approvals/act?token=${encodeURIComponent(token)}`;

  // Rich email with the document summary + a full-PDF review page. Fall back to
  // the plain template if the document can't be loaded for some reason.
  if (data) {
    const total = await prisma.approvalStep.count({ where: { docType: step.docType, docId: step.docId } });
    const stage = step.order ? `${step.approverRole || 'Approver'} · step ${step.order} of ${total}` : (step.approverRole || null);
    // No PDF attachment: the full document is shown on the review page that the
    // Approve / Reject buttons open (helper buildApprovalPdf is kept for reuse).
    await sendEmail({
      to: step.approverEmail,
      // The auditor is copied on every approval email (PO/WO/GRN/payment).
      cc: approvalCcEmail(),
      subject: title,
      html: approvalDocEmailHtml({
        label: data.label, docLabelLong: data.docLabelLong, number: data.number,
        vendorName: data.vendorName, projectName: data.projectName, stage,
        totalLabel: data.totalLabel, totalAmount: data.totalAmount, rows: data.rows,
        approverName: step.approverName,
        // The secure review page (full PDF, no login needed) — the Approve and
        // On Hold buttons live there, so the email only has to get them to it.
        viewUrl: base,
        // The app itself, which asks the approver to sign in.
        reviewUrl: `${appClientUrl()}/approvals`,
        reminder: kind === 'REMINDER',
        // Why it is back for approval — the reason given when it was amended.
        amendments: data.amendments,
        // Budget vs Actual for the approver (PRD §5).
        budget: data.budget,
        // Per-payment-term Proforma Invoices, linked so the approver can open them.
        termPis: (data.termPis || []).map((t) => ({ term: t.term, piNumber: t.piNumber, piValue: t.piValue, piUrl: t.piPdfPath ? `${appBaseUrl()}${t.piPdfPath}` : null })),
      }),
    });
    return;
  }
  await sendEmail({
    to: step.approverEmail, cc: approvalCcEmail(), subject: title,
    html: approvalEmailHtml({ heading: title, lines: [`Hi ${step.approverName},`, message, 'Review and record your decision using the button below.'], actionUrl: base, actionLabel: 'Review & Approve' }),
  });
}

// ── Build the chain on submit ────────────────────────────────────────────────
// The chain may be given as a flat list of approver ids (one per step, the
// classic sequential chain) or as GROUPS — each inner array is one step that may
// hold several approvers, any one of whom can approve it (Approval Chain · same
// order). A flat list is treated as one approver per step.
export async function buildChain(docType: DocType, docId: string, projectId: string, chain: string[] | string[][], actor: ActorInfo) {
  const groups: string[][] = (Array.isArray(chain[0]) ? chain as string[][] : (chain as string[]).map((id) => [id]))
    .map((g) => g.filter(Boolean))
    .filter((g) => g.length);
  const flat = groups.flat();
  if (!flat.length) throw new Error('Select at least one approver for the chain.');
  const type = approvalTypeFor(docType);
  const users = await prisma.user.findMany({ where: { id: { in: flat }, active: true }, select: { id: true, name: true, email: true, approver: true, role: true } });
  const byId = new Map(users.map((u) => [u.id, u]));

  // One row per approver. Everyone in group `gi` shares order gi+1; the whole
  // first group is PENDING (all notified at once), later groups WAITING. A person
  // is placed once, at their earliest group. Admins may approve any doc type.
  const placed = new Set<string>();
  const rows = groups.flatMap((group, gi) =>
    group.flatMap((id) => {
      if (placed.has(id)) return [];
      placed.add(id);
      const u = byId.get(id);
      if (!u) throw new Error('An approver in the chain no longer exists.');
      const prof = parseApprover(u.approver);
      const admin = isAdmin(u.role);
      if (!admin && !approverHandlesType(prof, type)) throw new Error(`${u.name} is not authorised to approve ${type}.`);
      return [{ order: gi + 1, approverId: u.id, approverName: u.name, approverEmail: u.email, approverRole: prof.approvalRole || (admin ? 'Admin' : null), status: gi === 0 ? 'PENDING' : 'WAITING' }];
    }),
  );

  // Clear any prior chain (re-submit) then create fresh.
  await prisma.approvalStep.deleteMany({ where: { docType, docId } });
  await prisma.approvalStep.createMany({ data: rows.map((s) => ({ ...s, docType, docId, projectId })) });
  await logAction(docType, docId, null, actor, 'SUBMITTED');

  // Notify every approver on the first step (any one of them can approve it).
  const doc = await docSummary(docType, docId);
  const firstSteps = await prisma.approvalStep.findMany({ where: { docType, docId, order: 1 } });
  if (doc) for (const s of firstSteps) await notifyStep(s, doc, 'NEW');
  refreshCeoApprovalSheet();
}

// Mirror the Director's live pending queue to the "CEO Approvals" sheet whenever the
// chain changes (submit / approve / hold). Fire-and-forget — a slow or failed sheet
// write must never block an approval. Dynamic import avoids a static import cycle.
export function refreshCeoApprovalSheet(): void {
  import('./sheetsSync').then((m) => m.exportCeoApprovals()).catch(() => { /* best-effort */ });
}

// ── Chain state (for the timeline) ───────────────────────────────────────────
export async function getChainState(docType: DocType, docId: string) {
  const [steps, actions] = await Promise.all([
    prisma.approvalStep.findMany({ where: { docType, docId }, orderBy: { order: 'asc' } }),
    prisma.approvalAction.findMany({ where: { docType, docId }, orderBy: { at: 'asc' } }),
  ]);
  // A step = all rows sharing an `order`. Count/current are computed per STEP so
  // an any-one-approves step (2+ people, one order) counts once.
  const pending = steps.filter((s) => s.status === 'PENDING');
  const currentOrder = pending.length ? Math.min(...pending.map((s) => s.order)) : null;
  const currentGroup = currentOrder != null ? pending.filter((s) => s.order === currentOrder) : [];
  const orders = [...new Set(steps.map((s) => s.order))];
  const approved = orders.filter((o) => steps.some((s) => s.order === o && s.status === 'APPROVED')).length;
  return {
    steps, actions,
    currentStepId: currentGroup[0]?.id ?? null,
    currentApproverId: currentGroup[0]?.approverId ?? null,
    // Everyone who can act on the current step — the client checks membership so
    // BOTH people on a shared step see the Approve button.
    currentApproverIds: currentGroup.map((s) => s.approverId),
    approved, total: orders.length,
  };
}

export type Outcome = 'ADVANCED' | 'COMPLETED' | 'ON_HOLD';

// A document is never "rejected" outright: an approver who spots a mistake puts
// it ON HOLD with a note saying what to correct. The raiser fixes it and
// resubmits — the document stays alive, and the note travels with it.
//
// Record an approve/hold on the CURRENT step. Authorises actor = current
// approver, or an admin override. Returns the outcome; the caller finalizes.
export async function recordDecision(docType: DocType, docId: string, actor: ActorInfo, decision: 'APPROVE' | 'HOLD', remarks?: string): Promise<Outcome> {
  const steps = await prisma.approvalStep.findMany({ where: { docType, docId }, orderBy: { order: 'asc' } });
  const pending = steps.filter((s) => s.status === 'PENDING');
  if (!pending.length) throw new Error('There is no pending approval step for this document.');

  // The current STEP is every pending row at the lowest pending order — a step
  // may hold several approvers, any one of whom can act on it.
  const currentOrder = Math.min(...pending.map((s) => s.order));
  const group = pending.filter((s) => s.order === currentOrder);
  // The acting user's own row in the step (admins may act on behalf of the step).
  const mine = group.find((s) => s.approverId === actor.id);
  if (!mine && !actor.isAdmin) throw new Error('Only the current approver can act on this step.');
  const acting = mine ?? group[0];

  const doc = await docSummary(docType, docId);

  if (decision === 'HOLD') {
    await prisma.approvalStep.update({ where: { id: acting.id }, data: { status: 'ON_HOLD', actedAt: new Date(), remarks: remarks ?? null } });
    await logAction(docType, docId, acting.id, actor, 'ON_HOLD', remarks);
    if (doc?.createdById) await notifyUser(doc.createdById, { type: 'APPROVAL_ON_HOLD', title: `${doc.label} ${doc.number} put on hold`, message: `${actor.name} put it on hold — please correct and resubmit${remarks ? `: ${remarks}` : '.'}`, projectId: doc.projectId, relatedDocType: docType, relatedDocId: docId, link: doc.link });
    refreshCeoApprovalSheet();
    return 'ON_HOLD';
  }

  await prisma.approvalStep.update({ where: { id: acting.id }, data: { status: 'APPROVED', actedAt: new Date(), remarks: remarks ?? null } });
  await logAction(docType, docId, acting.id, actor, 'APPROVED', remarks);
  // Any-one-approves: the other approvers on this step are no longer needed.
  const peers = group.filter((s) => s.id !== acting.id);
  if (peers.length) await prisma.approvalStep.updateMany({ where: { id: { in: peers.map((p) => p.id) } }, data: { status: 'SKIPPED', actedAt: new Date() } });
  refreshCeoApprovalSheet();   // the Director's queue changed (advanced to / away from them)

  // Advance to the next step: promote every row at the next-highest order and
  // notify all of them at once.
  const higher = steps.filter((s) => s.order > currentOrder);
  if (higher.length) {
    const nextOrder = Math.min(...higher.map((s) => s.order));
    const nextGroup = higher.filter((s) => s.order === nextOrder);
    await prisma.approvalStep.updateMany({ where: { id: { in: nextGroup.map((s) => s.id) } }, data: { status: 'PENDING' } });
    if (doc) for (const s of nextGroup) await notifyStep(s, doc, 'NEW');
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

// ── Automatic 24-hour reminders ──────────────────────────────────────────────
// A document that sits with an approver for REMINDER_HOURS (default 24) since it
// was submitted — or since the last reminder — nudges that approver again. Only
// the CURRENT pending step is reminded (that's whose turn it is). `lastRemindedAt`
// makes it idempotent, so the same person is never emailed twice inside a window
// even if the poll runs more frequently.
const REMINDER_HOURS = Number(process.env.APPROVAL_REMINDER_HOURS || 24);

// When the current approver would next be auto-reminded — for the countdown shown
// in the approvals queue. Same reference the reminder job uses (last reminder, or
// submission if never reminded).
export function nextReminderAt(step: { lastRemindedAt?: Date | null; createdAt: Date }): Date {
  return new Date((step.lastRemindedAt ?? step.createdAt).getTime() + REMINDER_HOURS * 3600_000);
}
// Whether auto-reminders actually run (off in local dev via APPROVAL_REMINDERS=off).
export const remindersEnabled = () => process.env.APPROVAL_REMINDERS !== 'off' && isEmailEnabled();

export async function sendDueApprovalReminders(opts: { now?: Date; dryRun?: boolean } = {}): Promise<{ due: number; sent: number }> {
  const now = opts.now ?? new Date();
  const cutoffMs = REMINDER_HOURS * 3600_000;
  // Without a mailer configured there is nothing to send; skip the whole scan.
  if (!opts.dryRun && !isEmailEnabled()) return { due: 0, sent: 0 };
  const pending = await prisma.approvalStep.findMany({ where: { status: 'PENDING' } });
  let due = 0;
  let sent = 0;
  for (const s of pending) {
    const ref = s.lastRemindedAt ?? s.createdAt;
    if (now.getTime() - new Date(ref).getTime() < cutoffMs) continue;
    due++;
    if (opts.dryRun) continue;
    const doc = await docSummary(s.docType as DocType, s.docId);
    if (!doc) continue; // document was deleted out from under the step — skip
    await notifyStep(s, doc, 'REMINDER');
    await prisma.approvalStep.update({ where: { id: s.id }, data: { lastRemindedAt: now } });
    sent++;
  }
  return { due, sent };
}

// Background poll that fires the reminders. Disabled when APPROVAL_REMINDERS=off
// (used in local dev so it never emails real approvers). First run 60s after
// boot, then every APPROVAL_REMINDER_POLL_MS (default hourly). The per-step
// 24-hour gate above means the actual cadence is still once a day.
export function startApprovalReminderPoll() {
  if (process.env.APPROVAL_REMINDERS === 'off') { console.log('Approval reminders: disabled (APPROVAL_REMINDERS=off)'); return; }
  const interval = Number(process.env.APPROVAL_REMINDER_POLL_MS) || 3600_000;
  const tick = () => sendDueApprovalReminders()
    .then((r) => { if (r.sent) console.log(`Approval reminders: sent ${r.sent} of ${r.due} due`); })
    .catch((e) => console.error('[approval-reminder]', e));
  setTimeout(tick, 60_000);
  setInterval(tick, interval);
}

// Email the person who RAISED the document that it is now fully approved, with
// the approved PDF attached. The auditor is copied by default — same policy as
// the approval-request emails. Best-effort: a mail failure must never break
// finalization (the in-app notification has already been recorded).
async function emailCreatorApproved(opts: { createdById: string | null; docType: DocType; docId: string; label: string; number: string; projectId: string }) {
  if (!opts.createdById || !isEmailEnabled()) return;
  try {
    const creator = await prisma.user.findUnique({ where: { id: opts.createdById }, select: { name: true, email: true } });
    if (!creator?.email) return;
    const heading = `${opts.label} ${opts.number} approved`;
    const attach = await buildApprovalPdf(opts.docType, opts.docId).catch(() => null);
    await sendEmail({
      to: creator.email,
      // Auditor copied by default on every approval outcome (PO/WO/GRN/payment).
      cc: approvalCcEmail(),
      subject: heading,
      html: approvalEmailHtml({
        heading,
        lines: [
          `Hi ${creator.name || 'there'},`,
          `Your ${opts.label} <b>${opts.number}</b> has been fully approved.`,
          attach ? 'The approved document is attached. You can also open it in the app.' : 'You can open it in the app.',
        ],
        actionUrl: `${appClientUrl()}/projects/${opts.projectId}`,
        actionLabel: 'Open in CRMCTS',
      }),
      attachments: attach ? [{ filename: attach.filename, content: attach.buffer, contentType: 'application/pdf' }] : undefined,
    });
  } catch (e) {
    console.error('[emailCreatorApproved] failed:', e);
  }
}

// ── Finalize (document-specific side-effects on last approval) ───────────────
// Called by the route/email endpoint when recordDecision returns 'COMPLETED'.
export async function finalizeApproval(docType: DocType, docId: string, actorId: string) {
  if (docType === 'PAYMENT') {
    const p = await prisma.vendorPayment.findUnique({ where: { id: docId } });
    if (!p) return;
    await prisma.vendorPayment.update({ where: { id: p.id }, data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() } });
    if (p.filledById) await notifyUser(p.filledById, { type: 'PAYMENT_APPROVED', title: 'Payment approved', message: `${p.paymentNumber} has been fully approved.`, projectId: p.projectId, relatedDocType: 'VendorPayment', relatedDocId: p.id, link: `/projects/${p.projectId}` });
    await emailCreatorApproved({ createdById: p.filledById, docType: 'PAYMENT', docId: p.id, label: 'Payment', number: p.paymentNumber, projectId: p.projectId });
    return;
  }
  if (docType === 'GRN') {
    const grn = await prisma.gRN.findUnique({ where: { id: docId } });
    if (!grn) return;
    await prisma.gRN.update({ where: { id: grn.id }, data: { status: 'APPROVED', approvedById: actorId, approvedAt: new Date() } });
    await prisma.procurementDocument.create({ data: { projectId: grn.projectId, type: 'GRN', fileName: `${grn.grnNumber}.pdf`, fileUrl: `/api/projects/${grn.projectId}/procurement/grns/${grn.id}/pdf`, linkedDocNumber: grn.grnNumber, vendorName: grn.vendorName, uploadedById: actorId } });
    if (grn.raisedById) await notifyUser(grn.raisedById, { type: 'GRN_APPROVED', title: 'GRN approved', message: `${grn.grnNumber} has been fully approved.`, projectId: grn.projectId, relatedDocType: 'GRN', relatedDocId: grn.id, link: `/projects/${grn.projectId}` });
    await emailCreatorApproved({ createdById: grn.raisedById, docType: 'GRN', docId: grn.id, label: 'GRN', number: grn.grnNumber, projectId: grn.projectId });
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
  await emailCreatorApproved({ createdById: doc.createdById, docType: doc.type as DocType, docId: doc.id, label: doc.type, number: doc.docNumber, projectId: doc.projectId });
}

// Put the parent document ON HOLD, carrying the approver's note about what needs
// correcting. ON_HOLD is an editable state everywhere — the raiser fixes the
// document and resubmits it, rather than the document being dead. `rejectionReason`
// is the existing column that now holds the "what to correct" note.
export async function markDocOnHold(docType: DocType, docId: string, reason: string) {
  const data = { status: 'ON_HOLD', rejectionReason: reason };
  if (docType === 'PAYMENT') {
    await prisma.vendorPayment.update({ where: { id: docId }, data });
  } else if (docType === 'GRN') {
    await prisma.gRN.update({ where: { id: docId }, data });
  } else {
    await prisma.procurementDoc.update({ where: { id: docId }, data });
  }
}
