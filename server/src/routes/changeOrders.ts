import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage, requireEdit } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { notifyUser, notifyProjectRoles } from '../services/notify';

// Mounted at /api/projects/:projectId/change-orders
const router = Router({ mergeParams: true });
router.use(requireAuth);

async function nextCoNumber(projectId: string, projectName?: string | null) {
  const code = (projectName || 'PRJ').replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || 'PRJ';
  const existing = await prisma.changeOrder.findMany({ where: { projectId }, select: { coNumber: true } });
  const max = existing.reduce((m, c) => Math.max(m, parseInt((c.coNumber.match(/(\d+)$/) || [])[1] || '0', 10) || 0), 0);
  return `CO-${code}-${String(max + 1).padStart(3, '0')}`;
}

router.get('/', requireProjectMember, requirePage('changeorders'), asyncHandler(async (req, res) => {
  const orders = await prisma.changeOrder.findMany({
    where: { projectId: req.params.projectId }, orderBy: { createdAt: 'desc' },
    include: { boqItem: { select: { description: true, unit: true } } },
  });
  res.json({ orders });
}));

const coSchema = z.object({
  boqItemId: z.string().nullable().optional(),
  type: z.enum(['QTY_INCREASE', 'QTY_DECREASE', 'NEW_ITEM', 'SUBSTITUTION']),
  description: z.string().min(1),
  changeQty: z.coerce.number().default(0),
  unit: z.string().optional().nullable(),
  costImpact: z.coerce.number().nullable().optional(),
  paidByClient: z.enum(['YES', 'NO', 'TBD']).optional(),
  justification: z.string().optional(),
});

router.post('/', requireProjectMember, requireEdit('changeorders'), asyncHandler(async (req, res) => {
  const b = coSchema.parse(req.body);
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId }, select: { name: true } });
  let originalQty: number | null = null, newTotalQty: number | null = null, unit = b.unit ?? null;
  if (b.boqItemId) {
    const item = await prisma.bOQItem.findFirst({ where: { id: b.boqItemId, projectId: req.params.projectId } });
    if (!item) throw badRequest('BOQ item not found in this project');
    originalQty = item.plannedQty;
    newTotalQty = Math.round((item.plannedQty + b.changeQty) * 1000) / 1000;
    unit = unit ?? item.unit;
  }
  const co = await prisma.changeOrder.create({
    data: {
      coNumber: await nextCoNumber(req.params.projectId, project?.name), projectId: req.params.projectId,
      boqItemId: b.boqItemId ?? null, type: b.type, description: b.description,
      originalQty, changeQty: b.changeQty, newTotalQty, unit, costImpact: b.costImpact ?? null,
      paidByClient: b.paidByClient, justification: b.justification, status: 'DRAFT', createdById: req.user!.sub,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'CO_CREATE', entity: 'ChangeOrder', entityId: co.id, details: { type: b.type } });
  res.status(201).json({ order: co });
}));

router.patch('/:id', requireProjectMember, requireEdit('changeorders'), asyncHandler(async (req, res) => {
  const co = await prisma.changeOrder.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!co) throw notFound();
  if (co.status === 'APPROVED') throw forbidden('Approved change orders are locked.');
  const b = coSchema.partial().parse(req.body);
  const updated = await prisma.changeOrder.update({ where: { id: co.id }, data: { ...b, ...(b.changeQty !== undefined && co.originalQty != null ? { newTotalQty: Math.round((co.originalQty + b.changeQty) * 1000) / 1000 } : {}) } });
  res.json({ order: updated });
}));

router.post('/:id/submit', requireProjectMember, requireEdit('changeorders'), asyncHandler(async (req, res) => {
  const co = await prisma.changeOrder.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!co) throw notFound();
  if (co.status !== 'DRAFT') throw badRequest('Only draft change orders can be submitted');
  const updated = await prisma.changeOrder.update({ where: { id: co.id }, data: { status: 'PENDING' } });
  await notifyProjectRoles(req.params.projectId, ['ADMIN'], { type: 'CO_SUBMITTED', title: 'Change Order pending approval', message: `${co.coNumber}: ${co.description.slice(0, 60)}`, relatedDocType: 'ChangeOrder', relatedDocId: co.id, link: `/projects/${req.params.projectId}` }, req.user!.sub);
  res.json({ order: updated });
}));

// Approve — reuses the PO/WO approval pattern. Updates BOQ baseline + history.
router.post('/:id/approve', requireProjectMember, asyncHandler(async (req, res) => {
  if (!['ADMIN'].includes(req.projectRole!) && req.account?.role !== 'ADMIN') throw forbidden('Only the approver (AA sir/Admin) can approve');
  const co = await prisma.changeOrder.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!co) throw notFound();
  if (co.status !== 'PENDING') throw badRequest('Change order is not pending approval');

  // Apply to BOQ baseline (keep history so the original is never lost).
  if (co.type === 'NEW_ITEM' && !co.boqItemId) {
    // A NEW ITEM change order adds a brand-new trackable BOQ line on approval.
    const max = await prisma.bOQItem.aggregate({ where: { projectId: req.params.projectId }, _max: { sortOrder: true } });
    const newItem = await prisma.bOQItem.create({
      data: {
        projectId: req.params.projectId,
        description: co.description,
        category: 'Change Orders',
        unit: co.unit,
        plannedQty: co.changeQty ?? 0,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
      },
    });
    const history = [{ at: new Date().toISOString(), coNumber: co.coNumber, created: true, qty: co.changeQty, by: req.user!.sub }];
    // Link the CO to the item it created, and record the new-total for display.
    await prisma.changeOrder.update({ where: { id: co.id }, data: { boqItemId: newItem.id, newTotalQty: co.changeQty ?? 0, history: history as any } });
  } else if (co.boqItemId && co.newTotalQty != null) {
    const item = await prisma.bOQItem.findUnique({ where: { id: co.boqItemId } });
    if (item) {
      const history = [{ at: new Date().toISOString(), coNumber: co.coNumber, from: item.plannedQty, to: co.newTotalQty, by: req.user!.sub }];
      await prisma.bOQItem.update({ where: { id: item.id }, data: { plannedQty: co.newTotalQty } });
      await prisma.changeOrder.update({ where: { id: co.id }, data: { history: history as any } });
    }
  }
  await prisma.changeOrder.update({ where: { id: co.id }, data: { status: 'APPROVED', approvedById: req.user!.sub, approvedAt: new Date() } });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'CO_APPROVE', entity: 'ChangeOrder', entityId: co.id, details: { newTotalQty: co.newTotalQty } });
  if (co.createdById) await notifyUser(co.createdById, { type: 'CO_APPROVED', title: 'Change Order approved', message: `${co.coNumber} approved. BOQ baseline updated.`, projectId: req.params.projectId, relatedDocType: 'ChangeOrder', relatedDocId: co.id, link: `/projects/${req.params.projectId}` });
  res.json({ ok: true });
}));

router.post('/:id/reject', requireProjectMember, asyncHandler(async (req, res) => {
  if (!['ADMIN'].includes(req.projectRole!) && req.account?.role !== 'ADMIN') throw forbidden();
  const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body);
  const co = await prisma.changeOrder.findFirst({ where: { id: req.params.id, projectId: req.params.projectId } });
  if (!co) throw notFound();
  await prisma.changeOrder.update({ where: { id: co.id }, data: { status: 'REJECTED', rejectionReason: reason } });
  if (co.createdById) await notifyUser(co.createdById, { type: 'CO_REJECTED', title: 'Change Order rejected', message: `${co.coNumber}: ${reason}`, projectId: req.params.projectId, relatedDocType: 'ChangeOrder', relatedDocId: co.id, link: `/projects/${req.params.projectId}` });
  res.json({ ok: true });
}));

export default router;
