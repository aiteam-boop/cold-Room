import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage } from '../middleware/authMiddleware';
import { loadProjectProgress } from '../services/projectProgress';
import { assessDelay } from '../services/calc';

const router = Router({ mergeParams: true });
router.use(requireAuth);

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
