import { Router } from 'express';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { isAdmin } from '../lib/enums';
import { loadProjectProgress } from '../services/projectProgress';
import { normalizeDrawingApprovals, summarizeDrawingApprovals } from '../services/drawingApprovals';
import { STANDARD_ACTIVITIES, matchStandardTat } from '../services/ganttTemplate';

// Mounted at /api/projects/:projectId/gantt
const router = Router({ mergeParams: true });
router.use(requireAuth);

const MS_DAY = 86_400_000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_DAY);
const daysBetween = (a: Date, b: Date) => Math.ceil((b.getTime() - a.getTime()) / MS_DAY);

/**
 * Derive the live state of an activity from its planned vs ACTUAL dates.
 *
 * The old logic called anything past its planned end "delayed", even if the
 * work had finished on time and simply hadn't been recorded — which is exactly
 * the complaint in Sprint PRD §3.1. Delay now requires the absence of an
 * actualEndDate: recording completion is what clears it.
 *
 * `status` keeps the original four values (the dashboard summary and
 * DashboardExtras count them); `barState` is the finer-grained colour signal
 * from PRD §3.4 that only the Gantt chart needs.
 *
 * Exported for tests — this is the rule the whole sprint hangs on.
 */
export function derive(a: any, boqPct: number | null, now: Date) {
  const pct = a.percentCompleteAuto && boqPct != null ? boqPct : a.percentComplete;
  const plannedEnd = new Date(a.plannedEndDate);
  const plannedStart = new Date(a.plannedStartDate);
  const actualStart = a.actualStartDate ? new Date(a.actualStartDate) : null;
  const actualEnd = a.actualEndDate ? new Date(a.actualEndDate) : null;

  // An activity counts as complete when its completion was recorded, or when a
  // linked BOQ item reports 100% installed (a real, approved-entry signal).
  const completed = !!actualEnd || pct >= 100;
  const started = !!actualStart || pct > 0;

  let status: string;
  let barState: string;
  let delayDays = 0;      // overdue and still open
  let pastDueDays = 0;    // never started, planned start has passed
  let overrunDays = 0;    // finished, but after the planned end

  if (completed) {
    status = 'COMPLETED';
    overrunDays = actualEnd && actualEnd.getTime() > plannedEnd.getTime() ? daysBetween(plannedEnd, actualEnd) : 0;
    barState = overrunDays > 0 ? 'DONE_LATE' : 'DONE_ON_TIME';
  } else if (now.getTime() > plannedEnd.getTime()) {
    status = 'DELAYED';
    delayDays = daysBetween(plannedEnd, now);
    barState = started ? 'IN_PROGRESS_OVERDUE' : 'PAST_DUE_NOT_STARTED';
  } else if (started) {
    status = 'IN_PROGRESS';
    barState = 'IN_PROGRESS';
  } else {
    status = 'NOT_STARTED';
    pastDueDays = now.getTime() > plannedStart.getTime() ? daysBetween(plannedStart, now) : 0;
    barState = pastDueDays > 0 ? 'PAST_DUE_NOT_STARTED' : 'NOT_STARTED';
  }

  // Actual time taken, once both ends are known. Minimum 1 day (same-day work).
  const actualDurationDays = actualStart && actualEnd ? Math.max(1, daysBetween(actualStart, actualEnd)) : null;

  return {
    ...a,
    percentComplete: Math.round((completed ? 100 : pct) * 10) / 10,
    status, barState, delayDays, pastDueDays, overrunDays, actualDurationDays,
    tatDays: a.plannedDurationDays,
    remarks: parseRemarks(a.remarks),
  };
}

export interface GanttRemark { at: string; byId: string; byName: string; byEmail: string; text: string }
const parseRemarks = (s: string | null | undefined): GanttRemark[] => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

// Resolve responsibleUserId → a display name, falling back to the free-text
// responsibleName the user typed.
async function withResponsible(rows: any[]) {
  const ids = [...new Set(rows.map((r) => r.responsibleUserId).filter(Boolean) as string[])];
  if (!ids.length) return rows.map((r) => ({ ...r, responsibleDisplay: r.responsibleName || null }));
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const byId = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ ...r, responsibleDisplay: (r.responsibleUserId && byId.get(r.responsibleUserId)) || r.responsibleName || null }));
}

// GET .../gantt — all activities with live status + the drawing-approval anchor.
router.get('/', requireProjectMember, requirePage('gantt'), asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const [acts, prog, project] = await Promise.all([
    prisma.ganttActivity.findMany({ where: { projectId }, orderBy: [{ sequence: 'asc' }, { plannedStartDate: 'asc' }] }),
    loadProjectProgress(projectId),
    prisma.project.findUnique({ where: { id: projectId }, select: { startDate: true, targetCompletionDate: true, officialStartDate: true, drawingApprovals: true } }),
  ]);
  const now = new Date();
  const derived = acts.map((a) => derive(a, a.boqItemId ? (prog.itemsById.get(a.boqItemId)?.completionPct ?? null) : null, now));
  const rows = await withResponsible(derived);
  const delayed = rows.filter((r) => r.status === 'DELAYED');
  const drawing = summarizeDrawingApprovals(normalizeDrawingApprovals(project?.drawingApprovals), now);

  res.json({
    activities: rows,
    // Day 0 of the Gantt is the drawing-approval date. Until every drawing is
    // approved the project has not officially started (Sprint PRD §2.3).
    drawingApproval: drawing,
    summary: {
      total: rows.length, completed: rows.filter((r) => r.status === 'COMPLETED').length,
      inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length, delayed: delayed.length,
      worstDelay: delayed.reduce((m, r) => Math.max(m, r.delayDays), 0),
      projectStart: project?.startDate, projectTarget: project?.targetCompletionDate,
      officialStartDate: project?.officialStartDate ?? null,
      pendingDrawingApproval: !drawing.allApproved,
      drawingApprovalLabel: drawing.label,
      drawingApprovalDelayDays: drawing.worstDelayDays,
      minDate: rows.reduce<string | null>((m, r) => (!m || r.plannedStartDate < m ? r.plannedStartDate : m), null),
      maxDate: rows.reduce<string | null>((m, r) => (!m || r.plannedEndDate > m ? r.plannedEndDate : m), null),
    },
  });
}));

// GET .../gantt/template — the standard activity + TAT table (PRD §4.1), so the
// "Add Activity" form can pre-fill and the "Apply template" button can preview.
router.get('/template', requireProjectMember, requirePage('gantt'), asyncHandler(async (_req, res) => {
  res.json({ activities: STANDARD_ACTIVITIES });
}));

const actSchema = z.object({
  activityName: z.string().min(1),
  boqItemId: z.string().nullable().optional(),
  zoneId: z.string().nullable().optional(),
  plannedStartDate: z.string(),
  // "Planned Duration (working days)" — mandatory per PRD §4.2.
  plannedDurationDays: z.coerce.number().int().min(1).default(1),
  responsibleUserId: z.string().nullable().optional(),
  responsibleName: z.string().nullable().optional(),
  percentComplete: z.coerce.number().min(0).max(100).optional(),
  percentCompleteAuto: z.boolean().optional(),
  assignedVendor: z.string().optional().nullable(),
  dependencies: z.array(z.string()).optional(),
  sequence: z.coerce.number().optional(),
});

router.post('/', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  const b = actSchema.parse(req.body);
  const start = new Date(b.plannedStartDate);
  const max = await prisma.ganttActivity.aggregate({ where: { projectId: req.params.projectId }, _max: { sequence: true } });
  // Fall back to the standard TAT / responsible party when the caller didn't
  // supply them and the activity name matches a known template row.
  const std = matchStandardTat(b.activityName);
  const dur = b.plannedDurationDays ?? std?.tatDays ?? 1;
  const act = await prisma.ganttActivity.create({
    data: {
      projectId: req.params.projectId, activityName: b.activityName, boqItemId: b.boqItemId ?? null, zoneId: b.zoneId ?? null,
      plannedStartDate: start, plannedDurationDays: dur, plannedEndDate: addDays(start, dur),
      responsibleUserId: b.responsibleUserId ?? null,
      responsibleName: b.responsibleName ?? (b.responsibleUserId ? null : std?.responsibleName ?? null),
      percentComplete: b.percentComplete ?? 0, percentCompleteAuto: b.percentCompleteAuto ?? !!b.boqItemId,
      assignedVendor: b.assignedVendor ?? null, dependencies: b.dependencies ?? [], sequence: b.sequence ?? (max._max.sequence ?? 0) + 1,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_CREATE', entity: 'GanttActivity', entityId: act.id });
  res.status(201).json({ activity: act });
}));

// POST .../gantt/apply-template — lay out the 10 standard activities anchored at
// day 0 = the project's official (drawing-approval) start date. Skips activity
// names that already exist so it is safe to re-run.
router.post('/apply-template', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { officialStartDate: true, startDate: true } });
  if (!project) throw notFound('Project not found');
  // Day 0 = drawing approval date; before that we anchor to the nominal start
  // (or today) so the template is still usable while drawings are pending.
  const day0 = project.officialStartDate ?? project.startDate ?? new Date();

  const existing = await prisma.ganttActivity.findMany({ where: { projectId }, select: { activityName: true, sequence: true } });
  const taken = new Set(existing.map((e) => e.activityName.toLowerCase()));
  let seq = existing.reduce((m, e) => Math.max(m, e.sequence), 0);

  const toCreate = STANDARD_ACTIVITIES.filter((s) => !taken.has(s.activityName.toLowerCase()));
  for (const s of toCreate) {
    const start = addDays(day0, s.offsetDays);
    await prisma.ganttActivity.create({
      data: {
        projectId, activityName: s.activityName,
        plannedStartDate: start, plannedDurationDays: s.tatDays, plannedEndDate: addDays(start, s.tatDays),
        responsibleName: s.responsibleName, percentCompleteAuto: false, sequence: ++seq,
      },
    });
  }
  await audit({ userId: req.user!.sub, projectId, action: 'GANTT_APPLY_TEMPLATE', entity: 'Project', entityId: projectId, details: { created: toCreate.length, skipped: STANDARD_ACTIVITIES.length - toCreate.length } });
  res.status(201).json({ created: toCreate.length, skipped: STANDARD_ACTIVITIES.length - toCreate.length, anchoredAt: day0 });
}));

router.patch('/:id', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  const b = actSchema.partial().parse(req.body);
  const existing = await prisma.ganttActivity.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!existing) throw notFound('Activity not found');
  const start = b.plannedStartDate ? new Date(b.plannedStartDate) : existing.plannedStartDate;
  const dur = b.plannedDurationDays ?? existing.plannedDurationDays;
  const act = await prisma.ganttActivity.update({
    where: { id: existing.id },
    data: {
      ...(b.activityName !== undefined && { activityName: b.activityName }),
      ...(b.boqItemId !== undefined && { boqItemId: b.boqItemId }),
      ...(b.zoneId !== undefined && { zoneId: b.zoneId }),
      ...((b.plannedStartDate || b.plannedDurationDays) && { plannedStartDate: start, plannedDurationDays: dur, plannedEndDate: addDays(start, dur) }),
      ...(b.responsibleUserId !== undefined && { responsibleUserId: b.responsibleUserId }),
      ...(b.responsibleName !== undefined && { responsibleName: b.responsibleName }),
      ...(b.percentComplete !== undefined && { percentComplete: b.percentComplete }),
      ...(b.percentCompleteAuto !== undefined && { percentCompleteAuto: b.percentCompleteAuto }),
      ...(b.assignedVendor !== undefined && { assignedVendor: b.assignedVendor }),
      ...(b.dependencies !== undefined && { dependencies: b.dependencies }),
      ...(b.sequence !== undefined && { sequence: b.sequence }),
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_UPDATE', entity: 'GanttActivity', entityId: act.id, details: b });
  res.json({ activity: act });
}));

// ── Checkpoints: Mark Started / Mark Complete / Revert (Sprint PRD §3.3) ─────
// This is the missing piece — without an actual date the system cannot tell
// "delayed" apart from "finished on time but never recorded".

const dateBody = z.object({ date: z.string().optional(), notes: z.string().optional() });

async function loadActivity(id: string, projectId: string) {
  const a = await prisma.ganttActivity.findFirst({ where: { id, projectId } });
  if (!a) throw notFound('Activity not found');
  return a;
}

// POST .../gantt/:id/start — record when work actually began.
router.post('/:id/start', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  const b = dateBody.parse(req.body ?? {});
  const a = await loadActivity(req.params.id, req.params.projectId);
  if (a.actualEndDate) throw badRequest('Activity is already complete. An admin must revert it before changing the start date.');
  const when = b.date ? new Date(b.date) : new Date();
  if (isNaN(when.getTime())) throw badRequest('Invalid date');
  const act = await prisma.ganttActivity.update({ where: { id: a.id }, data: { actualStartDate: when, status: 'IN_PROGRESS' } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_MARK_STARTED', entity: 'GanttActivity', entityId: a.id, details: { actualStartDate: when } });
  res.json({ activity: act });
}));

// POST .../gantt/:id/complete — record when work actually finished. This is what
// clears the delay. Completion is immutable once recorded (see /revert).
router.post('/:id/complete', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  const b = dateBody.parse(req.body ?? {});
  const a = await loadActivity(req.params.id, req.params.projectId);
  if (a.actualEndDate) throw badRequest('Activity is already marked complete. Only an admin can revert it.');
  const when = b.date ? new Date(b.date) : new Date();
  if (isNaN(when.getTime())) throw badRequest('Invalid date');
  if (a.actualStartDate && when.getTime() < a.actualStartDate.getTime()) throw badRequest('Completion date cannot be before the actual start date.');

  const act = await prisma.ganttActivity.update({
    where: { id: a.id },
    data: {
      actualEndDate: when,
      // If nobody ever pressed "Mark Started", back-fill the start from the plan
      // so actual duration is still reportable rather than silently null.
      actualStartDate: a.actualStartDate ?? a.plannedStartDate,
      completedAt: new Date(),          // immutable stamp of when it was RECORDED
      completedById: req.user!.sub,
      completionNotes: b.notes ?? null,
      status: 'COMPLETED',
      // Pin the bar at 100% — a completed activity must not drift with BOQ %.
      percentComplete: 100, percentCompleteAuto: false,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_MARK_COMPLETE', entity: 'GanttActivity', entityId: a.id, details: { actualEndDate: when, notes: b.notes } });
  res.json({ activity: act });
}));

// POST .../gantt/:id/revert — undo a completion. Admin only, reason mandatory
// and logged (PRD §3.3: "cannot be undone — only admin can revert with a reason").
router.post('/:id/revert', requireProjectMember, asyncHandler(async (req, res) => {
  if (!isAdmin(req.account!.role)) throw forbidden('Only an admin can revert a completed activity.');
  const { reason } = z.object({ reason: z.string().trim().min(1, 'A reason is required.') }).parse(req.body);
  const a = await loadActivity(req.params.id, req.params.projectId);
  if (!a.actualEndDate) throw badRequest('Activity is not marked complete.');
  const act = await prisma.ganttActivity.update({
    where: { id: a.id },
    data: {
      actualEndDate: null, completedAt: null, completedById: null, completionNotes: null,
      status: a.actualStartDate ? 'IN_PROGRESS' : 'NOT_STARTED',
      percentComplete: a.actualStartDate ? a.percentComplete : 0,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_REVERT_COMPLETE', entity: 'GanttActivity', entityId: a.id, details: { reason, revertedEndDate: a.actualEndDate } });
  res.json({ activity: act });
}));

// POST .../gantt/:id/remark — append a progress remark. Timestamped and
// attributed; shown to everyone on the timeline so the status of an activity and
// the reason it is late are on record.
router.post('/:id/remark', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  const { text } = z.object({ text: z.string().trim().min(1, 'Remark cannot be empty.').max(2000) }).parse(req.body);
  const a = await loadActivity(req.params.id, req.params.projectId);
  const list = parseRemarks(a.remarks);
  list.push({ at: new Date().toISOString(), byId: req.user!.sub, byName: req.user!.name || 'User', byEmail: req.user!.email || '', text });
  const act = await prisma.ganttActivity.update({ where: { id: a.id }, data: { remarks: JSON.stringify(list) } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_REMARK', entity: 'GanttActivity', entityId: a.id, details: { text } });
  res.json({ activity: { ...act, remarks: list } });
}));

// DELETE a single remark by index (author or admin). Keeps the log honest —
// nobody edits someone else's note, but a mistaken entry can be removed.
router.delete('/:id/remark/:index', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  const idx = Number(req.params.index);
  const a = await loadActivity(req.params.id, req.params.projectId);
  const list = parseRemarks(a.remarks);
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) throw badRequest('Remark not found.');
  const entry = list[idx];
  if (entry.byId !== req.user!.sub && !isAdmin(req.account!.role)) throw forbidden('You can only remove your own remark.');
  list.splice(idx, 1);
  const act = await prisma.ganttActivity.update({ where: { id: a.id }, data: { remarks: JSON.stringify(list) } });
  res.json({ activity: { ...act, remarks: list } });
}));

router.delete('/:id', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  await prisma.ganttActivity.deleteMany({ where: { id: req.params.id, projectId: req.params.projectId } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_DELETE', entity: 'GanttActivity', entityId: req.params.id });
  res.json({ ok: true });
}));

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// Parse a week-header date like "12-18 Jun" / "26 Jun-2 Jul" → its start Date.
function parseWeekStart(label: string, year: number): Date | null {
  const day = (label.match(/(\d{1,2})/) || [])[1];
  const mon = (label.toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/) || [])[1];
  if (!day || !mon || MONTHS[mon] === undefined) return null;
  return new Date(Date.UTC(year, MONTHS[mon], Number(day)));
}

// A cell counts as a "week marker" only if it's a real mark (not empty/false/0).
const isMark = (v: any) => { const s = String(v ?? '').trim().toLowerCase(); return s !== '' && s !== 'false' && s !== '0' && s !== 'no'; };
const toDate = (v: any) => (v instanceof Date ? v : v && !isNaN(Date.parse(v)) ? new Date(v) : null);

// Parse ONE sheet's grid into activity rows. Returns [] if it isn't a Gantt.
function parseGanttSheet(grid: any[][], year: number): { activityName: string; start: Date; dur: number; pct: number }[] {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 20); i++) {
    if (grid[i]?.some((c) => /\bactivity\b|\btask\b|scope of work/i.test(String(c)))) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];
  const header = grid[headerIdx].map((c) => String(c).trim());
  const findCol = (keys: string[]) => header.findIndex((h) => keys.some((k) => h.toLowerCase().includes(k)));
  const cA = findCol(['activity', 'task', 'scope']);
  const cDur = findCol(['duration', 'days']);
  const cStart = findCol(['start']);
  const cEnd = findCol(['end', 'finish']);
  const cPct = findCol(['%', 'complete', 'progress']);
  if (cA < 0) return [];
  const weekCols: { idx: number; start: Date }[] = [];
  header.forEach((h, idx) => { const m = h.match(/week\s*\d*\s*\(([^)]+)\)/i); if (m) { const d = parseWeekStart(m[1], year); if (d) weekCols.push({ idx, start: d }); } });

  const out: { activityName: string; start: Date; dur: number; pct: number }[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i]; if (!row) continue;
    const name = String(row[cA] ?? '').trim();
    if (!name || /^total\b/i.test(name)) continue;
    let start = cStart >= 0 ? toDate(row[cStart]) : null;
    const end = cEnd >= 0 ? toDate(row[cEnd]) : null;
    let dur = cDur >= 0 ? Number(String(row[cDur]).replace(/[^0-9.]/g, '')) || 0 : 0;
    if (!start && weekCols.length) {
      const first = weekCols.find((w) => isMark(row[w.idx]));
      const last = [...weekCols].reverse().find((w) => isMark(row[w.idx]));
      if (first) start = first.start;
      if (!dur && first && last) dur = Math.max(1, Math.round((addDays(last.start, 7).getTime() - first.start.getTime()) / MS_DAY));
    }
    if (!start) continue;
    if (!dur && end) dur = Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_DAY));
    if (!dur) dur = 1;
    const pct = cPct >= 0 ? Number(String(row[cPct]).replace(/[^0-9.]/g, '')) || 0 : 0;
    out.push({ activityName: name, start, dur, pct });
  }
  return out;
}

// POST .../gantt/upload — parse an Excel timeline. Scans ALL sheets and uses the
// one that yields the most activities. Handles explicit Start/End/Duration
// columns AND the week-grid layout (Activity | Duration | Week n(dd-dd Mon) …).
router.post('/upload', requireProjectMember, requireEdit('gantt'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded (field: file)');
  const wb = XLSX.readFile(req.file.path, { cellDates: true });
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId }, select: { startDate: true } });
  const year = project?.startDate ? new Date(project.startDate).getUTCFullYear() : new Date().getUTCFullYear();

  // Pick the sheet with the most parseable activities.
  let best: { sheet: string; rows: ReturnType<typeof parseGanttSheet> } = { sheet: '', rows: [] };
  for (const sn of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[sn], { header: 1, blankrows: false, defval: '' });
    const rows = parseGanttSheet(grid, year);
    if (rows.length > best.rows.length) best = { sheet: sn, rows };
  }
  if (best.rows.length === 0) throw badRequest('No timeline activities found. Expected a sheet with an "Activity" column and either Start/End/Duration columns or "Week n(dd-dd Mon)" columns with markers.');

  let seq = (await prisma.ganttActivity.aggregate({ where: { projectId: req.params.projectId }, _max: { sequence: true } }))._max.sequence ?? 0;
  const created: string[] = [];
  for (const r of best.rows) {
    const act = await prisma.ganttActivity.create({
      data: { projectId: req.params.projectId, activityName: r.activityName, plannedStartDate: r.start, plannedDurationDays: r.dur, plannedEndDate: addDays(r.start, r.dur), percentComplete: r.pct, percentCompleteAuto: false, sequence: ++seq },
    });
    created.push(act.id);
  }
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_UPLOAD', entity: 'Project', details: { created: created.length, sheet: best.sheet } });
  res.status(201).json({ created: created.length, errors: [], detected: { sheet: best.sheet } });
}));

export default router;
