import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requirePage, requireEdit, requireSection, requireAdmin } from '../middleware/authMiddleware';
import { isAdmin } from '../lib/enums';
import { upload, UPLOADS_PATH } from '../middleware/upload';
import path from 'path';
import { extractAadharNumber } from '../services/aadharExtract';
import { buildTravelDocsPdf } from '../services/travelDocs';
import { exportTravelAccountFms } from '../services/sheetsSync';
import { audit } from '../lib/audit';
import { buildTravelSteps, notifyCurrentTravelStep, buildExpenseSteps, notifyCurrentExpenseStep, travelChainState, notifyEmployeeTechApproved, notifyTechStage3Approver } from '../services/travelChain';
import { buildTravelExpensePdf } from '../services/travelPdf';
import { travelEntitlement } from '../lib/travelEntitlements';
import { buildAllCashInHand, buildPersonStatement } from '../services/cashInHand';

// ── Travel Planning & Booking ────────────────────────────────────────────────
// One connected flow per trip: request → approval (docType 'TRAVEL') → booking →
// expense upload → expense approval (docType 'TRAVEL_EXPENSE') → employee notified
// + downloadable PDF. Traveller is a CRMCTS User (M-Level auto-filled) or a
// free-typed non-Crystal person. Approvers come from the "Approval Chains" config.
// Mounted at /api/travel. Global module (not project-scoped).
const router = Router();
router.use(requireAuth);

const parseJson = <T>(s: string | null | undefined, fb: T): T => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

function serializePlan(p: any) {
  return {
    ...p,
    jobOrders: parseJson(p.jobOrders, [] as any[]),
    planCosts: parseJson(p.planCosts, { travel: 0, food: 0, hotel: 0, other: 0 }),
    planDayCosts: parseJson(p.planDayCosts, [] as any[]),
    advances: parseJson(p.advances, [] as any[]),
    actualDayCosts: parseJson(p.actualDayCosts, [] as any[]),
    techAttachments: parseJson(p.techAttachments, [] as any[]),
    joClosureProofs: parseJson(p.joClosureProofs, [] as any[]),
    techApproved: parseJson(p.techApproved, null as any),
    techStage1: parseJson(p.techStage1, null as any),
    techStage2: parseJson(p.techStage2, null as any),
    techStage3: parseJson(p.techStage3, null as any),
    accountsData: parseJson(p.accountsData, null as any),
    trail: parseJson(p.trail, [] as any[]),
    expenses: Array.isArray(p.expenses) ? p.expenses.map(serializeExpense) : undefined,
  };
}
function serializeExpense(e: any) {
  return { ...e, items: parseJson(e.items, [] as any[]), trail: parseJson(e.trail, [] as any[]) };
}
function withTrail(row: any, action: string, byName: string, remark?: string | null): string {
  const trail = parseJson<any[]>(row.trail, []);
  trail.push({ at: new Date().toISOString(), action, byName, remark: remark ?? null });
  return JSON.stringify(trail);
}
async function nextNumber(prefix: string, table: 'travelPlan' | 'travelExpense'): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rows = table === 'travelPlan'
    ? await prisma.travelPlan.findMany({ select: { planNumber: true } })
    : await prisma.travelExpense.findMany({ select: { expenseNumber: true } });
  let max = 0;
  for (const r of rows) { const num = (r as any).planNumber ?? (r as any).expenseNumber ?? ''; const m = /(\d+)\s*$/.exec(num); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `${prefix}-${stamp}-${String(max + 1).padStart(4, '0')}`;
}

// ── Employees (traveller dropdown + M-Level auto-fill) ───────────────────────
router.get('/employees', requirePage('travel'), asyncHandler(async (_req, res) => {
  const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true, mLevel: true, whatsapp: true, employeeCode: true }, orderBy: { name: 'asc' } });
  res.json({ employees: users });
}));

// ── Per-day entitlement (TA/DA) for a traveller's M-Level + destination city ──
// Drives the New-plan auto-fill (Hotel/Food/Other per day) + allowed travel mode.
router.get('/entitlement', requirePage('travel'), asyncHandler(async (req, res) => {
  const mLevel = typeof req.query.mLevel === 'string' ? req.query.mLevel : null;
  const city = typeof req.query.city === 'string' ? req.query.city : null;
  res.json({ entitlement: travelEntitlement(mLevel, city) });
}));

// ── Travel settings: who does the day-wise expense review (Reviewer / Final) ──
// Company-wide singleton (projectId = null). Read is open to any travel viewer
// (the Approvals UI needs it to show who may act); writing is admin-only.
router.get('/config', requirePage('travel'), asyncHandler(async (_req, res) => {
  const config = await prisma.travelConfig.findFirst({ where: { projectId: null } });
  res.json({ config });
}));
router.put('/config', requireAdmin, asyncHandler(async (req, res) => {
  const b = z.object({
    reviewerId: z.string().nullable().optional(), reviewerName: z.string().nullable().optional(),
    finalId: z.string().nullable().optional(), finalName: z.string().nullable().optional(),
    stage3Id: z.string().nullable().optional(), stage3Name: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  const existing = await prisma.travelConfig.findFirst({ where: { projectId: null } });
  const data = { reviewerId: b.reviewerId ?? null, reviewerName: b.reviewerName ?? null, finalId: b.finalId ?? null, finalName: b.finalName ?? null, stage3Id: b.stage3Id ?? null, stage3Name: b.stage3Name ?? null };
  const config = existing
    ? await prisma.travelConfig.update({ where: { id: existing.id }, data })
    : await prisma.travelConfig.create({ data: { projectId: null, ...data } });
  await audit({ userId: req.user!.sub, action: 'TRAVEL_CONFIG_SET', entity: 'TravelConfig', entityId: config.id, details: { reviewer: data.reviewerName, final: data.finalName } });
  res.json({ config });
}));

// ── Next trip number (preview on the New-plan form) ──────────────────────────
router.get('/next-number', requirePage('travel'), asyncHandler(async (_req, res) => {
  res.json({ planNumber: await nextNumber('TRV', 'travelPlan') });
}));

// ── File upload (advance proof / expense supporting doc) ─────────────────────
router.post('/upload', requireEdit('travel'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  res.status(201).json({ fileUrl: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
}));

// Upload an Aadhaar card AND auto-read its 12-digit number (best-effort — the
// upload always succeeds; `aadhaar` is null if it couldn't be read). Works on
// images (JPG/PNG) and PDFs — a PDF is not required.
router.post('/upload-aadhar', requireEdit('travel'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const fileUrl = `/uploads/${req.file.filename}`;
  let aadhaar: string | null = null;
  let note: string | undefined;
  try {
    const out = await extractAadharNumber(path.join(UPLOADS_PATH, req.file.filename), req.file.mimetype);
    aadhaar = out.aadhaar; note = out.note;
  } catch { /* extraction is best-effort */ }
  res.status(201).json({ fileUrl, fileName: req.file.originalname, aadhaar, note });
}));

// ── List plans ───────────────────────────────────────────────────────────────
// ── Technician Cash in Hand (Accounts) — derived, read-only ──────────────────
// Who is holding company money right now, across travel advances + petty cash.
// Accounts-only (accountsTeam flag; admin bypasses).
router.get('/cash-in-hand', requireSection('accountsTeam'), asyncHandler(async (_req, res) => {
  res.json(await buildAllCashInHand());
}));
router.get('/cash-in-hand/:key', requireSection('accountsTeam'), asyncHandler(async (req, res) => {
  const data = await buildPersonStatement(req.params.key);
  if (!data) throw notFound('No cash history for this person.');
  res.json(data);
}));

// GET /travel/person-advance/:employeeId — the traveller's ACTIVE raised advances
// (New Advance), so the tech entry can reflect "this person already holds ₹X".
router.get('/person-advance/:employeeId', requirePage('travel'), asyncHandler(async (req, res) => {
  const rows = await prisma.pettyCashEntry.findMany({
    where: { personId: req.params.employeeId, category: 'Advance to Technician' },
    orderBy: { date: 'desc' },
  });
  const active = rows.filter((r) => !['VOID', 'REJECTED', 'PENDING_APPROVAL'].includes(r.status));
  const total = active.reduce((s, r) => s + (Number(r.sanctionedAmount ?? r.amount) || 0), 0);
  // Total already settled by Accounts across ALL of this person's trips (shared pool).
  const settledMap = await personSettledMap([req.params.employeeId]);
  const settled = settledMap.get(req.params.employeeId) || 0;
  res.json({
    total, settled, count: active.length,
    entries: active.map((r) => ({ entryNumber: r.entryNumber, amount: Number(r.sanctionedAmount ?? r.amount) || 0, date: r.date, status: r.status })),
  });
}));

router.get('/', requirePage('travel'), asyncHandler(async (req, res) => {
  const q = req.query as Record<string, string>;
  const where: any = {};
  if (q.status) where.status = q.status;
  if (q.employeeId) where.employeeId = q.employeeId;
  if (q.projectId) where.projectId = q.projectId;
  let plans = await prisma.travelPlan.findMany({ where, include: { expenses: true }, orderBy: { createdAt: 'desc' } });
  // Filter kind in JS (a doc created before this field is missing it, and a Mongo
  // equality filter would drop those). For a LEGACY record with no kind, infer it:
  // sanctioning data (projects / per-day costs) and no ticket itinerary ⇒ it was a
  // New-plan; anything else ⇒ a Ticket request.
  const effKind = (p: any): 'PLAN' | 'REQUEST' => {
    if (p.kind === 'PLAN' || p.kind === 'REQUEST') return p.kind;
    const jo = parseJson<any[]>(p.jobOrders, []);
    const dc = parseJson<any[]>(p.planDayCosts, []);
    const hasPlanData = (Array.isArray(jo) && jo.some((j) => j?.jo)) || (Array.isArray(dc) && dc.length > 0);
    return (hasPlanData && !p.travelMode && !p.origin && !p.destination) ? 'PLAN' : 'REQUEST';
  };
  // kind=PLAN returns the sanctioning plans PLUS every APPROVED-or-beyond ticket
  // REQUEST — so an approved request flows through Plan history / Tech entry /
  // Approvals / Accounts exactly like a plan (day-wise sanction, expenses, close).
  // kind=REQUEST still returns only the ticket requests (Request history).
  if (q.kind === 'PLAN') plans = plans.filter((p) => effKind(p) === 'PLAN' || (effKind(p) === 'REQUEST' && ['APPROVED', 'BOOKED', 'TRAVELLED', 'CLOSED'].includes(p.status)));
  else if (q.kind === 'REQUEST') plans = plans.filter((p) => effKind(p) === 'REQUEST');
  if (q.search) {
    const s = q.search.toLowerCase();
    plans = plans.filter((p) => [p.planNumber, p.employeeName, p.destination, p.origin, p.purpose].some((v) => (v || '').toLowerCase().includes(s)));
  }
  // Attach each traveller's ACTIVE New-Advance balance (from the New Advance module)
  // so the trip's advance figure can reflect it: effectiveAdvance = plan advance +
  // what the person already holds. Display-only — never changes stored totalAdvance.
  const empIds = plans.map((p) => p.employeeId).filter((id): id is string => !!id);
  const advMap = await personAdvanceMap(empIds);
  // Total Accounts has settled per person across ALL their trips — the New Advance
  // is a shared pool, so this reduces the remaining advance shown on EVERY trip.
  const settledMap = await personSettledMap(empIds);
  // M-Level fallback (some plans didn't store it) → the employee's own M-Level, so
  // the entitlement/slab can compute. Display-only. One query for the set of ids.
  const uniqEmp = [...new Set(empIds)];
  const users = uniqEmp.length ? await prisma.user.findMany({ where: { id: { in: uniqEmp } }, select: { id: true, mLevel: true } }) : [];
  const mLevelMap = new Map(users.map((u) => [u.id, u.mLevel]));
  res.json({ plans: plans.map((p) => {
    const personAdvance = p.employeeId ? (advMap.get(p.employeeId) || 0) : 0;
    const personSettled = p.employeeId ? (settledMap.get(p.employeeId) || 0) : 0;
    const s = serializePlan(p);
    if (!s.mLevel && p.employeeId) s.mLevel = mLevelMap.get(p.employeeId) || s.mLevel;
    return { ...s, personAdvance, personSettled, effectiveAdvance: (Number(p.totalAdvance) || 0) + personAdvance };
  }) });
}));

// Map of userId → their ACTIVE raised New-Advance total (category 'Advance to
// Technician', excluding void/rejected/pending-approval). One query for a set of ids.
async function personAdvanceMap(ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const uniq = [...new Set(ids)];
  if (!uniq.length) return map;
  const rows = await prisma.pettyCashEntry.findMany({
    where: { personId: { in: uniq }, category: 'Advance to Technician' },
    select: { personId: true, amount: true, sanctionedAmount: true, status: true },
  });
  for (const r of rows) {
    if (!r.personId || ['VOID', 'REJECTED', 'PENDING_APPROVAL'].includes(r.status)) continue;
    map.set(r.personId, (map.get(r.personId) || 0) + (Number(r.sanctionedAmount ?? r.amount) || 0));
  }
  return map;
}

// Map of userId → total advance Accounts has SETTLED across ALL their trips. The
// New Advance is a shared pool, so a settlement on one trip reduces the remaining
// advance shown on every trip. One query for a set of ids.
async function personSettledMap(ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const uniq = ids.filter((id): id is string => !!id);
  if (!uniq.length) return map;
  const rows = await prisma.travelPlan.findMany({
    where: { employeeId: { in: [...new Set(uniq)] } },
    select: { employeeId: true, advanceSettledAmount: true },
  });
  for (const r of rows) {
    if (!r.employeeId || r.advanceSettledAmount == null) continue;
    map.set(r.employeeId, (map.get(r.employeeId) || 0) + (Number(r.advanceSettledAmount) || 0));
  }
  return map;
}

// ── One plan (+ expenses + chain state) ──────────────────────────────────────
router.get('/:id', requirePage('travel'), asyncHandler(async (req, res) => {
  const p = await prisma.travelPlan.findUnique({ where: { id: req.params.id }, include: { expenses: { orderBy: { createdAt: 'desc' } } } });
  if (!p) throw notFound('Travel plan not found');
  const requestChain = await travelChainState('TRAVEL', p.id);
  const expenseChains: Record<string, any> = {};
  for (const e of p.expenses) expenseChains[e.id] = await travelChainState('TRAVEL_EXPENSE', e.id);
  const plan = serializePlan(p);
  // Entitlement needs the traveller's M-Level; older plans didn't store it, so fall
  // back to the employee's own M-Level (display-only — never changes the plan).
  if (!plan.mLevel && p.employeeId) {
    const u = await prisma.user.findUnique({ where: { id: p.employeeId }, select: { mLevel: true } });
    if (u?.mLevel) plan.mLevel = u.mLevel;
  }
  // Attach the traveller's New-Advance balance + total settled (shared pool) so the
  // detail view shows the same remaining advance as the list/tech-entry/approvals.
  if (p.employeeId) {
    const [advMap, settledMap] = await Promise.all([personAdvanceMap([p.employeeId]), personSettledMap([p.employeeId])]);
    plan.personAdvance = advMap.get(p.employeeId) || 0;
    plan.personSettled = settledMap.get(p.employeeId) || 0;
    plan.effectiveAdvance = (Number(p.totalAdvance) || 0) + plan.personAdvance;
  }
  res.json({ plan, requestChain, expenseChains });
}));

// ── GET /:id/statement — extras for the Accounts "full statement" ────────────────
// Money trail / advance lines / documents are already on the plan object the client
// holds, so this returns only what it can't derive: the ticket REQUESTS booked
// against this plan (office paid the vendor direct — NOT from the technician's cash).
router.get('/:id/statement', requirePage('travel'), asyncHandler(async (req, res) => {
  const plan = await prisma.travelPlan.findUnique({ where: { id: req.params.id }, select: { id: true, planNumber: true } });
  if (!plan) throw notFound('Travel plan not found');
  const reqs = await prisma.travelPlan.findMany({
    where: { linkedTripNumber: plan.planNumber, id: { not: plan.id } },
    orderBy: { fromDate: 'asc' },
    select: { planNumber: true, origin: true, destination: true, travelMode: true, ticketPrice: true, fromDate: true, bookingStatus: true, status: true, ticketFileUrl: true, employeeName: true },
  });
  const tickets = reqs.map((r) => ({
    requestId: r.planNumber,
    route: `${r.origin || '—'} → ${r.destination || '—'}`,
    mode: r.travelMode || null,
    fare: r.ticketPrice || 0,
    departureDate: r.fromDate,
    status: r.bookingStatus || r.status || null,
    ticketFileUrl: r.ticketFileUrl || null,
    traveller: r.employeeName || null,
  }));
  const ticketsTotal = tickets.reduce((s, t) => s + (t.fare || 0), 0);
  res.json({ tickets, ticketsTotal });
}));

const joSchema = z.object({ jo: z.string(), cn: z.string().optional().nullable(), loc: z.string().optional().nullable(), cont: z.string().optional().nullable(), ms: z.string().optional().nullable() });
const costsSchema = z.object({ travel: z.coerce.number().default(0), food: z.coerce.number().default(0), hotel: z.coerce.number().default(0), other: z.coerce.number().default(0) });
const advanceSchema = z.object({ amount: z.coerce.number().default(0), fileUrl: z.string().optional().nullable() });
const planBody = z.object({
  kind: z.enum(['PLAN', 'REQUEST']).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED']).optional(),
  linkedTripNumber: z.string().optional().nullable(),
  employeeId: z.string().nullable().optional(),
  employeeName: z.string().min(1, 'Traveller name is required'),
  employeeEmail: z.string().optional().nullable(),
  employeePhone: z.string().optional().nullable(),
  senderName: z.string().optional().nullable(),
  mLevel: z.string().optional().nullable(),
  isNonCrystal: z.boolean().optional(),
  designation: z.string().optional().nullable(), department: z.string().optional().nullable(), grade: z.string().optional().nullable(),
  aadharNo: z.string().optional().nullable(), aadharFileUrl: z.string().optional().nullable(),
  fromDate: z.string(), toDate: z.string(), days: z.coerce.number().min(1).default(1),
  origin: z.string().optional().nullable(), destination: z.string().optional().nullable(), purpose: z.string().optional().nullable(),
  travelMode: z.string().optional().nullable(), tripType: z.enum(['going', 'return', 'both']).optional().nullable(),
  requestedTicketUrl: z.string().optional().nullable(), requestedTicketUrls: z.array(z.string()).optional().nullable(),
  ticketPrice: z.coerce.number().optional().nullable(), ticketFileUrl: z.string().optional().nullable(), paymentProofUrl: z.string().optional().nullable(),
  remarks: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(),
  jobOrders: z.array(joSchema).optional(),
  planCosts: costsSchema.optional(),
  planDayCosts: z.array(z.any()).optional(),
  advances: z.array(advanceSchema).optional(),
});

// ── Create plan (DRAFT) ──────────────────────────────────────────────────────
router.post('/', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = planBody.parse(req.body);
  const u = req.user!;
  const totalAdvance = (b.advances ?? []).reduce((s, a) => s + (Number(a.amount) || 0), 0);
  const planNumber = await nextNumber('TRV', 'travelPlan');
  const plan = await prisma.travelPlan.create({
    data: {
      planNumber, kind: b.kind || 'REQUEST', linkedTripNumber: b.linkedTripNumber || null, employeeId: b.employeeId || null, employeeName: b.employeeName, employeeEmail: b.employeeEmail || null,
      employeePhone: b.employeePhone || null, mLevel: b.mLevel || null, isNonCrystal: !!b.isNonCrystal,
      senderName: b.senderName || null,
      appliedById: u.sub, appliedByName: u.name,
      designation: b.designation || null, department: b.department || null, grade: b.grade || null, aadharNo: b.aadharNo || null, aadharFileUrl: b.aadharFileUrl || null,
      travelMode: b.travelMode || null, tripType: b.tripType || null,
      requestedTicketUrl: b.requestedTicketUrls?.length ? b.requestedTicketUrls[0] : (b.requestedTicketUrl || null),
      requestedTicketUrls: b.requestedTicketUrls?.length ? b.requestedTicketUrls : (b.requestedTicketUrl ? [b.requestedTicketUrl] : []),
      ticketPrice: b.ticketPrice ?? null, ticketFileUrl: b.ticketFileUrl || null, paymentProofUrl: b.paymentProofUrl || null, remarks: b.remarks || null,
      fromDate: new Date(b.fromDate), toDate: new Date(b.toDate), days: b.days,
      origin: b.origin || null, destination: b.destination || null, purpose: b.purpose || null, projectId: b.projectId || null,
      jobOrders: JSON.stringify(b.jobOrders ?? []), planCosts: JSON.stringify(b.planCosts ?? {}), planDayCosts: JSON.stringify(b.planDayCosts ?? []),
      advances: JSON.stringify(b.advances ?? []), totalAdvance,
      // A sanctioning New-plan opens as ACTIVE (editable until Closed); a Ticket
      // request stays DRAFT until it's submitted for approval.
      status: b.kind === 'PLAN' ? 'ACTIVE' : 'DRAFT',
      trail: JSON.stringify([{ at: new Date().toISOString(), action: b.kind === 'PLAN' ? 'Plan created' : 'Travel request created', byName: u.name, remark: null }]),
    },
  });
  await audit({ userId: u.sub, action: 'TRAVEL_CREATE', entity: 'TravelPlan', entityId: plan.id, details: { planNumber, employeeName: b.employeeName } });
  res.status(201).json({ plan: serializePlan(plan) });
}));

// ── Update plan ──────────────────────────────────────────────────────────────
router.patch('/:id', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = planBody.partial().parse(req.body);
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  const data: any = {};
  for (const k of ['employeeId', 'employeeName', 'employeeEmail', 'employeePhone', 'senderName', 'mLevel', 'origin', 'destination', 'purpose', 'projectId',
    'designation', 'department', 'grade', 'aadharNo', 'aadharFileUrl', 'travelMode', 'tripType', 'requestedTicketUrl', 'ticketFileUrl', 'paymentProofUrl', 'remarks', 'senderName', 'linkedTripNumber'] as const) {
    if (b[k] !== undefined) data[k] = (b as any)[k] || null;
  }
  if (b.requestedTicketUrls !== undefined) { data.requestedTicketUrls = b.requestedTicketUrls ?? []; if (b.requestedTicketUrls?.length) data.requestedTicketUrl = b.requestedTicketUrls[0]; }
  if (b.ticketPrice !== undefined) data.ticketPrice = b.ticketPrice ?? null;
  if (b.status) data.status = b.status;   // Active ↔ Closed for sanctioning plans
  if (b.isNonCrystal !== undefined) data.isNonCrystal = !!b.isNonCrystal;
  if (b.fromDate) data.fromDate = new Date(b.fromDate);
  if (b.toDate) data.toDate = new Date(b.toDate);
  if (b.days !== undefined) data.days = b.days;
  if (b.jobOrders !== undefined) data.jobOrders = JSON.stringify(b.jobOrders);
  if (b.planCosts !== undefined) data.planCosts = JSON.stringify(b.planCosts);
  if (b.planDayCosts !== undefined) data.planDayCosts = JSON.stringify(b.planDayCosts);
  if (b.advances !== undefined) { data.advances = JSON.stringify(b.advances); data.totalAdvance = b.advances.reduce((s, a) => s + (Number(a.amount) || 0), 0); }
  const plan = await prisma.travelPlan.update({ where: { id: req.params.id }, data });
  res.json({ plan: serializePlan(plan) });
}));

// ── Submit request for approval (builds TRAVEL chain + notifies step 1) ──────
router.post('/:id/submit', requireEdit('travel'), asyncHandler(async (req, res) => {
  const u = req.user!;
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  const plan = await prisma.travelPlan.update({ where: { id: cur.id }, data: { status: 'SUBMITTED', releaseStatus: null, releaseRemark: null, trail: withTrail(cur, 'Submitted for approval', u.name) } });
  await buildTravelSteps(plan as any);
  await notifyCurrentTravelStep(plan as any);
  await audit({ userId: u.sub, action: 'TRAVEL_SUBMIT', entity: 'TravelPlan', entityId: plan.id, details: { planNumber: plan.planNumber } });
  res.json({ plan: serializePlan(plan) });
}));

// ── Resend the current-step approval email ───────────────────────────────────
router.post('/:id/remind', requireEdit('travel'), asyncHandler(async (req, res) => {
  const plan = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!plan) throw notFound('Travel plan not found');
  await notifyCurrentTravelStep(plan as any);
  res.json({ ok: true });
}));

// ── Booking status ───────────────────────────────────────────────────────────
const bookingBody = z.object({ bookingStatus: z.enum(['NOT_BOOKED', 'BOOKED', 'CANCELLED']), bookingMode: z.string().optional().nullable(), bookingRef: z.string().optional().nullable(), bookingNotes: z.string().optional().nullable() });
router.patch('/:id/booking', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = bookingBody.parse(req.body);
  const u = req.user!;
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  const plan = await prisma.travelPlan.update({ where: { id: cur.id }, data: {
    bookingStatus: b.bookingStatus, bookingMode: b.bookingMode || null, bookingRef: b.bookingRef || null, bookingNotes: b.bookingNotes || null,
    bookedById: b.bookingStatus === 'BOOKED' ? u.sub : cur.bookedById, bookedByName: b.bookingStatus === 'BOOKED' ? u.name : cur.bookedByName,
    bookedAt: b.bookingStatus === 'BOOKED' ? new Date() : cur.bookedAt,
    trail: withTrail(cur, `Booking ${b.bookingStatus}`, u.name, b.bookingRef),
  } });
  res.json({ plan: serializePlan(plan) });
}));

// ── Tech entry — day-wise ACTUAL spend filed after the trip is Closed ────────
const techDay = z.object({ day: z.coerce.number().default(1), date: z.string().optional().nullable(), bus: z.coerce.number().default(0), auto: z.coerce.number().default(0), food: z.coerce.number().default(0), hotel: z.coerce.number().default(0), other: z.coerce.number().default(0), misc: z.coerce.number().default(0), notes: z.string().optional().nullable() });
const techBody = z.object({ actualDayCosts: z.array(techDay).default([]), notes: z.string().optional().nullable(), attachments: z.array(z.any()).optional(), joClosureProofs: z.array(z.any()).optional(), submit: z.boolean().optional() });
router.post('/:id/tech-entry', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = techBody.parse(req.body);
  const u = req.user!;
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  // Ownership: when the traveller IS a CRMCTS user, only THEY (or an admin) may
  // file this trip's expenses — not any other travel-editor. Non-Crystal / free-
  // typed travellers have no login, so those are left to any travel-editor (a
  // coordinator files on their behalf) — unchanged.
  if (cur.employeeId && cur.employeeId !== u.sub && !isAdmin(req.account!.role)) {
    throw badRequest('Only the traveller on this trip (or an admin) can file its expenses.');
  }
  const data: any = {
    actualDayCosts: JSON.stringify(b.actualDayCosts),
    techEntryNotes: b.notes ?? null,
    techEntryStatus: b.submit ? 'SUBMITTED' : (cur.techEntryStatus || 'NOT_FILED'),
  };
  if (b.attachments !== undefined) data.techAttachments = JSON.stringify(b.attachments);
  if (b.joClosureProofs !== undefined) data.joClosureProofs = JSON.stringify(b.joClosureProofs);
  if (b.submit) { data.techEntrySubmittedAt = new Date(); data.trail = withTrail(cur, 'Expenses submitted', u.name); }
  const plan = await prisma.travelPlan.update({ where: { id: cur.id }, data });
  await audit({ userId: u.sub, action: b.submit ? 'TRAVEL_TECH_SUBMIT' : 'TRAVEL_TECH_SAVE', entity: 'TravelPlan', entityId: cur.id, details: { planNumber: cur.planNumber } });
  res.json({ plan: serializePlan(plan) });
}));

// ── Approvals — manager review of a submitted tech entry ─────────────────────
const decideBody = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  approved: z.object({ travel: z.coerce.number().default(0), food: z.coerce.number().default(0), hotel: z.coerce.number().default(0), other: z.coerce.number().default(0), misc: z.coerce.number().default(0) }).optional(),
  comment: z.string().optional().nullable(),
});
router.post('/:id/tech-decide', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = decideBody.parse(req.body);
  const u = req.user!;
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  if (cur.techEntryStatus !== 'SUBMITTED') throw badRequest('Only a submitted expense can be reviewed.');
  const data: any = {
    techEntryStatus: b.status,
    techApproveComment: b.comment ?? null,
    techApprovedBy: u.name,
    techApprovedAt: new Date(),
    trail: withTrail(cur, b.status === 'APPROVED' ? 'Expenses approved' : 'Expenses rejected', u.name, b.comment),
  };
  if (b.status === 'APPROVED') data.techApproved = JSON.stringify(b.approved ?? {});
  const plan = await prisma.travelPlan.update({ where: { id: cur.id }, data });
  await audit({ userId: u.sub, action: b.status === 'APPROVED' ? 'TRAVEL_TECH_APPROVE' : 'TRAVEL_TECH_REJECT', entity: 'TravelPlan', entityId: cur.id, details: { planNumber: cur.planNumber } });
  res.json({ plan: serializePlan(plan) });
}));

// ── Two-stage day-wise review (Reviewer → Final) ─────────────────────────────
const stageDay = z.object({ day: z.coerce.number().default(1), travel: z.coerce.number().default(0), food: z.coerce.number().default(0), hotel: z.coerce.number().default(0), other: z.coerce.number().default(0), misc: z.coerce.number().default(0), remark: z.string().optional().nullable() });
const stageCats = z.object({ travel: z.coerce.number().default(0), food: z.coerce.number().default(0), hotel: z.coerce.number().default(0), other: z.coerce.number().default(0), misc: z.coerce.number().default(0) });
const stageBody = z.object({ stage: z.union([z.literal(1), z.literal(2), z.literal(3)]), status: z.enum(['APPROVED', 'REJECTED']), days: z.array(stageDay).default([]), totals: stageCats.optional(), comment: z.string().optional().nullable() });
router.post('/:id/tech-stage-decide', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = stageBody.parse(req.body);
  const u = req.user!;
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  if (cur.techEntryStatus !== 'SUBMITTED') throw badRequest('Only a submitted expense can be reviewed.');
  const cfg = await prisma.travelConfig.findFirst({ where: { projectId: null } });
  // Stage 3 (Final approval / Sir) is OPTIONAL — active only when configured. Until
  // then the chain stays 2-stage (Reviewer → Final) exactly as before.
  const hasStage3 = !!cfg?.stage3Id;
  const finalStage = hasStage3 ? 3 : 2;
  const s1 = parseJson<any>(cur.techStage1, null);
  const s2 = parseJson<any>(cur.techStage2, null);
  if (b.stage === 2 && (!s1 || s1.status !== 'APPROVED')) throw badRequest('Stage 1 (Reviewer) must approve before Stage 2.');
  if (b.stage === 3 && (!s2 || s2.status !== 'APPROVED')) throw badRequest('Stage 2 (Final) must approve before the Final approval.');
  if (b.stage === 3 && !hasStage3) throw badRequest('No Stage-3 (Final approval) approver is configured.');
  // Per-stage approver assignment (Travel settings). When a stage's approver is
  // set, ONLY that user or an admin may sign it; when unset, any travel-editor may.
  if (!isAdmin(req.account!.role)) {
    const assignee = b.stage === 1 ? cfg?.reviewerId : b.stage === 2 ? cfg?.finalId : cfg?.stage3Id;
    if (assignee && assignee !== u.sub) {
      const who = b.stage === 1 ? (cfg?.reviewerName || 'the assigned Reviewer') : b.stage === 2 ? (cfg?.finalName || 'the assigned Final approver') : (cfg?.stage3Name || 'the assigned Final-approval approver');
      throw badRequest(`Only ${who} (or an admin) can sign the ${b.stage === 1 ? 'Reviewer' : b.stage === 2 ? 'Final' : 'Final-approval'} stage.`);
    }
  }
  const catTotals = (days: any[]) => days.reduce((a, d) => ({ travel: a.travel + (+d.travel || 0), food: a.food + (+d.food || 0), hotel: a.hotel + (+d.hotel || 0), other: a.other + (+d.other || 0), misc: a.misc + (+d.misc || 0) }), { travel: 0, food: 0, hotel: 0, other: 0, misc: 0 });
  // The per-category override the approver typed wins; else sum the grid cells.
  const totals = b.totals ?? catTotals(b.days);
  const stageObj = { status: b.status, by: u.name, at: new Date().toISOString(), comment: b.comment ?? null, days: b.days, totals };
  const data: any = { trail: withTrail(cur, `Expenses ${b.status === 'APPROVED' ? 'approved' : 'rejected'} (stage ${b.stage})`, u.name, b.comment) };
  if (b.stage === 1) data.techStage1 = JSON.stringify(stageObj);
  else if (b.stage === 2) data.techStage2 = JSON.stringify(stageObj);
  else data.techStage3 = JSON.stringify(stageObj);
  if (b.status === 'REJECTED') { data.techEntryStatus = 'REJECTED'; data.techApproveComment = b.comment ?? null; data.techApprovedBy = u.name; data.techApprovedAt = new Date(); }
  else if (b.stage === finalStage) { // the LAST configured stage is the final approval
    data.techEntryStatus = 'APPROVED'; data.techApproved = JSON.stringify(totals); data.techApprovedBy = u.name; data.techApprovedAt = new Date();
  }
  // Stage 2 approved with a Stage-3 (Final approval) approver set → mint the token
  // for the no-login Final-Approval Form now, so it exists even when email is off.
  if (b.status === 'APPROVED' && b.stage === 2 && hasStage3 && !cur.techApprovalToken) data.techApprovalToken = crypto.randomBytes(24).toString('hex');
  const plan = await prisma.travelPlan.update({ where: { id: cur.id }, data });
  await audit({ userId: u.sub, action: `TRAVEL_TECH_STAGE${b.stage}_${b.status}`, entity: 'TravelPlan', entityId: cur.id, details: { planNumber: cur.planNumber } });
  if (b.status === 'APPROVED') {
    if (b.stage === finalStage) notifyEmployeeTechApproved(cur.id).catch(() => {});         // final → tell the traveller
    else if (b.stage === 2 && hasStage3) notifyTechStage3Approver(cur.id).catch(() => {});   // stage 2 done → email the Stage-3 (Final approval) approver
  }
  res.json({ plan: serializePlan(plan) });
}));

// ── Accounts — finalise an approved trip (invoice + indent + payment) ────────
const accountsBody = z.object({ data: z.record(z.any()).optional(), finalize: z.boolean().optional(), unfinalize: z.boolean().optional() });
// Accounts finalise / save / reopen — the money-close action. Gated by the
// dedicated `accountsTeam` flag (same as Petty Cash confirm) so it is SEPARATE
// from plain travel-edit: a planner/approver with travel edit cannot mark a
// trip processed; only Accounts (or admin) can.
router.post('/:id/tech-accounts', requireSection('accountsTeam'), asyncHandler(async (req, res) => {
  const b = accountsBody.parse(req.body);
  const u = req.user!;
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  if (cur.techEntryStatus !== 'APPROVED') throw badRequest('Only an approved expense can be finalised in Accounts.');
  const data: any = {};
  if (b.data !== undefined) data.accountsData = JSON.stringify(b.data);
  let sentToFms = false;
  if (b.finalize) {
    // Amount to pay = the trip claim NOT yet settled against the advance.
    const ta = parseJson<any>(cur.techApproved, {});
    const claim = ['travel', 'food', 'hotel', 'other', 'misc'].reduce((s, k) => s + (Number(ta?.[k]) || 0), 0);
    const settled = Number(cur.advanceSettledAmount) || 0;
    const payable = Math.max(0, claim - settled);
    if (payable > 0.5 && !cur.accountsPaidAt) {
      // Route to the "Travel Account FMS" sheet — do NOT finalise until the UTR lands.
      data.accountsSentToFmsAt = new Date();
      data.accountsPayAmount = payable;
      if (!cur.docsToken) data.docsToken = crypto.randomBytes(24).toString('hex');
      data.trail = withTrail(cur, `Sent to Travel Account FMS — pay ₹${Math.round(payable)}`, u.name);
      sentToFms = true;
    } else {
      // Nothing to pay (fully settled against the advance) → done.
      data.accountsFinalized = true; data.accountsFinalizedBy = u.name; data.accountsFinalizedAt = new Date();
      data.trail = withTrail(cur, 'Accounts finalised (marked processed — no payment due)', u.name);
    }
  }
  if (b.unfinalize) {
    data.accountsFinalized = false;
    data.accountsSentToFmsAt = null; data.accountsPayAmount = null; data.accountsPaidAt = null; data.accountsPayVr = null; data.accountsPayUtr = null;
    data.trail = withTrail(cur, 'Accounts re-opened', u.name);
  }
  const plan = await prisma.travelPlan.update({ where: { id: cur.id }, data });
  await audit({ userId: u.sub, action: b.finalize ? 'TRAVEL_ACCOUNTS_FINALISE' : 'TRAVEL_ACCOUNTS_SAVE', entity: 'TravelPlan', entityId: cur.id, details: { planNumber: cur.planNumber } });
  if (sentToFms) exportTravelAccountFms().catch(() => {});   // push the row to the sheet (best-effort)
  res.json({ plan: serializePlan(plan) });
}));

// POST /travel/travel-fms-sync — push sent-to-FMS trips to the "Travel Account FMS"
// sheet + pull any VR/UTR back now. VPS auto-polls; this lets Accounts trigger it on
// demand (e.g. to test, or if the best-effort push on Mark processed didn't land).
router.post('/travel-fms-sync', requireSection('accountsTeam'), asyncHandler(async (_req, res) => {
  try {
    const { sheetsEnabled } = await import('../services/sheetsSync');
    if (!sheetsEnabled()) { res.json({ ok: false, message: 'Google Sheets not configured on this server.' }); return; }
    const rows = await exportTravelAccountFms();
    res.json({ ok: true, rows });
  } catch (e) {
    res.json({ ok: false, message: (e as Error)?.message || 'Sync failed' });
  }
}));

// ── Advance settlement / reconciliation (Accounts) ───────────────────────────
// Accounts settles the trip's approved claim AGAINST the advance — in parts. The
// `settledAmount` is the cumulative amount settled/consumed so far (0..claim); this
// is what reduces the technician's in-hand (the deduction happens HERE, step 5, not
// at approval). `settle:false` re-opens. Same dedicated `accountsTeam` flag.
const advanceSettleBody = z.object({ settledAmount: z.coerce.number().min(0).optional(), note: z.string().optional(), settle: z.boolean().default(true) });
router.post('/:id/advance-settle', requireSection('accountsTeam'), asyncHandler(async (req, res) => {
  const b = advanceSettleBody.parse(req.body ?? {});
  const u = req.user!;
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  if (cur.techEntryStatus !== 'APPROVED') throw badRequest('Settle the advance only after the expense is approved.');
  // The trip claim (approved figure) — the most Accounts would ever adjust.
  const ta = parseJson<any>(cur.techApproved, {});
  const claim = ['travel', 'food', 'hotel', 'other', 'misc'].reduce((s, k) => s + (Number(ta?.[k]) || 0), 0);
  // The advance the technician actually HOLDS available to this trip = plan advance
  // + New Advance not yet settled by their OTHER trips. You can't deduct more from
  // the advance than what's there — so the deduction is capped at min(claim, held).
  const emp = cur.employeeId ? [cur.employeeId] : [];
  const [advMap, settledMap] = await Promise.all([personAdvanceMap(emp), personSettledMap(emp)]);
  const raised = cur.employeeId ? (advMap.get(cur.employeeId) || 0) : 0;
  const settledOthers = Math.max(0, (cur.employeeId ? (settledMap.get(cur.employeeId) || 0) : 0) - (Number(cur.advanceSettledAmount) || 0));
  const advanceHeld = (Number(cur.totalAdvance) || 0) + Math.max(0, raised - settledOthers);
  const cap = Math.min(claim, advanceHeld);
  const data: any = {};
  if (b.settle) {
    // Deduct from the advance, capped at what the technician actually holds.
    const settled = Math.min(cap, Math.max(0, b.settledAmount ?? cap));
    data.advanceSettledAmount = settled;
    data.advanceSettled = settled >= claim - 0.5;               // fully settled only if it covers the whole claim
    if (b.note !== undefined) data.advanceSettleNote = b.note;
    data.advanceSettledBy = u.name;
    data.advanceSettledAt = new Date();
    data.trail = withTrail(cur, `Advance settled ${settled} of ${claim}`, u.name);
  } else {
    data.advanceSettled = false;
    data.advanceSettledAmount = null;
    data.advanceSettledAt = null;
    data.trail = withTrail(cur, 'Advance settlement re-opened', u.name);
  }
  const plan = await prisma.travelPlan.update({ where: { id: cur.id }, data });
  await audit({ userId: u.sub, action: b.settle ? 'TRAVEL_ADVANCE_SETTLE' : 'TRAVEL_ADVANCE_REOPEN', entity: 'TravelPlan', entityId: cur.id, details: { planNumber: cur.planNumber, settledAmount: b.settledAmount } });
  res.json({ plan: serializePlan(plan) });
}));

// ── All documents combined into one PDF (Accounts convenience) ───────────────
// Every proof/bill uploaded on this trip — advances, technician bills, ticket,
// payment proof — collated into a single PDF. Images are embedded a page each;
// PDF attachments are noted (pdfkit can't inline an existing PDF) so nothing is
// silently dropped. Read-only — does not touch any data.
router.get('/:id/documents-pdf', requirePage('travel'), asyncHandler(async (req, res) => {
  const out = await buildTravelDocsPdf(req.params.id);
  if (!out) throw notFound('Travel plan not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${out.planNumber}-documents.pdf"`);
  res.send(out.buffer);
}));

// ── Delete a DRAFT plan ──────────────────────────────────────────────────────
router.delete('/:id', requireEdit('travel'), asyncHandler(async (req, res) => {
  const cur = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!cur) throw notFound('Travel plan not found');
  if (cur.status !== 'DRAFT') throw badRequest('Only a draft travel request can be deleted');
  await prisma.approvalStep.deleteMany({ where: { docType: 'TRAVEL', docId: cur.id } });
  await prisma.travelPlan.delete({ where: { id: cur.id } });
  res.json({ ok: true });
}));

// ── Expenses ─────────────────────────────────────────────────────────────────
const expenseItem = z.object({ date: z.string().optional().nullable(), details: z.string().default(''), paymentMode: z.enum(['Online', 'Cash']).default('Online'), amount: z.coerce.number().default(0), supportingUrl: z.string().optional().nullable() });
const expenseBody = z.object({ items: z.array(expenseItem).default([]) });

router.post('/:id/expenses', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = expenseBody.parse(req.body);
  const u = req.user!;
  const plan = await prisma.travelPlan.findUnique({ where: { id: req.params.id } });
  if (!plan) throw notFound('Travel plan not found');
  const total = b.items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const expenseNumber = await nextNumber('EXP', 'travelExpense');
  const exp = await prisma.travelExpense.create({ data: {
    expenseNumber, planId: plan.id, items: JSON.stringify(b.items), totalAmount: total, status: 'DRAFT',
    submittedById: u.sub, submittedByName: u.name,
    trail: JSON.stringify([{ at: new Date().toISOString(), action: 'Expense created', byName: u.name, remark: null }]),
  } });
  res.status(201).json({ expense: serializeExpense(exp) });
}));

router.patch('/expenses/:expId', requireEdit('travel'), asyncHandler(async (req, res) => {
  const b = expenseBody.parse(req.body);
  const cur = await prisma.travelExpense.findUnique({ where: { id: req.params.expId } });
  if (!cur) throw notFound('Expense not found');
  const total = b.items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const exp = await prisma.travelExpense.update({ where: { id: cur.id }, data: { items: JSON.stringify(b.items), totalAmount: total } });
  res.json({ expense: serializeExpense(exp) });
}));

router.post('/expenses/:expId/submit', requireEdit('travel'), asyncHandler(async (req, res) => {
  const u = req.user!;
  const cur = await prisma.travelExpense.findUnique({ where: { id: req.params.expId }, include: { plan: true } });
  if (!cur) throw notFound('Expense not found');
  const exp = await prisma.travelExpense.update({ where: { id: cur.id }, data: { status: 'SUBMITTED', releaseStatus: null, releaseRemark: null, submittedAt: new Date(), submittedById: u.sub, submittedByName: u.name, trail: withTrail(cur, 'Expense submitted for approval', u.name) } });
  await buildExpenseSteps(exp as any, cur.plan.projectId);
  await notifyCurrentExpenseStep(exp as any, cur.plan as any);
  await audit({ userId: u.sub, action: 'TRAVEL_EXPENSE_SUBMIT', entity: 'TravelExpense', entityId: exp.id, details: { expenseNumber: exp.expenseNumber } });
  res.json({ expense: serializeExpense(exp) });
}));

router.post('/expenses/:expId/remind', requireEdit('travel'), asyncHandler(async (req, res) => {
  const cur = await prisma.travelExpense.findUnique({ where: { id: req.params.expId }, include: { plan: true } });
  if (!cur) throw notFound('Expense not found');
  await notifyCurrentExpenseStep(cur as any, cur.plan as any);
  res.json({ ok: true });
}));

router.delete('/expenses/:expId', requireEdit('travel'), asyncHandler(async (req, res) => {
  const cur = await prisma.travelExpense.findUnique({ where: { id: req.params.expId } });
  if (!cur) throw notFound('Expense not found');
  if (cur.status !== 'DRAFT') throw badRequest('Only a draft expense can be deleted');
  await prisma.approvalStep.deleteMany({ where: { docType: 'TRAVEL_EXPENSE', docId: cur.id } });
  await prisma.travelExpense.delete({ where: { id: cur.id } });
  res.json({ ok: true });
}));

// ── Approved expense PDF (approval + time + comments) ────────────────────────
router.get('/expenses/:expId/pdf', requirePage('travel'), asyncHandler(async (req, res) => {
  const exp = await prisma.travelExpense.findUnique({ where: { id: req.params.expId }, include: { plan: true } });
  if (!exp) throw notFound('Expense not found');
  const steps = await travelChainState('TRAVEL_EXPENSE', exp.id);
  const items = parseJson<any[]>(exp.items, []);
  const p = exp.plan;
  const buffer = await buildTravelExpensePdf(
    { planNumber: p.planNumber, employeeName: p.employeeName, mLevel: p.mLevel, isNonCrystal: p.isNonCrystal, destination: p.destination, origin: p.origin, purpose: p.purpose, fromDate: p.fromDate, toDate: p.toDate, days: p.days },
    { expenseNumber: exp.expenseNumber, totalAmount: exp.totalAmount, submittedByName: exp.submittedByName, submittedAt: exp.submittedAt, items: items.map((it) => ({ date: it.date ?? null, details: it.details ?? '', paymentMode: it.paymentMode ?? '', amount: Number(it.amount) || 0, hasSupport: !!it.supportingUrl })) },
    steps.steps.map((s) => ({ order: s.order, name: s.name, role: s.role, status: s.status, actedAt: s.actedAt, remarks: s.remarks })),
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${exp.expenseNumber}.pdf"`);
  res.send(buffer);
}));

export default router;
