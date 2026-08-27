import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requirePage, requireEdit, requireSection } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { renderPettyCashPdf } from '../services/pettyCashPdf';

// ── Petty Cash — site-manager cash float + expense ledger ────────────────────
// The custodian records expenses (RECORDED) and submits them to Accounts
// (SUBMITTED); Accounts confirm (CONFIRMED) or reject & resend (REJECTED). A
// TOPUP just adds to the float. Company-wide float; entries may carry a projectId
// so the same ledger can be filtered per project. Mounted at /api/petty-cash.
const router = Router();
router.use(requireAuth);

// Ledger heads shown in the "Record expense" dropdown (client mirrors this list).
export const PETTY_CATEGORIES = [
  'Advance to Technician',
  'Spare Parts Purchase (Reefer/Depot Related)',
  'Travel / Local Conveyance (taxi, bus, auto, etc.)',
  'Security Deposit for Spare Parts (Consumable)',
  'Courier / Postage / Delivery Charges',
  'Vendor / Labour Payments (Small Cash Settlements)',
  'Staff Welfare (Snacks, Refreshments, Beverages for Staff/Clients)',
  'Miscellaneous / Other Expenses',
];

const parseArr = (s: string | null | undefined): any[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };
const serialize = (e: any) => ({ ...e, trail: parseArr(e.trail), comments: parseArr(e.comments), documents: parseArr(e.documents) });

async function nextPettyNumber(): Promise<string> {
  const rows = await prisma.pettyCashEntry.findMany({ select: { entryNumber: true } });
  let max = 0;
  for (const r of rows) { const m = /(\d+)\s*$/.exec(r.entryNumber || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `PETTY-${String(max + 1).padStart(5, '0')}`;
}
function withTrail(entry: any, action: string, byName: string, remark?: string | null): string {
  const trail = parseArr(entry.trail);
  trail.push({ at: new Date().toISOString(), action, byName, remark: remark ?? null });
  return JSON.stringify(trail);
}
async function loadEntry(id: string) {
  const e = await prisma.pettyCashEntry.findUnique({ where: { id } });
  if (!e) throw notFound('Entry not found');
  return e;
}

// ── GET / — ledger (filtered) + summary KPIs ─────────────────────────────────
router.get('/', requirePage('pettycash'), asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string>;
  const where: any = {};
  if (q.type && ['EXPENSE', 'TOPUP'].includes(q.type)) where.type = q.type;
  if (q.status) where.status = q.status;
  if (q.projectId) where.projectId = q.projectId;
  if (q.from || q.to) { where.date = {}; if (q.from) where.date.gte = new Date(q.from); if (q.to) where.date.lte = new Date(q.to + 'T23:59:59.999'); }

  let entries = await prisma.pettyCashEntry.findMany({ where, orderBy: { date: 'desc' } });
  if (q.search) {
    const needle = q.search.toLowerCase();
    entries = entries.filter((e) => [e.entryNumber, e.category, e.paidTo, e.technician, e.jobOrder, e.description].filter(Boolean).some((s: any) => String(s).toLowerCase().includes(needle)));
  }

  // KPIs computed over the whole ledger (project-scoped if a project filter is on).
  const all = await prisma.pettyCashEntry.findMany({ where: q.projectId ? { projectId: q.projectId } : {} });
  const sum = (arr: any[]) => Math.round(arr.reduce((s, e) => s + (e.amount || 0), 0) * 100) / 100;
  const expenses = all.filter((e) => e.type === 'EXPENSE' && e.status !== 'VOID');
  const topups = all.filter((e) => e.type === 'TOPUP' && e.status !== 'VOID');
  const confirmed = expenses.filter((e) => e.status === 'CONFIRMED');
  const pending = expenses.filter((e) => e.status === 'RECORDED' || e.status === 'SUBMITTED' || e.status === 'REJECTED');
  const summary = {
    cashOnHand: sum(topups) - sum(expenses),
    expensesTotal: sum(expenses), expensesCount: expenses.length,
    confirmedTotal: sum(confirmed), confirmedCount: confirmed.length,
    pendingTotal: sum(pending), pendingCount: pending.length,
    transactions: all.length,
    topupsTotal: sum(topups), topupsCount: topups.length,
  };

  // Month-by-month: opening balance carried into the 1st, that month's top-ups &
  // expenses, and the closing cash. Opening of a month = closing of the previous.
  const byMonth: Record<string, { topups: number; expenses: number }> = {};
  for (const e of all) {
    if (e.status === 'VOID') continue;
    const d = new Date(e.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    (byMonth[key] ||= { topups: 0, expenses: 0 });
    if (e.type === 'TOPUP') byMonth[key].topups += e.amount || 0; else byMonth[key].expenses += e.amount || 0;
  }
  let opening = 0;
  const monthly = Object.keys(byMonth).sort().map((m) => {
    const { topups: t, expenses: x } = byMonth[m];
    const closing = Math.round((opening + t - x) * 100) / 100;
    const row = { month: m, opening, topups: Math.round(t * 100) / 100, expenses: Math.round(x * 100) / 100, closing };
    opening = closing;
    return row;
  });

  res.json({ entries: entries.map(serialize), summary, monthly, categories: PETTY_CATEGORIES });
}));

// ── Bulk: submit every RECORDED expense to accounts at once ───────────────────
router.post('/submit-all', requireEdit('pettycash'), asyncHandler(async (req, res) => {
  const u = req.user!;
  const recorded = await prisma.pettyCashEntry.findMany({ where: { type: 'EXPENSE', status: 'RECORDED' } });
  for (const e of recorded) {
    await prisma.pettyCashEntry.update({ where: { id: e.id }, data: { status: 'SUBMITTED', trail: withTrail(e, 'Submitted to accounts (bulk)', u.name) } });
  }
  await audit({ userId: u.sub, action: 'PETTY_SUBMIT_ALL', entity: 'PettyCashEntry', details: { count: recorded.length } });
  res.json({ submitted: recorded.length });
}));

// ── Ledger PDF (respects the same filters) ───────────────────────────────────
router.get('/pdf', requirePage('pettycash'), asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string>;
  const where: any = {};
  if (q.type && ['EXPENSE', 'TOPUP'].includes(q.type)) where.type = q.type;
  if (q.status) where.status = q.status;
  if (q.projectId) where.projectId = q.projectId;
  if (q.from || q.to) { where.date = {}; if (q.from) where.date.gte = new Date(q.from); if (q.to) where.date.lte = new Date(q.to + 'T23:59:59.999'); }
  let entries = await prisma.pettyCashEntry.findMany({ where, orderBy: { date: 'desc' } });
  if (q.search) { const n = q.search.toLowerCase(); entries = entries.filter((e) => [e.entryNumber, e.category, e.paidTo, e.technician, e.jobOrder, e.description].filter(Boolean).some((x: any) => String(x).toLowerCase().includes(n))); }
  const all = await prisma.pettyCashEntry.findMany({ where: q.projectId ? { projectId: q.projectId } : {} });
  const sum = (arr: any[]) => Math.round(arr.reduce((s, e) => s + (e.amount || 0), 0) * 100) / 100;
  const expenses = all.filter((e) => e.type === 'EXPENSE' && e.status !== 'VOID');
  const topups = all.filter((e) => e.type === 'TOPUP' && e.status !== 'VOID');
  const summary = { cashOnHand: sum(topups) - sum(expenses), expensesTotal: sum(expenses), confirmedTotal: sum(expenses.filter((e) => e.status === 'CONFIRMED')), pendingTotal: sum(expenses.filter((e) => ['RECORDED', 'SUBMITTED', 'REJECTED'].includes(e.status))), topupsTotal: sum(topups) };
  const cfg = await prisma.pettyCashConfig.findFirst({ where: { projectId: null } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="petty-cash-ledger.pdf"');
  renderPettyCashPdf({ entries, summary, custodian: cfg?.custodianName ?? null, generatedAt: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }) }, res);
}));

// ── Custodian config (company-wide) ──────────────────────────────────────────
router.get('/config', requirePage('pettycash'), asyncHandler(async (_req, res) => {
  const config = await prisma.pettyCashConfig.findFirst({ where: { projectId: null } });
  res.json({ config });
}));
router.put('/config', requireEdit('pettycash'), asyncHandler(async (req, res) => {
  const b = z.object({ custodianName: z.string().nullable().optional(), custodianEmail: z.string().nullable().optional() }).parse(req.body ?? {});
  const existing = await prisma.pettyCashConfig.findFirst({ where: { projectId: null } });
  const config = existing
    ? await prisma.pettyCashConfig.update({ where: { id: existing.id }, data: { custodianName: b.custodianName ?? undefined, custodianEmail: b.custodianEmail ?? undefined } })
    : await prisma.pettyCashConfig.create({ data: { projectId: null, custodianName: b.custodianName ?? null, custodianEmail: b.custodianEmail ?? null } });
  res.json({ config });
}));

// ── Record an expense (custodian) — 3 optional file uploads ──────────────────
const expenseFiles = upload.fields([{ name: 'invoice', maxCount: 1 }, { name: 'budget', maxCount: 1 }, { name: 'payment', maxCount: 1 }]);
router.post('/expense', requireEdit('pettycash'), expenseFiles, asyncHandler(async (req, res) => {
  const b = z.object({
    category: z.string().min(1),
    amount: z.coerce.number().positive(),
    date: z.string().optional(),
    technician: z.string().optional(),
    paidTo: z.string().optional(),
    projectId: z.string().nullable().optional(),
    jobOrder: z.string().optional(),
    description: z.string().min(1),
  }).parse(req.body);
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const fileUrl = (k: string) => (files?.[k]?.[0] ? `/uploads/${files[k][0].filename}` : null);
  const now = new Date().toISOString();
  const seedDoc = (field: string, kind: string) => (files?.[field]?.[0] ? { kind, fileName: files[field][0].originalname, fileUrl: fileUrl(field), at: now } : null);
  const docs = [seedDoc('invoice', 'Bill'), seedDoc('budget', 'Budget'), seedDoc('payment', 'Payment')].filter(Boolean);
  const cfg = await prisma.pettyCashConfig.findFirst({ where: { projectId: null } });
  const u = req.user!;
  const entry = await prisma.pettyCashEntry.create({
    data: {
      entryNumber: await nextPettyNumber(), type: 'EXPENSE', date: b.date ? new Date(b.date) : new Date(),
      category: b.category, amount: b.amount, technician: b.technician || null, paidTo: b.paidTo || null,
      projectId: b.projectId || null, jobOrder: b.jobOrder || null, description: b.description,
      invoiceUrl: fileUrl('invoice'), budgetUrl: fileUrl('budget'), paymentUrl: fileUrl('payment'),
      documents: docs.length ? JSON.stringify(docs) : null,
      status: 'RECORDED', custodianName: cfg?.custodianName ?? null, custodianEmail: cfg?.custodianEmail ?? null,
      recordedById: u.sub, recordedByName: u.name,
      trail: JSON.stringify([{ at: new Date().toISOString(), action: 'Expense recorded', byName: u.name, remark: null }]),
    },
  });
  await audit({ userId: u.sub, projectId: b.projectId || undefined, action: 'PETTY_EXPENSE_CREATE', entity: 'PettyCashEntry', entityId: entry.id, details: { entryNumber: entry.entryNumber, amount: b.amount } });
  res.status(201).json({ entry: serialize(entry) });
}));

// ── Add a float top-up (money handed to the custodian) ───────────────────────
router.post('/topup', requireEdit('pettycash'), asyncHandler(async (req, res) => {
  const b = z.object({ amount: z.coerce.number().positive(), reason: z.string().optional(), date: z.string().optional(), utrNumber: z.string().optional(), description: z.string().optional() }).parse(req.body);
  const u = req.user!;
  const entry = await prisma.pettyCashEntry.create({
    data: {
      entryNumber: await nextPettyNumber(), type: 'TOPUP', date: b.date ? new Date(b.date) : new Date(),
      amount: b.amount, reason: b.reason || 'Float', utrNumber: b.utrNumber || null, description: b.description || null,
      status: 'CONFIRMED', recordedById: u.sub, recordedByName: u.name,
      trail: JSON.stringify([{ at: new Date().toISOString(), action: 'Top-up added', byName: u.name, remark: b.reason || null }]),
    },
  });
  await audit({ userId: u.sub, action: 'PETTY_TOPUP', entity: 'PettyCashEntry', entityId: entry.id, details: { entryNumber: entry.entryNumber, amount: b.amount } });
  res.status(201).json({ entry: serialize(entry) });
}));

// ── Submit to accounts (custodian) ───────────────────────────────────────────
router.post('/:id/submit', requireEdit('pettycash'), asyncHandler(async (req, res) => {
  const e = await loadEntry(req.params.id);
  if (e.type !== 'EXPENSE') throw badRequest('Only an expense can be submitted.');
  if (e.status === 'CONFIRMED' || e.status === 'VOID') throw badRequest('This entry is already closed.');
  const u = req.user!;
  const entry = await prisma.pettyCashEntry.update({ where: { id: e.id }, data: { status: 'SUBMITTED', trail: withTrail(e, 'Submitted to accounts', u.name) } });
  await audit({ userId: u.sub, action: 'PETTY_SUBMIT', entity: 'PettyCashEntry', entityId: e.id });
  res.json({ entry: serialize(entry) });
}));

// ── Confirm (Accounts) — optional partial sanction ───────────────────────────
router.post('/:id/confirm', requireSection('canMarkPaid'), asyncHandler(async (req, res) => {
  const b = z.object({ sanctionedAmount: z.coerce.number().nonnegative().optional(), remark: z.string().optional() }).parse(req.body ?? {});
  const e = await loadEntry(req.params.id);
  if (e.type !== 'EXPENSE') throw badRequest('Only an expense can be confirmed.');
  if (e.status === 'VOID') throw badRequest('This entry is voided.');
  const u = req.user!;
  const entry = await prisma.pettyCashEntry.update({ where: { id: e.id }, data: { status: 'CONFIRMED', sanctionedAmount: b.sanctionedAmount ?? e.amount, decisionRemark: b.remark || null, decidedBy: u.name, decidedAt: new Date(), trail: withTrail(e, 'Confirmed by accounts', u.name, b.remark) } });
  await audit({ userId: u.sub, action: 'PETTY_CONFIRM', entity: 'PettyCashEntry', entityId: e.id, details: { sanctioned: b.sanctionedAmount } });
  res.json({ entry: serialize(entry) });
}));

// ── Reject & resend to custodian (Accounts) ──────────────────────────────────
router.post('/:id/reject', requireSection('canMarkPaid'), asyncHandler(async (req, res) => {
  const b = z.object({ remark: z.string().min(1, 'Say what needs correcting.') }).parse(req.body);
  const e = await loadEntry(req.params.id);
  if (e.status === 'VOID') throw badRequest('This entry is voided.');
  const u = req.user!;
  const entry = await prisma.pettyCashEntry.update({ where: { id: e.id }, data: { status: 'REJECTED', decisionRemark: b.remark, decidedBy: u.name, decidedAt: new Date(), trail: withTrail(e, 'Rejected & resent to custodian', u.name, b.remark) } });
  await audit({ userId: u.sub, action: 'PETTY_REJECT', entity: 'PettyCashEntry', entityId: e.id });
  res.json({ entry: serialize(entry) });
}));

// ── Strike off / void (Accounts) ─────────────────────────────────────────────
router.post('/:id/void', requireSection('canMarkPaid'), asyncHandler(async (req, res) => {
  const b = z.object({ remark: z.string().optional() }).parse(req.body ?? {});
  const e = await loadEntry(req.params.id);
  const u = req.user!;
  const entry = await prisma.pettyCashEntry.update({ where: { id: e.id }, data: { status: 'VOID', decisionRemark: b.remark || null, decidedBy: u.name, decidedAt: new Date(), trail: withTrail(e, 'Struck off (void)', u.name, b.remark) } });
  await audit({ userId: u.sub, action: 'PETTY_VOID', entity: 'PettyCashEntry', entityId: e.id });
  res.json({ entry: serialize(entry) });
}));

// ── Add a document to an entry (the Bill "+") ────────────────────────────────
router.post('/:id/document', requireEdit('pettycash'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded (field: file)');
  const kind = String(req.body?.kind || 'Bill').slice(0, 40);
  const e = await loadEntry(req.params.id);
  const docs = parseArr(e.documents);
  docs.push({ kind, fileName: req.file.originalname, fileUrl: `/uploads/${req.file.filename}`, at: new Date().toISOString() });
  const entry = await prisma.pettyCashEntry.update({ where: { id: e.id }, data: { documents: JSON.stringify(docs) } });
  await audit({ userId: req.user!.sub, action: 'PETTY_DOCUMENT', entity: 'PettyCashEntry', entityId: e.id, details: { kind } });
  res.json({ entry: serialize(entry) });
}));

// ── Comment on an entry ──────────────────────────────────────────────────────
router.post('/:id/comment', requireEdit('pettycash'), asyncHandler(async (req, res) => {
  const b = z.object({ text: z.string().min(1) }).parse(req.body);
  const e = await loadEntry(req.params.id);
  const u = req.user!;
  const comments = parseArr(e.comments);
  comments.push({ at: new Date().toISOString(), byName: u.name, text: b.text });
  const entry = await prisma.pettyCashEntry.update({ where: { id: e.id }, data: { comments: JSON.stringify(comments) } });
  res.json({ entry: serialize(entry) });
}));

// ── One entry ────────────────────────────────────────────────────────────────
router.get('/:id', requirePage('pettycash'), asyncHandler(async (req, res) => {
  res.json({ entry: serialize(await loadEntry(req.params.id)) });
}));

export default router;
