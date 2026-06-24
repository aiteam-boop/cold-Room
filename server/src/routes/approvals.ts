import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requirePage } from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';

const router = Router();
router.use(requireAuth);

// GET /api/approvals/pending — all PO/WO pending approval across projects.
router.get(
  '/pending',
  requirePage('approvals'),
  asyncHandler(async (req, res) => {
    const docs = await prisma.procurementDoc.findMany({
      where: { status: 'PENDING_APPROVAL' },
      orderBy: { updatedAt: 'desc' },
      include: { project: { select: { id: true, name: true } } },
    });
    const creatorIds = [...new Set(docs.map((d) => d.createdById).filter(Boolean) as string[])];
    const creators = await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } });
    const nameById = new Map(creators.map((c) => [c.id, c.name]));
    res.json({
      docs: maskFinancials(docs.map((d) => ({
        id: d.id, projectId: d.projectId, projectName: d.project?.name,
        type: d.type, docNumber: d.docNumber, vendorName: d.vendorName,
        basicAmount: d.basicAmount, finalAmount: d.finalAmount,
        createdBy: d.createdById ? nameById.get(d.createdById) : null, submittedAt: d.updatedAt,
      })), req.account),
    });
  })
);

export default router;
