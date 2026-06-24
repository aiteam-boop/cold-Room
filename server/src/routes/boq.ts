import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { parseBOQFile } from '../services/boqParser';
import { aiProvider } from '../services/boqParser';
import { analyzeBOQ } from '../services/boqAnalyzer';
import { audit } from '../lib/audit';
import { loadProjectProgress } from '../services/projectProgress';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// GET /api/projects/:projectId/boq — full hierarchy with live progress merged.
router.get(
  '/',
  requireProjectMember,
  requirePage('boq'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const [items, prog, project] = await Promise.all([
      prisma.bOQItem.findMany({ where: { projectId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      loadProjectProgress(projectId),
      prisma.project.findUnique({ where: { id: projectId }, select: { boqLocked: true, boqLockedAt: true } }),
    ]);
    const merged = items.map((it) => {
      const p = prog.itemsById.get(it.id);
      return {
        ...it,
        installedQty: p?.installedQty ?? 0,
        remainingQty: p?.remainingQty ?? Math.max(it.plannedQty, 0),
        completionPct: p?.completionPct ?? 0,
        colorStatus: p?.colorStatus ?? 'RED',
        estimatedCompletionDate: p?.estimatedCompletionDate ?? null,
      };
    });
    res.json({ items: merged, locked: project?.boqLocked ?? false, lockedAt: project?.boqLockedAt ?? null, categories: prog.categories });
  })
);

// POST /api/projects/:projectId/boq/parse — upload + parse, returns preview
// rows for admin review (FR-BQ-03). Does NOT persist yet.
router.post(
  '/parse',
  requireProjectMember,
  requireEdit('boq'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded (field name: file)');
    const result = await parseBOQFile(req.file.path, req.file.mimetype);
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_PARSE', entity: 'Project', details: { count: result.rows.length, source: result.source, file: req.file.originalname } });
    res.json({ ...result, fileName: req.file.originalname });
  })
);

const importSchema = z.object({
  items: z.array(
    z.object({
      srNo: z.string().optional(),
      description: z.string().min(1),
      category: z.string().optional(),
      roomZone: z.string().optional(),
      unit: z.string().optional(),
      plannedQty: z.number().nonnegative().default(0),
      isGroup: z.boolean().optional(),
    })
  ),
  replace: z.boolean().optional(),
});

// POST /api/projects/:projectId/boq/import — persist reviewed rows as baseline.
router.post(
  '/import',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw notFound('Project not found');
    if (project.boqLocked) throw forbidden('BOQ is locked. Unlock to make changes (versioned).');

    const body = importSchema.parse(req.body);
    await prisma.$transaction(async (tx) => {
      if (body.replace) {
        await tx.progressEntry.deleteMany({ where: { projectId } });
        await tx.bOQItem.deleteMany({ where: { projectId } });
      }
      let order = 0;
      for (const it of body.items) {
        await tx.bOQItem.create({
          data: {
            projectId,
            srNo: it.srNo,
            description: it.description,
            category: it.category,
            roomZone: it.roomZone,
            unit: it.unit,
            plannedQty: it.plannedQty,
            isGroup: it.isGroup ?? false,
            sortOrder: order++,
          },
        });
      }
    });
    await audit({ userId: req.user!.sub, projectId, action: 'BOQ_IMPORT', entity: 'Project', details: { count: body.items.length, replace: !!body.replace } });
    const count = await prisma.bOQItem.count({ where: { projectId } });
    res.status(201).json({ ok: true, count });
  })
);

// ── Single-item CRUD (manual entry / corrections) ───────────────────────────

const itemSchema = z.object({
  srNo: z.string().optional(),
  description: z.string().min(1),
  category: z.string().optional(),
  roomZone: z.string().optional(),
  unit: z.string().optional(),
  plannedQty: z.number().nonnegative().optional(),
  isGroup: z.boolean().optional(),
  zoneId: z.string().nullable().optional(),
});

router.post(
  '/items',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
    if (project?.boqLocked) throw forbidden('BOQ is locked.');
    const body = itemSchema.parse(req.body);
    const max = await prisma.bOQItem.aggregate({ where: { projectId: req.params.projectId }, _max: { sortOrder: true } });
    const item = await prisma.bOQItem.create({
      data: { projectId: req.params.projectId, ...body, plannedQty: body.plannedQty ?? 0, sortOrder: (max._max.sortOrder ?? 0) + 1 },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_ITEM_CREATE', entity: 'BOQItem', entityId: item.id });
    res.status(201).json({ item });
  })
);

router.patch(
  '/items/:itemId',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
    if (project?.boqLocked) throw forbidden('BOQ is locked. Unlock first (versioned change).');
    const body = itemSchema.partial().parse(req.body);
    const item = await prisma.bOQItem.update({ where: { id: req.params.itemId }, data: body });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_ITEM_UPDATE', entity: 'BOQItem', entityId: item.id, details: body });
    res.json({ item });
  })
);

router.delete(
  '/items/:itemId',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { id: req.params.projectId } });
    if (project?.boqLocked) throw forbidden('BOQ is locked.');
    await prisma.bOQItem.delete({ where: { id: req.params.itemId } });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_ITEM_DELETE', entity: 'BOQItem', entityId: req.params.itemId });
    res.json({ ok: true });
  })
);

// GET .../boq/analysis — the AI-processed "bible" (clean procurement breakdown).
router.get(
  '/analysis',
  requireProjectMember,
  requirePage('boq'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const [items, project] = await Promise.all([
      prisma.bOQAnalysisItem.findMany({ where: { projectId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      prisma.project.findUnique({ where: { id: projectId }, select: { boqAnalyzedAt: true } }),
    ]);
    res.json({ items, analyzedAt: project?.boqAnalyzedAt ?? null, aiEnabled: !!aiProvider() });
  })
);

// POST .../boq/analyze — run the AI analysis over the raw BOQ and store it.
// Leaves the raw BOQItem table untouched (this is a separate processed table).
router.post(
  '/analyze',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    if (!aiProvider()) throw badRequest('AI is not configured. Set GROQ_API_KEY in server/.env.');

    const raw = await prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    if (raw.length === 0) throw badRequest('No BOQ items to analyze. Import the BOQ first.');

    const analyzed = await analyzeBOQ(raw.map((r) => ({ srNo: r.srNo, description: r.description, category: r.category, unit: r.unit, plannedQty: r.plannedQty })));
    if (!analyzed || analyzed.length === 0) throw badRequest('AI analysis returned no items. Try again.');

    // Replace any prior analysis (regenerate-able).
    await prisma.$transaction([
      prisma.bOQAnalysisItem.deleteMany({ where: { projectId } }),
      prisma.bOQAnalysisItem.createMany({
        data: analyzed.map((a, i) => ({
          projectId,
          srNo: a.srNo,
          itemName: a.itemName,
          category: a.category,
          quantity: a.quantity ?? null,
          unit: a.unit,
          specifications: a.specifications,
          requirements: a.requirements,
          dependencies: a.dependencies,
          notes: a.notes,
          sortOrder: i,
        })),
      }),
      prisma.project.update({ where: { id: projectId }, data: { boqAnalyzedAt: new Date() } }),
    ]);
    await audit({ userId: req.user!.sub, projectId, action: 'BOQ_AI_ANALYZE', entity: 'Project', details: { rawCount: raw.length, analyzedCount: analyzed.length, provider: aiProvider() } });
    res.status(201).json({ ok: true, provider: aiProvider(), rawCount: raw.length, analyzedCount: analyzed.length });
  })
);

// POST /api/projects/:projectId/boq/lock — lock baseline (FR-BQ-04).
router.post(
  '/lock',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    const now = new Date();
    await prisma.$transaction([
      prisma.project.update({ where: { id: req.params.projectId }, data: { boqLocked: true, boqLockedAt: now } }),
      prisma.bOQItem.updateMany({ where: { projectId: req.params.projectId, lockedAt: null }, data: { lockedAt: now } }),
    ]);
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_LOCK', entity: 'Project' });
    res.json({ ok: true, lockedAt: now });
  })
);

router.post(
  '/unlock',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    await prisma.project.update({ where: { id: req.params.projectId }, data: { boqLocked: false } });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_UNLOCK', entity: 'Project' });
    res.json({ ok: true });
  })
);

export default router;
