// Room-wise DPR API — the DB-backed replacement for DPR_Cold_Storage_RoomWise.xlsx.
// Mounted at /api/projects/:projectId/dpr.
//
// Every read takes ?mode=sheet|corrected (default: sheet, so the numbers match
// the archived workbook). See services/dprRollup.ts.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requireEdit, requirePage, requireDprOwner } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { upload } from '../middleware/upload';
import {
  COMMON_ACTIVITIES,
  COMMON_BUCKET,
  DPR_ROOMS,
  ROOM_ACTIVITIES,
  activitiesFor,
  isValidCombo,
  zoneNameCandidates,
} from '../lib/dprCatalog';
import { buildDprSummary, type DprMode } from '../services/dprRollup';

const router = Router({ mergeParams: true });
router.use(requireAuth);
// The room-wise DPR is the owner's personal cockpit — restricted to the DPR
// owner account(s) (an email allowlist, NOT every admin — see lib/dprAccess.ts),
// enforced here so it cannot be reached by a direct API call. (The per-route
// requirePage/requireEdit('dpr') guards below stay as defence in depth.)
router.use(requireDprOwner);

const modeOf = (q: unknown): DprMode => (q === 'corrected' ? 'corrected' : 'sheet');
const optDate = z.string().datetime().or(z.string().min(1)).nullable().optional();
const toDate = (v: string | null | undefined) => (v ? new Date(v) : null);

// ── Scope seeding ────────────────────────────────────────────────────────────
// Creates the 7 rooms + the Common / Plant-wide bucket, and the 118 scope rows.
// Idempotent: existing rooms are matched by name and existing scope rows by the
// (projectId, zoneId, activity) unique index, so re-running never duplicates and
// never clobbers a target quantity someone has already entered.
router.post(
  '/seed',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;

    const wanted: { name: string; isCommon: boolean }[] = [
      ...DPR_ROOMS.map((r) => ({ name: r as string, isCommon: false })),
      { name: COMMON_BUCKET, isCommon: true },
    ];

    const existing = await prisma.projectZone.findMany({ where: { projectId } });
    const byName = new Map(existing.map((z) => [z.zoneName, z]));

    let roomsCreated = 0;
    let scopeCreated = 0;
    const adopted: { room: string; zoneName: string }[] = [];

    for (const [i, w] of wanted.entries()) {
      // Adopt the project's own zone for this room if it has one under any of its
      // known names — never create "Ambient" next to an existing "Ambient Room".
      let zone: (typeof existing)[number] | undefined;
      for (const name of zoneNameCandidates(w.name, w.isCommon)) {
        const hit = byName.get(name);
        if (hit) { zone = hit; break; }
      }
      if (!zone) {
        zone = await prisma.projectZone.create({
          data: { projectId, zoneName: w.name, isCommonBucket: w.isCommon, sortOrder: 100 + i },
        });
        roomsCreated++;
      } else {
        if (zone.zoneName !== w.name) adopted.push({ room: w.name, zoneName: zone.zoneName });
        if (w.isCommon && !zone.isCommonBucket) {
          zone = await prisma.projectZone.update({ where: { id: zone.id }, data: { isCommonBucket: true } });
        }
      }

      const catalog = w.isCommon ? COMMON_ACTIVITIES : ROOM_ACTIVITIES;
      const have = new Set(
        (await prisma.roomScopeItem.findMany({ where: { projectId, zoneId: zone.id }, select: { activity: true } }))
          .map((s) => s.activity),
      );
      const missing = catalog.filter((c) => !have.has(c.activity));
      if (missing.length) {
        await prisma.roomScopeItem.createMany({
          data: missing.map((c) => ({
            projectId,
            zoneId: zone!.id,
            category: c.category,
            activity: c.activity,
            uom: c.uom,
            sortOrder: catalog.findIndex((x) => x.activity === c.activity),
          })),
        });
        scopeCreated += missing.length;
      }
    }

    await audit({ userId: req.user!.sub, projectId, action: 'DPR_SEED', entity: 'RoomScopeItem', details: { roomsCreated, scopeCreated, adopted } });
    res.json({ roomsCreated, scopeCreated, adopted });
  }),
);

// ── Reads ────────────────────────────────────────────────────────────────────

/** The Dashboard tab + Room_Handover tab in one payload. */
router.get(
  '/summary',
  requireProjectMember,
  requirePage('dpr'),
  asyncHandler(async (req, res) => {
    res.json(await buildDprSummary(req.params.projectId, modeOf(req.query.mode)));
  }),
);

/** One room's scope & progress tracker (an "Ambient Room"-style tab). */
router.get(
  '/rooms/:zoneId',
  requireProjectMember,
  requirePage('dpr'),
  asyncHandler(async (req, res) => {
    const summary = await buildDprSummary(req.params.projectId, modeOf(req.query.mode));
    const room = [...summary.rooms, summary.common].find((r) => r?.zoneId === req.params.zoneId);
    if (!room) throw notFound('Room not found in this project');
    res.json({ room, mode: summary.mode, warnings: summary.warnings });
  }),
);

/** Cascade source for the Daily Entry form: Room → Category → Activity. */
router.get(
  '/options',
  requireProjectMember,
  requirePage('dpr'),
  asyncHandler(async (req, res) => {
    const zones = await prisma.projectZone.findMany({
      where: { projectId: req.params.projectId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, zoneName: true, isCommonBucket: true },
    });
    const scope = await prisma.roomScopeItem.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, zoneId: true, category: true, activity: true, uom: true },
    });
    const withScope = new Set(scope.map((s) => s.zoneId));
    res.json({
      // A project's zone list also holds rooms the DPR does not track (an
      // Electrical Room, a batching area). Offering them here would put empty
      // rooms in the daily-entry dropdown.
      rooms: zones.filter((z) => withScope.has(z.id)).map((z) => ({
        ...z,
        // Only the categories that legally live in this room — the sheet's flat
        // 28-item dropdown is what let the Freezer/Refrigeration entry go
        // nowhere (bug B4).
        categories: [...new Set(activitiesFor(z.isCommonBucket ? COMMON_BUCKET : z.zoneName).map((a) => a.category))],
        activities: scope.filter((s) => s.zoneId === z.id),
      })),
    });
  }),
);

/** The Daily_Entry tab — the shared chronological log. */
router.get(
  '/entries',
  requireProjectMember,
  requirePage('dpr'),
  asyncHandler(async (req, res) => {
    const entries = await prisma.dPREntry.findMany({
      where: { projectId: req.params.projectId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(Number(req.query.limit) || 200, 1000),
      include: {
        roomScopeItem: { select: { activity: true, category: true, uom: true, zone: { select: { id: true, zoneName: true } } } },
      },
    });
    res.json({ entries });
  }),
);

// ── Daily entry ──────────────────────────────────────────────────────────────

const entrySchema = z.object({
  roomScopeItemId: z.string().min(1),
  date: z.string().min(1),
  qtyDoneToday: z.number().positive('Quantity must be greater than zero'),
  labourTeam: z.string().trim().max(120).optional(),
  remarks: z.string().trim().max(2000).optional(),
});

router.post(
  '/entries',
  requireProjectMember,
  requireEdit('dpr'),
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const body = entrySchema.parse({
      roomScopeItemId: req.body.roomScopeItemId,
      date: req.body.date,
      qtyDoneToday: typeof req.body.qtyDoneToday === 'string' ? Number(req.body.qtyDoneToday) : req.body.qtyDoneToday,
      labourTeam: req.body.labourTeam || undefined,
      remarks: req.body.remarks || undefined,
    });

    const scope = await prisma.roomScopeItem.findFirst({
      where: { id: body.roomScopeItemId, projectId },
      include: { zone: { select: { zoneName: true, isCommonBucket: true } } },
    });
    if (!scope) throw notFound('Activity not found in this project');

    // Reject the combination the sheet silently swallows (bug B4). This can only
    // trigger if a scope row was hand-created outside the catalogue.
    const roomKey = scope.zone.isCommonBucket ? COMMON_BUCKET : scope.zone.zoneName;
    if (!isValidCombo(roomKey, scope.category, scope.activity)) {
      throw badRequest(
        `"${scope.activity}" (${scope.category}) is not a valid activity for ${roomKey}. ` +
          `Refrigeration and Electrical work belongs to "${COMMON_BUCKET}".`,
      );
    }

    const entry = await prisma.dPREntry.create({
      data: {
        projectId,
        roomScopeItemId: scope.id,
        date: new Date(body.date),
        qtyDoneToday: body.qtyDoneToday,
        labourTeam: body.labourTeam ?? null,
        remarks: body.remarks ?? null,
        photoUrl: req.file ? `/uploads/${req.file.filename}` : null,
        submittedById: req.user!.sub,
        status: 'APPROVED',
      },
    });

    await audit({
      userId: req.user!.sub, projectId, action: 'DPR_ENTRY_ADD', entity: 'DPREntry', entityId: entry.id,
      details: { room: roomKey, activity: scope.activity, qty: body.qtyDoneToday },
    });
    res.status(201).json({ entry });
  }),
);

/**
 * Opening balance / manual adjustment.
 *
 * In the workbook this was done by typing a number straight over the SUMIFS
 * ('Ambient Room'!I8 = 200, no formula, while the log only held 55 — bug B11).
 * The need is real: a cumulative known from site that was never logged daily.
 * Here it becomes an entry with a kind, an author and a mandatory reason, so the
 * running total still adds up and the override is visible on the room sheet.
 */
router.post(
  '/entries/adjustment',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const b = z.object({
      roomScopeItemId: z.string().min(1),
      date: z.string().min(1),
      // Signed: a correction may reduce the running total.
      qty: z.number().refine((n) => n !== 0, 'Adjustment cannot be zero'),
      kind: z.enum(['OPENING', 'ADJUSTMENT']).default('ADJUSTMENT'),
      reason: z.string().trim().min(3, 'A reason is required for a manual adjustment').max(2000),
    }).parse(req.body);

    const scope = await prisma.roomScopeItem.findFirst({ where: { id: b.roomScopeItemId, projectId } });
    if (!scope) throw notFound('Activity not found in this project');

    const current = await prisma.dPREntry.aggregate({
      where: { roomScopeItemId: scope.id, status: 'APPROVED' },
      _sum: { qtyDoneToday: true },
    });
    if ((current._sum.qtyDoneToday ?? 0) + b.qty < 0) {
      throw badRequest('That adjustment would push the cumulative quantity below zero.');
    }

    const entry = await prisma.dPREntry.create({
      data: {
        projectId, roomScopeItemId: scope.id, kind: b.kind,
        date: new Date(b.date), qtyDoneToday: b.qty, remarks: b.reason,
        submittedById: req.user!.sub, status: 'APPROVED',
      },
    });
    await audit({
      userId: req.user!.sub, projectId, action: 'DPR_ENTRY_ADJUST', entity: 'DPREntry', entityId: entry.id,
      details: { activity: scope.activity, kind: b.kind, qty: b.qty, reason: b.reason },
    });
    res.status(201).json({ entry });
  }),
);

router.delete(
  '/entries/:entryId',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const entry = await prisma.dPREntry.findFirst({ where: { id: req.params.entryId, projectId } });
    if (!entry) throw notFound('Entry not found');
    await prisma.dPREntry.delete({ where: { id: entry.id } });
    await audit({ userId: req.user!.sub, projectId, action: 'DPR_ENTRY_DELETE', entity: 'DPREntry', entityId: entry.id });
    res.json({ ok: true });
  }),
);

// ── Scope maintenance (target quantities + planned dates) ────────────────────

const scopePatch = z.object({
  targetQty: z.number().nonnegative().nullable().optional(),
  targetSource: z.enum(['DRAWING', 'BOQ_SPLIT', 'MANUAL']).nullable().optional(),
  weight: z.number().positive().optional(),
  plannedStart: optDate,
  plannedFinish: optDate,
  plannedHandover: optDate,
  remarks: z.string().trim().max(2000).nullable().optional(),
  boqItemId: z.string().nullable().optional(),
});

router.patch(
  '/scope/:itemId',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const b = scopePatch.parse(req.body);
    const existing = await prisma.roomScopeItem.findFirst({ where: { id: req.params.itemId, projectId } });
    if (!existing) throw notFound('Scope item not found');

    const item = await prisma.roomScopeItem.update({
      where: { id: existing.id },
      data: {
        ...(b.targetQty !== undefined && { targetQty: b.targetQty }),
        ...(b.targetSource !== undefined && { targetSource: b.targetSource }),
        ...(b.weight !== undefined && { weight: b.weight }),
        ...(b.plannedStart !== undefined && { plannedStart: toDate(b.plannedStart) }),
        ...(b.plannedFinish !== undefined && { plannedFinish: toDate(b.plannedFinish) }),
        ...(b.plannedHandover !== undefined && { plannedHandover: toDate(b.plannedHandover) }),
        ...(b.remarks !== undefined && { remarks: b.remarks }),
        ...(b.boqItemId !== undefined && { boqItemId: b.boqItemId }),
      },
    });
    await audit({ userId: req.user!.sub, projectId, action: 'DPR_SCOPE_UPDATE', entity: 'RoomScopeItem', entityId: item.id, details: b });
    res.json({ item });
  }),
);

/**
 * Σ(RoomScopeItem.targetQty) per BOQ item vs BOQItem.plannedQty. Flags where the
 * drawing team's room-wise breakup does not add up to the BOQ line it came from
 * (PRD open question OQ-6 — currently reported, never blocked).
 */
router.get(
  '/reconcile',
  requireProjectMember,
  requirePage('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const [boqItems, scope] = await Promise.all([
      prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, select: { id: true, description: true, unit: true, plannedQty: true } }),
      prisma.roomScopeItem.findMany({ where: { projectId, boqItemId: { not: null } }, select: { boqItemId: true, targetQty: true } }),
    ]);
    const sums = new Map<string, number>();
    for (const s of scope) sums.set(s.boqItemId!, (sums.get(s.boqItemId!) ?? 0) + (s.targetQty ?? 0));

    const linked = boqItems
      .filter((b) => sums.has(b.id))
      .map((b) => {
        const allocated = Math.round((sums.get(b.id) ?? 0) * 10_000) / 10_000;
        const variance = Math.round((allocated - b.plannedQty) * 10_000) / 10_000;
        const pct = b.plannedQty > 0 ? Math.abs(variance) / b.plannedQty : allocated > 0 ? 1 : 0;
        return { ...b, allocated, variance, withinTolerance: pct <= 0.1 }; // 10%, as BOQItemList.toleranceUsed
      });

    res.json({
      linked,
      unlinkedBoqItems: boqItems.filter((b) => !sums.has(b.id)).length,
      mismatches: linked.filter((l) => !l.withinTolerance).length,
    });
  }),
);

// ── Handover sign-off ────────────────────────────────────────────────────────
// The event the sheet never records. Blocked below 100% (corrected mode) so the
// "handed over 3 days early at 30% complete" state is unreachable (bug B3).
router.post(
  '/rooms/:zoneId/handover',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const body = z.object({ actualHandoverDate: z.string().min(1), force: z.boolean().optional() }).parse(req.body);

    const zone = await prisma.projectZone.findFirst({ where: { id: req.params.zoneId, projectId } });
    if (!zone) throw notFound('Room not found');
    if (zone.isCommonBucket) throw badRequest('The Common / Plant-wide bucket is not a handoverable room.');

    const summary = await buildDprSummary(projectId, 'corrected');
    const room = summary.rooms.find((r) => r.zoneId === zone.id);
    if (!room) throw notFound('Room has no scope items');
    if (room.overallPct < 1 && !body.force) {
      throw badRequest(`${zone.zoneName} is ${Math.round(room.overallPct * 100)}% complete. A room cannot be handed over below 100%.`, {
        overallPct: room.overallPct,
        targetMissingCount: room.targetMissingCount,
      });
    }

    const updated = await prisma.projectZone.update({
      where: { id: zone.id },
      data: { actualHandoverDate: new Date(body.actualHandoverDate), handoverById: req.user!.sub },
    });
    await audit({ userId: req.user!.sub, projectId, action: 'DPR_ROOM_HANDOVER', entity: 'ProjectZone', entityId: zone.id, details: { forced: !!body.force } });
    res.json({ zone: updated });
  }),
);

router.patch(
  '/rooms/:zoneId',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const b = z.object({ plannedHandoverDate: optDate }).parse(req.body);
    const zone = await prisma.projectZone.findFirst({ where: { id: req.params.zoneId, projectId } });
    if (!zone) throw notFound('Room not found');
    const updated = await prisma.projectZone.update({
      where: { id: zone.id },
      data: { ...(b.plannedHandoverDate !== undefined && { plannedHandoverDate: toDate(b.plannedHandoverDate) }) },
    });
    res.json({ zone: updated });
  }),
);

// ── Milestones tab ───────────────────────────────────────────────────────────

router.get(
  '/milestones',
  requireProjectMember,
  requirePage('dpr'),
  asyncHandler(async (req, res) => {
    const rows = await prisma.projectMilestone.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { sortOrder: 'asc' },
    });
    const now = new Date();
    const MS_DAY = 86_400_000;
    const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    res.json({
      milestones: rows.map((m) => ({
        ...m,
        // Sheet: IF(Actual<>"", Actual - Committed, ""). We additionally show the
        // live slip on an overdue-but-unfinished milestone.
        delayDays:
          m.actualDate && m.committedDateVendor
            ? Math.round((day(m.actualDate) - day(m.committedDateVendor)) / MS_DAY)
            : m.committedDateVendor && !m.actualDate && day(now) > day(m.committedDateVendor)
              ? Math.round((day(now) - day(m.committedDateVendor)) / MS_DAY)
              : null,
        isOverdue: !!m.committedDateVendor && !m.actualDate && day(now) > day(m.committedDateVendor),
      })),
    });
  }),
);

const milestoneSchema = z.object({
  name: z.string().trim().min(1),
  zoneId: z.string().nullable().optional(),
  committedDateVendor: optDate,
  fkiFreezeDate: optDate,
  actualDate: optDate,
  remarks: z.string().trim().max(2000).nullable().optional(),
  sortOrder: z.number().int().optional(),
});

router.post(
  '/milestones',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const b = milestoneSchema.parse(req.body);
    const milestone = await prisma.projectMilestone.create({
      data: {
        projectId: req.params.projectId,
        name: b.name,
        zoneId: b.zoneId ?? null,
        committedDateVendor: toDate(b.committedDateVendor),
        fkiFreezeDate: toDate(b.fkiFreezeDate),
        actualDate: toDate(b.actualDate),
        remarks: b.remarks ?? null,
        sortOrder: b.sortOrder ?? 0,
      },
    });
    res.status(201).json({ milestone });
  }),
);

router.patch(
  '/milestones/:id',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const b = milestoneSchema.partial().parse(req.body);
    const existing = await prisma.projectMilestone.findFirst({ where: { id: req.params.id, projectId } });
    if (!existing) throw notFound('Milestone not found');
    const milestone = await prisma.projectMilestone.update({
      where: { id: existing.id },
      data: {
        ...(b.name !== undefined && { name: b.name }),
        ...(b.committedDateVendor !== undefined && { committedDateVendor: toDate(b.committedDateVendor) }),
        ...(b.fkiFreezeDate !== undefined && { fkiFreezeDate: toDate(b.fkiFreezeDate) }),
        ...(b.actualDate !== undefined && { actualDate: toDate(b.actualDate) }),
        ...(b.remarks !== undefined && { remarks: b.remarks }),
        ...(b.sortOrder !== undefined && { sortOrder: b.sortOrder }),
      },
    });
    res.json({ milestone });
  }),
);

router.delete(
  '/milestones/:id',
  requireProjectMember,
  requireEdit('dpr'),
  asyncHandler(async (req, res) => {
    const existing = await prisma.projectMilestone.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
    if (!existing) throw notFound('Milestone not found');
    await prisma.projectMilestone.delete({ where: { id: existing.id } });
    res.json({ ok: true });
  }),
);

export default router;
