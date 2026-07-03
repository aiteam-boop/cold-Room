import { Router } from 'express';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { loadProjectProgress } from '../services/projectProgress';

// Mounted at /api/projects/:projectId/gantt
const router = Router({ mergeParams: true });
router.use(requireAuth);

const MS_DAY = 86_400_000;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * MS_DAY);

// Derive live status / %complete / delay for an activity.
function derive(a: any, boqPct: number | null, now: Date) {
  const pct = a.percentCompleteAuto && boqPct != null ? boqPct : a.percentComplete;
  const end = a.plannedEndDate ? new Date(a.plannedEndDate) : null;
  let status: string;
  if (pct >= 100) status = 'COMPLETED';
  else if (pct > 0 || a.actualStartDate) status = 'IN_PROGRESS';
  else status = 'NOT_STARTED';
  const overdue = end && status !== 'COMPLETED' && now.getTime() > end.getTime();
  if (overdue) status = 'DELAYED';
  const delayDays = overdue && end ? Math.ceil((now.getTime() - end.getTime()) / MS_DAY) : 0;
  return { ...a, percentComplete: Math.round(pct * 10) / 10, status, delayDays };
}

// GET .../gantt — all activities with live status.
router.get('/', requireProjectMember, requirePage('gantt'), asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const [acts, prog, project] = await Promise.all([
    prisma.ganttActivity.findMany({ where: { projectId }, orderBy: [{ sequence: 'asc' }, { plannedStartDate: 'asc' }] }),
    loadProjectProgress(projectId),
    prisma.project.findUnique({ where: { id: projectId }, select: { startDate: true, targetCompletionDate: true } }),
  ]);
  const now = new Date();
  const rows = acts.map((a) => derive(a, a.boqItemId ? (prog.itemsById.get(a.boqItemId)?.completionPct ?? null) : null, now));
  const delayed = rows.filter((r) => r.status === 'DELAYED');
  res.json({
    activities: rows,
    summary: {
      total: rows.length, completed: rows.filter((r) => r.status === 'COMPLETED').length,
      inProgress: rows.filter((r) => r.status === 'IN_PROGRESS').length, delayed: delayed.length,
      worstDelay: delayed.reduce((m, r) => Math.max(m, r.delayDays), 0),
      projectStart: project?.startDate, projectTarget: project?.targetCompletionDate,
      minDate: rows.reduce<string | null>((m, r) => (!m || r.plannedStartDate < m ? r.plannedStartDate : m), null),
      maxDate: rows.reduce<string | null>((m, r) => (!m || r.plannedEndDate > m ? r.plannedEndDate : m), null),
    },
  });
}));

const actSchema = z.object({
  activityName: z.string().min(1),
  boqItemId: z.string().nullable().optional(),
  zoneId: z.string().nullable().optional(),
  plannedStartDate: z.string(),
  plannedDurationDays: z.coerce.number().int().min(1).default(1),
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
  const act = await prisma.ganttActivity.create({
    data: {
      projectId: req.params.projectId, activityName: b.activityName, boqItemId: b.boqItemId ?? null, zoneId: b.zoneId ?? null,
      plannedStartDate: start, plannedDurationDays: b.plannedDurationDays, plannedEndDate: addDays(start, b.plannedDurationDays),
      percentComplete: b.percentComplete ?? 0, percentCompleteAuto: b.percentCompleteAuto ?? !!b.boqItemId,
      assignedVendor: b.assignedVendor ?? null, dependencies: b.dependencies ?? [], sequence: b.sequence ?? (max._max.sequence ?? 0) + 1,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'GANTT_CREATE', entity: 'GanttActivity', entityId: act.id });
  res.status(201).json({ activity: act });
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
      ...(b.percentComplete !== undefined && { percentComplete: b.percentComplete }),
      ...(b.percentCompleteAuto !== undefined && { percentCompleteAuto: b.percentCompleteAuto }),
      ...(b.assignedVendor !== undefined && { assignedVendor: b.assignedVendor }),
      ...(b.dependencies !== undefined && { dependencies: b.dependencies }),
      ...(b.sequence !== undefined && { sequence: b.sequence }),
    },
  });
  res.json({ activity: act });
}));

router.delete('/:id', requireProjectMember, requireEdit('gantt'), asyncHandler(async (req, res) => {
  await prisma.ganttActivity.deleteMany({ where: { id: req.params.id, projectId: req.params.projectId } });
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
