import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, notFound } from '../lib/errors';
import { requireAuth, requirePage, requireEdit } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';

const router = Router();
router.use(requireAuth);

// Build the friendly display name: "Bitzer — S6F-30.2Y-40P (27 kW, R404A)".
function displayName(m: { make: string; modelCode: string; capacityKW?: number | null; refrigerantType?: string | null }) {
  const extra = [m.capacityKW ? `${m.capacityKW} kW` : null, m.refrigerantType || null].filter(Boolean).join(', ');
  return `${m.make} — ${m.modelCode}${extra ? ` (${extra})` : ''}`;
}

// GET /api/machine-models?q=&room= — list/search the master.
router.get('/', requirePage('machinemodels'), asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const room = typeof req.query.room === 'string' ? req.query.room.trim() : '';
  const models = await prisma.machineModel.findMany({
    where: {
      ...(req.query.includeInactive === 'true' ? {} : { isActive: true }),
      ...(room ? { applicableRooms: { has: room } } : {}),
    },
    orderBy: [{ make: 'asc' }, { modelCode: 'asc' }],
  });
  const filtered = q
    ? models.filter((m) => `${m.make} ${m.modelCode} ${m.fullDisplayName} ${m.refrigerantType} ${m.compressorType}`.toLowerCase().includes(q.toLowerCase()))
    : models;
  res.json({ models: filtered });
}));

const modelSchema = z.object({
  make: z.string().min(1),
  modelCode: z.string().min(1),
  capacityKW: z.coerce.number().nullable().optional(),
  refrigerantType: z.string().optional().nullable(),
  compressorType: z.string().optional().nullable(),
  applicableRooms: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

router.post('/', requireEdit('machinemodels'), asyncHandler(async (req, res) => {
  const b = modelSchema.parse(req.body);
  const model = await prisma.machineModel.create({
    data: {
      make: b.make, modelCode: b.modelCode, capacityKW: b.capacityKW ?? null,
      refrigerantType: b.refrigerantType ?? null, compressorType: b.compressorType ?? null,
      applicableRooms: b.applicableRooms ?? [],
      fullDisplayName: displayName(b),
    },
  });
  await audit({ userId: req.user!.sub, action: 'MACHINE_MODEL_CREATE', entity: 'MachineModel', entityId: model.id, details: { make: b.make, modelCode: b.modelCode } });
  res.status(201).json({ model });
}));

router.patch('/:id', requireEdit('machinemodels'), asyncHandler(async (req, res) => {
  const b = modelSchema.partial().parse(req.body);
  const existing = await prisma.machineModel.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Machine model not found');
  const merged = { ...existing, ...b } as any;
  const model = await prisma.machineModel.update({
    where: { id: req.params.id },
    data: {
      ...(b.make !== undefined && { make: b.make }),
      ...(b.modelCode !== undefined && { modelCode: b.modelCode }),
      ...(b.capacityKW !== undefined && { capacityKW: b.capacityKW }),
      ...(b.refrigerantType !== undefined && { refrigerantType: b.refrigerantType }),
      ...(b.compressorType !== undefined && { compressorType: b.compressorType }),
      ...(b.applicableRooms !== undefined && { applicableRooms: b.applicableRooms }),
      ...(b.isActive !== undefined && { isActive: b.isActive }),
      fullDisplayName: displayName(merged),
    },
  });
  await audit({ userId: req.user!.sub, action: 'MACHINE_MODEL_UPDATE', entity: 'MachineModel', entityId: model.id });
  res.json({ model });
}));

export default router;
