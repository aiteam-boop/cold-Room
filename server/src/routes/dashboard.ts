import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage } from '../middleware/authMiddleware';
import { loadProjectProgress } from '../services/projectProgress';
import { assessDelay } from '../services/calc';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// GET .../room-progress — per-room (zone) completion %, fed by linked BOQ items
// (Feature 3 — Room-wise tracking). Drives the dashboard room cards + the
// existing Module A floor-plan colouring (same green/orange/red thresholds).
router.get(
  '/room-progress',
  requireProjectMember,
  requirePage('dashboard'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const [zones, prog] = await Promise.all([
      prisma.projectZone.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' }, include: { boqItems: { where: { isGroup: false }, select: { id: true } } } }),
      loadProjectProgress(projectId),
    ]);
    const rooms = zones.map((z) => {
      const linked = z.boqItems.map((b) => prog.itemsById.get(b.id)).filter(Boolean) as NonNullable<ReturnType<typeof prog.itemsById.get>>[];
      const planned = linked.reduce((s, i) => s + i.plannedQty, 0);
      const installed = linked.reduce((s, i) => s + i.installedQty, 0);
      const pct = planned > 0 ? Math.round((installed / planned) * 1000) / 10 : 0;
      const color = pct >= 80 ? 'GREEN' : pct >= 20 ? 'YELLOW' : 'RED';
      return {
        zoneId: z.id, roomName: z.zoneName, roomType: z.roomType, temperatureRange: z.temperatureRange,
        completionPct: pct, colorStatus: color, plannedQty: planned, installedQty: Math.round(installed * 100) / 100,
        itemCount: linked.length,
        items: linked.map((i) => ({ id: i.id, description: i.description, unit: i.unit, plannedQty: i.plannedQty, installedQty: i.installedQty, completionPct: i.completionPct })),
      };
    });
    res.json({ rooms });
  })
);

// GET .../dashboard — everything the Analytics tab needs (PRD §10.5, FR-DB-*).
router.get(
  '/',
  requireProjectMember,
  requirePage('dashboard'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const now = new Date();
    const [project, prog, recent] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId } }),
      loadProjectProgress(projectId, now),
      prisma.progressEntry.findMany({
        where: { projectId, status: 'APPROVED', date: { gte: new Date(now.getTime() - 7 * 86400000) } },
        orderBy: { date: 'desc' },
        take: 50,
        include: { boqItem: { select: { description: true, unit: true } }, submittedBy: { select: { name: true } } },
      }),
    ]);

    // Per-category delay assessment for the Delay Risk Table (FR-DB-06).
    const categoryRisk = prog.categories.map((c) => ({
      category: c.category,
      completionPct: c.completionPct,
      remainingQty: c.remainingQty,
      estimatedCompletionDate: c.estimatedCompletionDate,
      risk: assessDelay(c.estimatedCompletionDate, project?.targetCompletionDate ?? null, now),
    }));

    // Material consumption summary (FR-DB-04): actual vs planned per category.
    const materials = prog.categories.map((c) => ({
      category: c.category,
      plannedQty: c.plannedQty,
      installedQty: c.installedQty,
      remainingQty: c.remainingQty,
      completionPct: c.completionPct,
    }));

    const daysRemaining = project?.targetCompletionDate
      ? Math.ceil((project.targetCompletionDate.getTime() - now.getTime()) / 86400000)
      : null;

    res.json({
      project: {
        id: project?.id,
        name: project?.name,
        clientName: project?.clientName,
        status: project?.status,
        startDate: project?.startDate,
        targetCompletionDate: project?.targetCompletionDate,
        daysRemaining,
      },
      overall: prog.overall,
      risk: prog.risk,
      categories: prog.categories,
      categoryRisk,
      materials,
      recentActivity: recent.map((e) => ({
        id: e.id,
        date: e.date,
        item: e.boqItem.description,
        unit: e.boqItem.unit,
        quantity: e.quantityInstalled,
        by: e.submittedBy.name,
      })),
    });
  })
);

// GET .../dashboard/activity-table — full item table (FR-DB-02).
router.get(
  '/activity-table',
  requireProjectMember,
  requirePage('dashboard'),
  asyncHandler(async (req, res) => {
    const prog = await loadProjectProgress(req.params.projectId);
    res.json({ items: prog.items });
  })
);

export default router;
