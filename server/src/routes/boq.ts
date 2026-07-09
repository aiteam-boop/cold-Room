import { Router } from 'express';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage, requireEdit, requireFinancialView } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { parseBOQFile } from '../services/boqParser';
import { aiProvider } from '../services/boqParser';
import { analyzeBOQ } from '../services/boqAnalyzer';
import { audit } from '../lib/audit';
import { maskFinancials } from '../lib/financial';
import { loadProjectProgress } from '../services/projectProgress';
import { buildCostSheet, type CostPORow } from '../services/boqCost';

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

// GET /api/projects/:projectId/boq/cost — the BOQ Cost sheet (Sprint PRD §6).
// Same BOQ rows as the progress view, different columns. Read-only by design:
// costs are derived from approved POs, never entered here.
//
// Site engineers (hideFinancials) get the tab with every rupee value nulled —
// they see quantity columns only. maskFinancials handles that at the payload
// level, so prices never reach the browser.
router.get(
  '/cost',
  requireProjectMember,
  requirePage('boq'),
  asyncHandler(async (req, res) => {
    const sheet = await buildCostSheet(req.params.projectId);
    res.json(maskFinancials(sheet, req.account));
  })
);

// GET .../boq/cost/export — the same sheet as an .xlsx. Behind requireFinancialView
// because an export with the money columns stripped would be misleading.
router.get(
  '/cost/export',
  requireProjectMember,
  requirePage('boq'),
  requireFinancialView,
  asyncHandler(async (req, res) => {
    const [{ items, unlinked }, project] = await Promise.all([
      buildCostSheet(req.params.projectId),
      prisma.project.findUnique({ where: { id: req.params.projectId }, select: { name: true } }),
    ]);

    // Only APPROVED GRNs are receipts, so only they name a GRN in the export.
    const approvedGrnNumbers = (pos: CostPORow[]) =>
      [...new Set(pos.flatMap((p) => p.grns.filter((g) => g.status === 'APPROVED').map((g) => g.grnNumber)))].join(', ');
    const invoiceNumbers = (pos: CostPORow[]) =>
      [...new Set(pos.flatMap((p) => p.grns.map((g) => g.invoiceNumber).filter(Boolean) as string[]))].join(', ');

    // One row per BOQ item, then one indented row per linked PO beneath it —
    // mirroring how the sub-rows render on screen.
    const rows: Record<string, unknown>[] = [];
    for (const it of items) {
      rows.push({
        'Sr. No.': it.srNo ?? '', Description: it.description, 'Room / Zone': it.roomZone ?? '',
        'Make & Model': it.makeModel ?? '', Unit: it.unit ?? '',
        'Planned Qty': it.plannedQty, 'Installed Qty': it.installedQty,
        'PO Number(s)': it.pos.map((p) => p.docNumber).join(', '),
        'Vendor Name': [...new Set(it.pos.map((p) => p.vendorName).filter(Boolean))].join(', '),
        'Qty Ordered': it.totalOrderedQty, 'Unit Price': '',
        'Total Cost': it.totalOrderedCost, 'Advance Paid': it.totalAdvancePaid,
        'Balance Pending': it.totalBalancePending, 'Payment Status': it.paymentStatus,
        'Qty Received': it.totalReceivedQty, 'Receipt Status': it.receiptStatus,
        'GRN No(s).': approvedGrnNumbers(it.pos), 'Invoice No(s).': invoiceNumbers(it.pos),
      });
      if (it.pos.length > 1) {
        for (const p of it.pos) {
          rows.push({
            'Sr. No.': '', Description: `    ↳ ${p.docNumber}`, 'Room / Zone': '', 'Make & Model': '', Unit: '',
            'Planned Qty': '', 'Installed Qty': '',
            'PO Number(s)': p.docNumber, 'Vendor Name': p.vendorName ?? '',
            'Qty Ordered': p.qtyOrdered, 'Unit Price': p.unitPrice,
            'Total Cost': p.totalCost, 'Advance Paid': p.advancePaid,
            'Balance Pending': p.balancePending, 'Payment Status': p.paymentStatus,
            'Qty Received': p.qtyReceived, 'Receipt Status': p.receiptStatus,
            'GRN No(s).': approvedGrnNumbers([p]), 'Invoice No(s).': invoiceNumbers([p]),
          });
        }
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'BOQ Cost');
    if (unlinked.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(unlinked.map((u) => ({
        'PO Number': u.docNumber, Status: u.docStatus, Vendor: u.vendorName ?? '', Description: u.description,
        Qty: u.qtyOrdered, 'Unit Price': u.unitPrice, 'Total Cost': u.totalCost,
      }))), 'Unlinked POs');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const safeName = (project?.name ?? 'project').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-BOQ-Cost.xlsx"`);
    res.send(buf);
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
      makeModel: z.string().optional(),
      remarks: z.string().optional(),
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
    // Bulk-insert in one round trip. The old per-row create loop blew past the
    // interactive-transaction timeout against a remote DB (Atlas), since 150
    // sequential inserts × network latency > 5s (Prisma P2028). createMany is a
    // single op; we also raise the tx timeout as a safety margin for large BOQs.
    await prisma.$transaction(
      async (tx) => {
        if (body.replace) {
          await tx.progressEntry.deleteMany({ where: { projectId } });
          await tx.bOQItem.deleteMany({ where: { projectId } });
        }
        await tx.bOQItem.createMany({
          data: body.items.map((it, idx) => ({
            projectId,
            srNo: it.srNo,
            description: it.description,
            category: it.category,
            roomZone: it.roomZone,
            unit: it.unit,
            makeModel: it.makeModel,
            remarks: it.remarks,
            plannedQty: it.plannedQty,
            isGroup: it.isGroup ?? false,
            sortOrder: idx,
          })),
        });
      },
      { timeout: 30000, maxWait: 10000 }
    );
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
  makeModel: z.string().optional(),
  remarks: z.string().optional(),
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
