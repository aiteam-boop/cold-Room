// ── Global Deposit Tracking (all projects) ───────────────────────────────────
// A PO/WO line marked `isDeposit` is a refundable/adjustable deposit paid to a
// vendor. This router lists every such deposit across ALL projects and tracks its
// recovery (amount received back, reference, status). The "required" amount is read
// live from the line's total; the recovery data lives in DepositRecovery (keyed by
// docId + normalized description) so a PO re-save never wipes it.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, notFound } from '../lib/errors';
import { requireAuth, requirePage, requireEdit } from '../middleware/authMiddleware';

const router = Router();
router.use(requireAuth);

// Stable match key for a deposit line within a doc — normalized description.
const descKey = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);

// GET /deposits — every deposit line across all projects + its recovery tracking.
router.get('/', requirePage('po'), asyncHandler(async (_req, res) => {
  const lines = await prisma.procurementLineItem.findMany({
    where: { isDeposit: true },
    include: { doc: { select: { id: true, docNumber: true, type: true, vendorName: true, projectId: true, docDate: true, createdAt: true, project: { select: { name: true, siteSupervisor: true, siteSupervisorId: true } } } } },
    orderBy: { doc: { createdAt: 'desc' } },
  });
  const recs = await prisma.depositRecovery.findMany({});
  const recBy = new Map(recs.map((r) => [`${r.docId}::${r.descKey}`, r]));
  const deposits = lines
    .filter((l) => l.doc)
    .map((l) => {
      const rec = recBy.get(`${l.docId}::${descKey(l.description)}`) || null;
      const required = Number(l.totalPrice) || 0;
      const received = rec ? Number(rec.amountReceived) || 0 : 0;
      return {
        lineId: l.id, docId: l.docId, docNumber: l.doc!.docNumber, type: l.doc!.type,
        projectId: l.doc!.projectId, projectName: l.doc!.project?.name ?? null,
        siteSupervisor: l.doc!.project?.siteSupervisor ?? null,
        vendorName: l.doc!.vendorName ?? null, description: l.description, note: l.depositNote ?? null,
        qty: l.qty, unitPrice: l.unitPrice,
        amountRequired: required, amountReceived: received, pending: Math.round((required - received) * 100) / 100,
        refDetails: rec?.refDetails ?? null, status: rec?.status ?? 'HELD',
        date: l.doc!.docDate ?? l.doc!.createdAt,
      };
    });
  const totals = deposits.reduce((a, d) => ({ required: a.required + d.amountRequired, received: a.received + d.amountReceived, pending: a.pending + d.pending }), { required: 0, received: 0, pending: 0 });
  res.json({ deposits, totals });
}));

// PATCH /deposits/recovery — upsert the recovery tracking for one deposit line.
const recSchema = z.object({
  docId: z.string(),
  description: z.string(),
  amountReceived: z.coerce.number().min(0).optional(),
  refDetails: z.string().max(2000).nullable().optional(),
  status: z.enum(['HELD', 'REFUNDED', 'ADJUSTED']).optional(),
});
router.patch('/recovery', requireEdit('po'), asyncHandler(async (req, res) => {
  const b = recSchema.parse(req.body);
  const line = await prisma.procurementLineItem.findFirst({
    where: { docId: b.docId, isDeposit: true, description: b.description },
    include: { doc: { select: { docNumber: true, projectId: true } } },
  });
  if (!line || !line.doc) throw notFound('Deposit line not found.');
  const key = descKey(b.description);
  const recovery = await prisma.depositRecovery.upsert({
    where: { docId_descKey: { docId: b.docId, descKey: key } },
    create: { projectId: line.doc.projectId, docId: b.docId, docNumber: line.doc.docNumber, descKey: key, amountReceived: b.amountReceived ?? 0, refDetails: b.refDetails ?? null, status: b.status ?? 'HELD' },
    update: { ...(b.amountReceived !== undefined && { amountReceived: b.amountReceived }), ...(b.refDetails !== undefined && { refDetails: b.refDetails }), ...(b.status !== undefined && { status: b.status }) },
  });
  res.json({ ok: true, recovery });
}));

export default router;
