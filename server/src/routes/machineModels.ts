import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { extractTds } from '../services/tdsExtract';

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

  // Last purchased price per model (PRD §6b): the most recent AWARDED quotation
  // for a BOQ item that uses this model. Derived, so it never drifts.
  const awarded = await prisma.vendorQuotation.findMany({
    where: { status: 'AWARDED', boqItem: { machineModelId: { in: filtered.map((m) => m.id) } } },
    orderBy: { createdAt: 'desc' },
    select: { price: true, vendorName: true, createdAt: true, boqItem: { select: { machineModelId: true } } },
  }).catch(() => [] as any[]);
  const lastPaid = new Map<string, { price: number; vendorName: string; at: Date }>();
  for (const a of awarded) {
    const mid = a.boqItem?.machineModelId;
    if (!mid) continue;
    const cur = lastPaid.get(mid);
    if (!cur || a.createdAt > cur.at) lastPaid.set(mid, { price: a.price, vendorName: a.vendorName, at: a.createdAt });
  }

  res.json({
    models: filtered.map((m) => {
      const lp = lastPaid.get(m.id);
      return { ...m, lastPaidPrice: lp?.price ?? null, lastPaidVendor: lp?.vendorName ?? null, lastPaidAt: lp?.at ?? null };
    }),
  });
}));

const modelSchema = z.object({
  make: z.string().min(1),
  modelCode: z.string().min(1),
  capacityKW: z.coerce.number().nullable().optional(),
  refrigerantType: z.string().optional().nullable(),
  compressorType: z.string().optional().nullable(),
  applicableRooms: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
  // §6b — the model's reference price and its technical datasheet (TDS) link.
  unitPrice: z.coerce.number().nullable().optional(),
  tdsUrl: z.string().nullable().optional(),
  // TDS-extracted specs (Machine-Model/TDS PRD §1–§4). All optional — filled from
  // the datasheet or typed. `specs` is the full extracted key/value catch-all.
  tdsFormat: z.string().nullable().optional(),
  evaporatorTempC: z.coerce.number().nullable().optional(),
  condenserTempC: z.coerce.number().nullable().optional(),
  ambientTempC: z.coerce.number().nullable().optional(),
  airflow: z.string().nullable().optional(),
  finSpacing: z.string().nullable().optional(),
  fanDetail: z.string().nullable().optional(),
  powerInputKw: z.coerce.number().nullable().optional(),
  weightKg: z.coerce.number().nullable().optional(),
  dimensions: z.string().nullable().optional(),
  voltage: z.string().nullable().optional(),
  compressorModel: z.string().nullable().optional(),
  specs: z.any().optional(),
});

// The optional spec columns, so create/update can spread them without listing
// each one twice.
const SPEC_KEYS = ['tdsFormat', 'evaporatorTempC', 'condenserTempC', 'ambientTempC', 'airflow', 'finSpacing', 'fanDetail', 'powerInputKw', 'weightKg', 'dimensions', 'voltage', 'compressorModel', 'unitPrice', 'tdsUrl'] as const;
const specData = (b: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const k of SPEC_KEYS) if (b[k] !== undefined) out[k] = b[k];
  if (b.specs !== undefined) out.specs = b.specs ?? undefined;
  return out;
};

// POST /machine-models/extract-tds — upload a TDS and get the suggested fields
// back (suggest-only, like KYC). The form fills itself; the user confirms + saves.
// Handles the IDU and ODU formats (and any other via the vision fallback).
router.post('/extract-tds', requireEdit('machinemodels'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded (field: file)');
  const extracted = await extractTds(req.file.path, req.file.mimetype);
  // Keep the uploaded file's URL so the form can save it as the model's TDS.
  res.json({ extracted, tdsUrl: `/uploads/${req.file.filename}` });
}));

// POST /machine-models/:id/tds — attach a TDS to an existing model and re-extract,
// merging any newly-found fields the record is still missing.
router.post('/:id/tds', requireEdit('machinemodels'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded (field: file)');
  const model = await prisma.machineModel.findUnique({ where: { id: req.params.id } });
  if (!model) throw notFound('Machine model not found');
  const extracted = await extractTds(req.file.path, req.file.mimetype);
  const updated = await prisma.machineModel.update({
    where: { id: model.id },
    data: {
      tdsUrl: `/uploads/${req.file.filename}`,
      // Only fill blanks — never overwrite a value the user already set/confirmed.
      ...(model.tdsFormat == null && extracted.tdsFormat && { tdsFormat: extracted.tdsFormat }),
      ...(model.capacityKW == null && extracted.capacityKW != null && { capacityKW: extracted.capacityKW }),
      ...(model.refrigerantType == null && extracted.refrigerantType && { refrigerantType: extracted.refrigerantType }),
      ...(model.evaporatorTempC == null && extracted.evaporatorTempC != null && { evaporatorTempC: extracted.evaporatorTempC }),
      ...(model.condenserTempC == null && extracted.condenserTempC != null && { condenserTempC: extracted.condenserTempC }),
      ...(model.ambientTempC == null && extracted.ambientTempC != null && { ambientTempC: extracted.ambientTempC }),
      ...(model.airflow == null && extracted.airflow && { airflow: extracted.airflow }),
      ...(model.finSpacing == null && extracted.finSpacing && { finSpacing: extracted.finSpacing }),
      ...(model.fanDetail == null && extracted.fanDetail && { fanDetail: extracted.fanDetail }),
      ...(model.powerInputKw == null && extracted.powerInputKw != null && { powerInputKw: extracted.powerInputKw }),
      ...(model.weightKg == null && extracted.weightKg != null && { weightKg: extracted.weightKg }),
      ...(model.dimensions == null && extracted.dimensions && { dimensions: extracted.dimensions }),
      ...(model.voltage == null && extracted.voltage && { voltage: extracted.voltage }),
      ...(model.compressorModel == null && extracted.compressorModel && { compressorModel: extracted.compressorModel }),
      specs: extracted.specs && Object.keys(extracted.specs).length ? extracted.specs : model.specs ?? undefined,
    },
  });
  await audit({ userId: req.user!.sub, action: 'MACHINE_MODEL_TDS', entity: 'MachineModel', entityId: model.id, details: { format: extracted.tdsFormat, source: extracted.source } });
  res.json({ ok: true, model: updated, extracted });
}));

router.post('/', requireEdit('machinemodels'), asyncHandler(async (req, res) => {
  const b = modelSchema.parse(req.body);
  const model = await prisma.machineModel.create({
    data: {
      make: b.make, modelCode: b.modelCode, capacityKW: b.capacityKW ?? null,
      refrigerantType: b.refrigerantType ?? null, compressorType: b.compressorType ?? null,
      applicableRooms: b.applicableRooms ?? [],
      ...specData(b),
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
      ...specData(b),
      fullDisplayName: displayName(merged),
    },
  });
  await audit({ userId: req.user!.sub, action: 'MACHINE_MODEL_UPDATE', entity: 'MachineModel', entityId: model.id });
  res.json({ model });
}));

export default router;
