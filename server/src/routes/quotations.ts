// ── Vendor quotations & award (BOQ & Budget PRD v1 §4) ────────────────────────
// Mounted at /api/projects/:projectId/quotations.
//
// Collect 3+ quotes per BOQ item, compare them (L1 = lowest, marked automatically),
// then AWARD one. The cheapest is not automatically the winner — delivery, quality
// and payment terms matter — so an award records the chosen vendor AND a reason,
// and the reason is mandatory when the pick is not L1.
//
// A re-quote after negotiation supersedes the previous one; the old row is kept
// (SUPERSEDED) so the price history is never lost.
//
// Quotations are pricing, so the whole router is behind requireFinancialView.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requireEdit, requireFinancialView } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// The minimum number of quotes the award normally needs (PRD §4). Below this the
// award is BLOCKED — but a single-source item can be awarded with an override
// reason, so we both warn and block by default.
const MIN_QUOTES = 3;

/** Mark L1 (lowest price) / L2 on a set of ACTIVE quotes, cheapest first. */
function withRanks(quotes: { id: string; price: number; status: string }[]) {
  const active = quotes.filter((q) => q.status !== 'SUPERSEDED').slice().sort((a, b) => a.price - b.price);
  const rank = new Map<string, string>();
  active.forEach((q, i) => rank.set(q.id, i === 0 ? 'L1' : i === 1 ? 'L2' : ''));
  return rank;
}

// GET /quotations/history?boqItemId=… — vendor price history for this item, the
// other way round: every price ever quoted for the SAME item (matched by
// description, across all projects), by vendor, newest first (PRD §6a). So the
// buyer knows what a fair price is before they even ask.
router.get('/history', requireProjectMember, requireFinancialView, asyncHandler(async (req, res) => {
  const boqItemId = String(req.query.boqItemId || '');
  const anchor = await prisma.bOQItem.findFirst({ where: { id: boqItemId, projectId: req.params.projectId }, select: { description: true } });
  if (!anchor) throw notFound('BOQ item not found');
  // Match on the item description — the same spare is described the same way.
  const rows = await prisma.vendorQuotation.findMany({
    where: { boqItem: { description: anchor.description } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, vendorName: true, price: true, status: true, createdAt: true, deliveryDate: true, paymentTerms: true,
      project: { select: { name: true } },
    },
    take: 100,
  });
  res.json({ description: anchor.description, history: rows.map((r) => ({ ...r, projectName: r.project?.name ?? null, awarded: r.status === 'AWARDED', project: undefined })) });
}));

// GET /quotations/item/:boqItemId — the comparison sheet for one BOQ item:
// every quotation, L1/L2 marked, plus the award and the item's budget.
router.get('/item/:boqItemId', requireProjectMember, requireFinancialView, asyncHandler(async (req, res) => {
  const { projectId, boqItemId } = req.params;
  const item = await prisma.bOQItem.findFirst({
    where: { id: boqItemId, projectId },
    select: {
      id: true, description: true, unit: true, plannedQty: true,
      awardedQuotationId: true, awardReason: true, awardedAt: true, awardedById: true,
      budgetLine: { select: { budgetAmount: true, budgetQty: true, budgetRate: true } },
    },
  });
  if (!item) throw notFound('BOQ item not found');
  const quotes = await prisma.vendorQuotation.findMany({ where: { boqItemId, projectId }, orderBy: [{ status: 'asc' }, { price: 'asc' }] });
  const rank = withRanks(quotes);
  res.json({
    item: {
      id: item.id, description: item.description, unit: item.unit, plannedQty: item.plannedQty,
      budgetAmount: item.budgetLine?.budgetAmount ?? null,
      awardedQuotationId: item.awardedQuotationId, awardReason: item.awardReason, awardedAt: item.awardedAt,
    },
    quotes: quotes.map((q) => ({ ...q, rank: rank.get(q.id) ?? '' })),
    activeCount: quotes.filter((q) => q.status !== 'SUPERSEDED').length,
    minQuotes: MIN_QUOTES,
  });
}));

// POST /quotations/item/:boqItemId — add a quotation.
const quoteInput = z.object({
  vendorId: z.string().nullable().optional(),
  vendorName: z.string().trim().min(1, 'Vendor name is required.'),
  price: z.coerce.number().positive('Quoted price must be greater than 0.'),
  deliveryDate: z.string().nullable().optional(),
  deliveryWeeks: z.coerce.number().int().nonnegative().nullable().optional(), // §6.2 — delivery in weeks
  leadTimeText: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),                              // §6.1 — dropdown preset OR typed
  qualityRemarks: z.string().nullable().optional(),
  modelNumber: z.string().nullable().optional(),                              // §6 — vendor's own model number
});
router.post('/item/:boqItemId', requireProjectMember, requireEdit('vendors'), requireFinancialView, asyncHandler(async (req, res) => {
  const { projectId, boqItemId } = req.params;
  const item = await prisma.bOQItem.findFirst({ where: { id: boqItemId, projectId }, select: { id: true } });
  if (!item) throw notFound('BOQ item not found');
  const b = quoteInput.parse(req.body);
  const q = await prisma.vendorQuotation.create({
    data: {
      projectId, boqItemId,
      vendorId: b.vendorId ?? null, vendorName: b.vendorName,
      price: b.price,
      deliveryDate: b.deliveryDate ? new Date(b.deliveryDate) : null,
      deliveryWeeks: b.deliveryWeeks ?? null,
      leadTimeText: b.leadTimeText ?? null, paymentTerms: b.paymentTerms ?? null, qualityRemarks: b.qualityRemarks ?? null,
      modelNumber: b.modelNumber ?? null,
      createdById: req.user!.sub,
    },
  });
  await audit({ userId: req.user!.sub, projectId, action: 'QUOTE_ADD', entity: 'VendorQuotation', entityId: q.id, details: { boqItemId, vendorName: b.vendorName, price: b.price } });
  res.status(201).json({ quote: q });
}));

// POST /quotations/:id/revise — a re-quote after negotiation. Supersedes the old
// row (kept for history) and creates a fresh one with revision + 1.
router.post('/:id/revise', requireProjectMember, requireEdit('vendors'), requireFinancialView, asyncHandler(async (req, res) => {
  const { projectId, id } = req.params;
  const old = await prisma.vendorQuotation.findFirst({ where: { id, projectId } });
  if (!old) throw notFound('Quotation not found');
  const b = quoteInput.partial({ vendorName: true }).parse(req.body);
  const [, fresh] = await prisma.$transaction([
    prisma.vendorQuotation.update({ where: { id: old.id }, data: { status: 'SUPERSEDED' } }),
    prisma.vendorQuotation.create({
      data: {
        projectId, boqItemId: old.boqItemId, vendorId: old.vendorId, vendorName: old.vendorName,
        price: b.price ?? old.price,
        deliveryDate: b.deliveryDate ? new Date(b.deliveryDate) : old.deliveryDate,
        deliveryWeeks: b.deliveryWeeks ?? old.deliveryWeeks,
        leadTimeText: b.leadTimeText ?? old.leadTimeText, paymentTerms: b.paymentTerms ?? old.paymentTerms,
        qualityRemarks: b.qualityRemarks ?? old.qualityRemarks, modelNumber: b.modelNumber ?? old.modelNumber,
        revision: old.revision + 1, parentId: old.id, createdById: req.user!.sub,
      },
    }),
  ]);
  await audit({ userId: req.user!.sub, projectId, action: 'QUOTE_REVISE', entity: 'VendorQuotation', entityId: fresh.id, details: { from: old.id, price: fresh.price } });
  res.status(201).json({ quote: fresh });
}));

router.delete('/:id', requireProjectMember, requireEdit('vendors'), requireFinancialView, asyncHandler(async (req, res) => {
  const { projectId, id } = req.params;
  const q = await prisma.vendorQuotation.findFirst({ where: { id, projectId } });
  if (!q) throw notFound('Quotation not found');
  // Don't let the awarded quote be deleted out from under the award.
  const item = await prisma.bOQItem.findUnique({ where: { id: q.boqItemId }, select: { awardedQuotationId: true } });
  if (item?.awardedQuotationId === id) throw badRequest('This quotation is awarded — clear the award first.');
  await prisma.vendorQuotation.delete({ where: { id } });
  res.json({ ok: true });
}));

// Upload the supporting quotation PDF.
router.post('/:id/file', requireProjectMember, requireEdit('vendors'), requireFinancialView, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const { projectId, id } = req.params;
  const q = await prisma.vendorQuotation.findFirst({ where: { id, projectId } });
  if (!q) throw notFound('Quotation not found');
  const updated = await prisma.vendorQuotation.update({ where: { id }, data: { quotationPdfUrl: `/uploads/${req.file.filename}` } });
  await prisma.procurementDocument.create({ data: { projectId, type: 'QUOTATION', fileName: req.file.originalname, fileUrl: `/uploads/${req.file.filename}`, vendorName: q.vendorName, mimeType: req.file.mimetype, uploadedById: req.user!.sub } });
  res.json({ ok: true, quotationPdfUrl: updated.quotationPdfUrl });
}));

// Upload the vendor's TDS for their quote (§6.3) — separate from the quotation PDF.
router.post('/:id/tds', requireProjectMember, requireEdit('vendors'), requireFinancialView, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  const { projectId, id } = req.params;
  const q = await prisma.vendorQuotation.findFirst({ where: { id, projectId } });
  if (!q) throw notFound('Quotation not found');
  const updated = await prisma.vendorQuotation.update({ where: { id }, data: { tdsUrl: `/uploads/${req.file.filename}` } });
  res.json({ ok: true, tdsUrl: updated.tdsUrl });
}));

// POST /quotations/item/:boqItemId/award — award a quotation to a vendor.
// Blocks below MIN_QUOTES unless `overrideReason` is given (single-source item).
// The reason is mandatory when the chosen quote is not L1 (the cheapest).
router.post('/item/:boqItemId/award', requireProjectMember, requireEdit('vendors'), requireFinancialView, asyncHandler(async (req, res) => {
  const { projectId, boqItemId } = req.params;
  const b = z.object({
    quotationId: z.string().min(1),
    reason: z.string().trim().optional(),
    overrideReason: z.string().trim().optional(),
  }).parse(req.body);

  const item = await prisma.bOQItem.findFirst({ where: { id: boqItemId, projectId }, select: { id: true } });
  if (!item) throw notFound('BOQ item not found');
  const chosen = await prisma.vendorQuotation.findFirst({ where: { id: b.quotationId, boqItemId, projectId } });
  if (!chosen) throw badRequest('That quotation is not on this item.');
  if (chosen.status === 'SUPERSEDED') throw badRequest('That quotation has been revised — award the current one.');

  const quotes = await prisma.vendorQuotation.findMany({ where: { boqItemId, projectId }, select: { id: true, price: true, status: true } });
  const activeCount = quotes.filter((q) => q.status !== 'SUPERSEDED').length;

  // Below three quotes → blocked, unless an override reason is supplied.
  if (activeCount < MIN_QUOTES && !b.overrideReason) {
    throw badRequest(`This item has ${activeCount} quotation(s); ${MIN_QUOTES} are expected before an award. Add more, or supply an override reason (e.g. single-source).`, { needsOverride: true, activeCount, minQuotes: MIN_QUOTES });
  }

  // Not the cheapest (L1) → a reason is mandatory.
  const rank = withRanks(quotes as any);
  const isL1 = rank.get(chosen.id) === 'L1';
  if (!isL1 && !b.reason) {
    throw badRequest('This is not the lowest quote — a reason is required to award it (e.g. faster delivery, better terms).', { needsReason: true });
  }

  const reason = [b.reason, b.overrideReason ? `Override: ${b.overrideReason}` : ''].filter(Boolean).join(' · ') || null;

  await prisma.$transaction([
    // Flag the chosen quote AWARDED; any previously-awarded one on this item goes back to ACTIVE.
    prisma.vendorQuotation.updateMany({ where: { boqItemId, status: 'AWARDED' }, data: { status: 'ACTIVE' } }),
    prisma.vendorQuotation.update({ where: { id: chosen.id }, data: { status: 'AWARDED' } }),
    prisma.bOQItem.update({ where: { id: boqItemId }, data: { awardedQuotationId: chosen.id, awardReason: reason, awardedById: req.user!.sub, awardedAt: new Date() } }),
  ]);
  await audit({ userId: req.user!.sub, projectId, action: 'QUOTE_AWARD', entity: 'BOQItem', entityId: boqItemId, details: { quotationId: chosen.id, vendorName: chosen.vendorName, price: chosen.price, isL1, reason } });
  res.json({ ok: true, awardedQuotationId: chosen.id });
}));

// Clear an award (e.g. re-open the comparison).
router.post('/item/:boqItemId/unaward', requireProjectMember, requireEdit('vendors'), requireFinancialView, asyncHandler(async (req, res) => {
  const { projectId, boqItemId } = req.params;
  const item = await prisma.bOQItem.findFirst({ where: { id: boqItemId, projectId }, select: { awardedQuotationId: true } });
  if (!item) throw notFound('BOQ item not found');
  await prisma.$transaction([
    prisma.vendorQuotation.updateMany({ where: { boqItemId, status: 'AWARDED' }, data: { status: 'ACTIVE' } }),
    prisma.bOQItem.update({ where: { id: boqItemId }, data: { awardedQuotationId: null, awardReason: null, awardedById: null, awardedAt: null } }),
  ]);
  await audit({ userId: req.user!.sub, projectId, action: 'QUOTE_UNAWARD', entity: 'BOQItem', entityId: boqItemId });
  res.json({ ok: true });
}));

export default router;
