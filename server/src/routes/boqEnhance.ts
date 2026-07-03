import { Router } from 'express';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';

// Mounted at /api/projects/:projectId/boq-items
const router = Router({ mergeParams: true });
router.use(requireAuth);

// ── Feature 6: BOQ completeness check (powers AI flags + baseline-lock gate) ──
const EQUIP_RE = /(unit|compressor|condens|evaporator|refrigerat|scada|machine|chiller unit|blast)/i;
router.get('/completeness', requireProjectMember, requirePage('boq'), asyncHandler(async (req, res) => {
  const items = await prisma.bOQItem.findMany({ where: { projectId: req.params.projectId, isGroup: false } });
  const isEquip = (i: any) => i.itemCategory === 'EQUIPMENT' || (!i.itemCategory && EQUIP_RE.test(`${i.description} ${i.category}`));
  const missingQty = items.filter((i) => (i.plannedQty ?? 0) <= 0 && !/note|terms|scope/i.test(i.description)).map((i) => ({ id: i.id, description: i.description }));
  const missingModel = items.filter((i) => isEquip(i) && i.makeModelStatus !== 'CONFIRMED' && !i.makeModel).map((i) => ({ id: i.id, description: i.description }));
  const tbd = items.filter((i) => /\bTB[CD]\b/i.test(`${i.description} ${i.makeModel ?? ''} ${i.remarks ?? ''}`)).map((i) => ({ id: i.id, description: i.description }));
  const total = items.length || 1;
  const issues = missingQty.length + missingModel.length + tbd.length;
  const score = Math.max(0, Math.round(100 * (1 - issues / (total + total + total))));
  res.json({
    score,
    totals: { items: items.length, equipment: items.filter(isEquip).length },
    flags: {
      missingQty: { count: missingQty.length, items: missingQty.slice(0, 30) },
      missingModel: { count: missingModel.length, items: missingModel.slice(0, 30) },
      tbd: { count: tbd.length, items: tbd.slice(0, 30) },
    },
    canLock: missingModel.length === 0, // F1 baseline-lock gate
  });
}));

// ── Feature 1: set Make & Model on a BOQ equipment item ─────────────────────
router.patch('/:itemId/model', requireProjectMember, requireEdit('boq'), asyncHandler(async (req, res) => {
  const b = z.object({ machineModelId: z.string().nullable().optional(), makeModelRawText: z.string().optional() }).parse(req.body);
  const item = await prisma.bOQItem.findFirst({ where: { id: req.params.itemId, projectId: req.params.projectId } });
  if (!item) throw notFound('BOQ item not found');
  let status = item.makeModelStatus;
  let makeModel = item.makeModel;
  if (b.machineModelId) {
    const mm = await prisma.machineModel.findUnique({ where: { id: b.machineModelId } });
    if (!mm) throw badRequest('Machine model not found');
    status = 'CONFIRMED';
    makeModel = mm.fullDisplayName || `${mm.make} ${mm.modelCode}`;
  } else if (b.machineModelId === null) {
    status = 'MISSING';
  }
  const updated = await prisma.bOQItem.update({
    where: { id: item.id },
    data: { machineModelId: b.machineModelId ?? null, makeModelStatus: status, makeModel, ...(b.makeModelRawText !== undefined && { makeModelRawText: b.makeModelRawText }) },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_SET_MODEL', entity: 'BOQItem', entityId: item.id, details: { machineModelId: b.machineModelId } });
  res.json({ item: updated });
}));

// ── Feature 2: Item List per BOQ category ───────────────────────────────────
function recomputeMatch(items: { qty: number }[], plannedQty: number, tolerance: number) {
  const total = items.reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const lo = plannedQty * (1 - tolerance / 100), hi = plannedQty * (1 + tolerance / 100);
  return { total: Math.round(total * 1000) / 1000, matches: plannedQty <= 0 ? true : total >= lo && total <= hi };
}

router.get('/:itemId/item-list', requireProjectMember, requirePage('boq'), asyncHandler(async (req, res) => {
  const item = await prisma.bOQItem.findFirst({ where: { id: req.params.itemId, projectId: req.params.projectId } });
  if (!item) throw notFound('BOQ item not found');
  const lists = await prisma.bOQItemList.findMany({ where: { boqItemId: item.id }, orderBy: { uploadedAt: 'desc' } });
  const grandTotal = lists.reduce((s, l) => s + l.totalQty, 0);
  res.json({ lists, plannedQty: item.plannedQty, unit: item.unit, grandTotal: Math.round(grandTotal * 1000) / 1000 });
}));

// Parse an uploaded Excel/CSV into preview rows (Item Code, Description, Unit, Qty).
router.post('/:itemId/item-list/parse', requireProjectMember, requireEdit('boq'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded (field: file)');
  const wb = XLSX.readFile(req.file.path);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { defval: '' });
  const items = rows.map((r) => {
    const get = (keys: string[]) => { for (const k of Object.keys(r)) if (keys.some((x) => k.toLowerCase().includes(x))) return r[k]; return ''; };
    return {
      itemCode: String(get(['code', 'item no', 'sr']) || '').trim(),
      description: String(get(['desc', 'particular', 'item']) || '').trim(),
      unit: String(get(['unit', 'uom']) || '').trim(),
      qty: Number(String(get(['qty', 'quantity']) || '0').replace(/[^0-9.\-]/g, '')) || 0,
    };
  }).filter((i) => i.description || i.qty);
  res.json({ items });
}));

const saveSchema = z.object({
  vendorId: z.string().nullable().optional(),
  purchaseOrderId: z.string().nullable().optional(),
  items: z.array(z.object({ itemCode: z.string().optional(), description: z.string().default(''), unit: z.string().optional(), qty: z.coerce.number().default(0) })),
  toleranceUsed: z.coerce.number().default(10),
  overrideNote: z.string().optional(),
});
router.post('/:itemId/item-list', requireProjectMember, requireEdit('boq'), asyncHandler(async (req, res) => {
  const item = await prisma.bOQItem.findFirst({ where: { id: req.params.itemId, projectId: req.params.projectId } });
  if (!item) throw notFound('BOQ item not found');
  const b = saveSchema.parse(req.body);
  const { total, matches } = recomputeMatch(b.items, item.plannedQty, b.toleranceUsed);
  if (!matches && !b.overrideNote) throw badRequest(`Item list total (${total}) is outside ±${b.toleranceUsed}% of planned (${item.plannedQty}). Add a justification note to override.`, { total, plannedQty: item.plannedQty });
  const list = await prisma.bOQItemList.create({
    data: {
      boqItemId: item.id, vendorId: b.vendorId ?? null, purchaseOrderId: b.purchaseOrderId ?? null,
      items: b.items as any, totalQty: total, matchesBoqQty: matches, toleranceUsed: b.toleranceUsed,
      overrideNote: b.overrideNote, uploadedById: req.user!.sub,
    },
  });
  await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'BOQ_ITEM_LIST_ADD', entity: 'BOQItemList', entityId: list.id, details: { total, matches } });
  res.status(201).json({ list });
}));

router.delete('/:itemId/item-list/:listId', requireProjectMember, requireEdit('boq'), asyncHandler(async (req, res) => {
  await prisma.bOQItemList.deleteMany({ where: { id: req.params.listId, boqItemId: req.params.itemId } });
  res.json({ ok: true });
}));

export default router;
