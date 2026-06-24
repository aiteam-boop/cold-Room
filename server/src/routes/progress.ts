import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requireEdit, requirePage, requireSection } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { loadProjectProgress } from '../services/projectProgress';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// Remaining quantity for an item (planned - approved installed). Used for the
// over-installation guard (FR-PT-03 / §8.4).
async function remainingFor(boqItemId: string): Promise<{ planned: number; remaining: number; unit: string | null }> {
  const item = await prisma.bOQItem.findUnique({ where: { id: boqItemId } });
  if (!item) throw notFound('BOQ item not found');
  const agg = await prisma.progressEntry.aggregate({
    where: { boqItemId, status: 'APPROVED' },
    _sum: { quantityInstalled: true },
  });
  const installed = agg._sum.quantityInstalled ?? 0;
  return { planned: item.plannedQty, remaining: Math.max(item.plannedQty - installed, 0), unit: item.unit };
}

// GET /api/projects/:projectId/progress — chronological feed (history).
router.get(
  '/',
  requireProjectMember,
  requirePage('boq'),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const entries = await prisma.progressEntry.findMany({
      where: { projectId: req.params.projectId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        boqItem: { select: { id: true, description: true, unit: true, category: true, roomZone: true } },
        submittedBy: { select: { id: true, name: true } },
        approvedBy: { select: { id: true, name: true } },
      },
    });
    res.json({ entries });
  })
);

// GET /api/projects/:projectId/progress/pending — supervisor approval queue.
router.get(
  '/pending',
  requireProjectMember,
  requirePage('boq'),
  requireSection('canApprove'),
  asyncHandler(async (req, res) => {
    const entries = await prisma.progressEntry.findMany({
      where: { projectId: req.params.projectId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        boqItem: { select: { id: true, description: true, unit: true, plannedQty: true, category: true } },
        submittedBy: { select: { id: true, name: true } },
      },
    });
    res.json({ entries });
  })
);

const entrySchema = z.object({
  boqItemId: z.string().min(1),
  date: z.string(),
  quantityInstalled: z.number().positive(),
  remarks: z.string().optional(),
  photoUrl: z.string().optional(),
});

// POST /api/projects/:projectId/progress — log a daily entry (FR-PT-01/02/03).
// Supports optional multipart photo upload (field: photo).
router.post(
  '/',
  requireProjectMember,
  requireEdit('boq'),
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    // Body may be JSON or multipart; coerce numeric field.
    const raw = {
      boqItemId: req.body.boqItemId,
      date: req.body.date,
      quantityInstalled: typeof req.body.quantityInstalled === 'string' ? Number(req.body.quantityInstalled) : req.body.quantityInstalled,
      remarks: req.body.remarks || undefined,
      photoUrl: req.body.photoUrl || undefined,
    };
    const body = entrySchema.parse(raw);

    const item = await prisma.bOQItem.findFirst({ where: { id: body.boqItemId, projectId: req.params.projectId } });
    if (!item) throw notFound('BOQ item not found in this project');
    if (item.isGroup) throw badRequest('Cannot log progress against a category header row.');

    const { remaining } = await remainingFor(body.boqItemId);
    // Validation: > 0 and <= remaining (FR-PT-03). Only enforce ceiling when a
    // planned qty exists (>0); TBC items (plannedQty 0) are not capped.
    if (item.plannedQty > 0 && body.quantityInstalled > remaining + 1e-9) {
      throw badRequest(`Quantity exceeds remaining planned (${remaining} ${item.unit ?? ''}).`, { remaining, unit: item.unit });
    }

    const photoUrl = req.file ? `/uploads/${req.file.filename}` : body.photoUrl;
    const entry = await prisma.progressEntry.create({
      data: {
        projectId: req.params.projectId,
        boqItemId: body.boqItemId,
        submittedById: req.user!.sub,
        date: new Date(body.date),
        quantityInstalled: body.quantityInstalled,
        unit: item.unit,
        remarks: body.remarks,
        photoUrl,
        status: 'PENDING',
      },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ENTRY_SUBMIT', entity: 'ProgressEntry', entityId: entry.id, details: { qty: body.quantityInstalled, item: item.description } });
    res.status(201).json({ entry });
  })
);

// POST .../progress/bulk — multiple activities at once (FR-PT-06).
const bulkSchema = z.object({
  date: z.string(),
  entries: z.array(z.object({ boqItemId: z.string(), quantityInstalled: z.number().positive(), remarks: z.string().optional() })),
});
router.post(
  '/bulk',
  requireProjectMember,
  requireEdit('boq'),
  asyncHandler(async (req, res) => {
    const body = bulkSchema.parse(req.body);
    const created: string[] = [];
    const errors: { boqItemId: string; error: string }[] = [];
    for (const e of body.entries) {
      const item = await prisma.bOQItem.findFirst({ where: { id: e.boqItemId, projectId: req.params.projectId } });
      if (!item || item.isGroup) { errors.push({ boqItemId: e.boqItemId, error: 'Invalid item' }); continue; }
      const { remaining } = await remainingFor(e.boqItemId);
      if (item.plannedQty > 0 && e.quantityInstalled > remaining + 1e-9) { errors.push({ boqItemId: e.boqItemId, error: `Exceeds remaining (${remaining})` }); continue; }
      const entry = await prisma.progressEntry.create({
        data: { projectId: req.params.projectId, boqItemId: e.boqItemId, submittedById: req.user!.sub, date: new Date(body.date), quantityInstalled: e.quantityInstalled, unit: item.unit, remarks: e.remarks, status: 'PENDING' },
      });
      created.push(entry.id);
    }
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ENTRY_BULK_SUBMIT', entity: 'ProgressEntry', details: { created: created.length, failed: errors.length } });
    res.status(201).json({ created: created.length, errors });
  })
);

// POST .../progress/:entryId/approve (FR-PT-04/05).
router.post(
  '/:entryId/approve',
  requireProjectMember,
  requireSection('canApprove'),
  asyncHandler(async (req, res) => {
    const entry = await prisma.progressEntry.findFirst({ where: { id: req.params.entryId, projectId: req.params.projectId } });
    if (!entry) throw notFound('Entry not found');
    if (entry.status !== 'PENDING') throw badRequest(`Entry is already ${entry.status}`);

    // Re-validate ceiling at approval time (other entries may have landed).
    const item = await prisma.bOQItem.findUnique({ where: { id: entry.boqItemId } });
    if (item && item.plannedQty > 0) {
      const { remaining } = await remainingFor(entry.boqItemId);
      if (entry.quantityInstalled > remaining + 1e-9) {
        throw badRequest(`Approving would exceed planned quantity. Remaining: ${remaining} ${item.unit ?? ''}.`);
      }
    }
    const updated = await prisma.progressEntry.update({
      where: { id: entry.id },
      data: { status: 'APPROVED', approvedById: req.user!.sub, approvedAt: new Date() },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ENTRY_APPROVE', entity: 'ProgressEntry', entityId: entry.id });
    res.json({ entry: updated });
  })
);

const rejectSchema = z.object({ reason: z.string().min(1) });
router.post(
  '/:entryId/reject',
  requireProjectMember,
  requireSection('canApprove'),
  asyncHandler(async (req, res) => {
    const body = rejectSchema.parse(req.body);
    const entry = await prisma.progressEntry.findFirst({ where: { id: req.params.entryId, projectId: req.params.projectId } });
    if (!entry) throw notFound('Entry not found');
    if (entry.status !== 'PENDING') throw badRequest(`Entry is already ${entry.status}`);
    const updated = await prisma.progressEntry.update({
      where: { id: entry.id },
      data: { status: 'REJECTED', rejectionReason: body.reason, approvedById: req.user!.sub, approvedAt: new Date() },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ENTRY_REJECT', entity: 'ProgressEntry', entityId: entry.id, details: { reason: body.reason } });
    res.json({ entry: updated });
  })
);

// POST .../progress/:entryId/void — admin-only soft delete with reason (§8.4).
const voidSchema = z.object({ reason: z.string().min(1) });
router.post(
  '/:entryId/void',
  requireProjectMember,
  requireSection('canApprove'),
  asyncHandler(async (req, res) => {
    const body = voidSchema.parse(req.body);
    const entry = await prisma.progressEntry.findFirst({ where: { id: req.params.entryId, projectId: req.params.projectId } });
    if (!entry) throw notFound('Entry not found');
    const updated = await prisma.progressEntry.update({
      where: { id: entry.id },
      data: { status: 'VOIDED', voidReason: body.reason },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ENTRY_VOID', entity: 'ProgressEntry', entityId: entry.id, details: { reason: body.reason } });
    res.json({ entry: updated });
  })
);

export default router;
