// ── BOQ & Budget (BOQ & Budget PRD v1 §3) ────────────────────────────────────
// Mounted at /api/projects/:projectId/budget.
//
// The internal costing the bid was built on, one line per BOQ item. Once FROZEN
// it is the benchmark every PO is measured against and nobody may edit it:
//
//   DRAFT ──(canFreezeBudget)──▶ FROZEN ──(admin only, with a reason)──▶ DRAFT
//
// Two separate rights, deliberately (PRD OQ-1): `canEditBudget` types the
// numbers, `canFreezeBudget` locks them. Un-freezing is an admin escape hatch for
// a genuine mistake — it is logged loudly, never routine.
//
// The budget is INTERNAL. It is never rendered on a vendor-facing PO.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requireSection, requireBudgetView, requireFinancialView } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { isAdmin } from '../lib/enums';

const router = Router({ mergeParams: true });
router.use(requireAuth);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** qty × rate. Kept explicit so a lump-sum line can be entered as qty 1 × amount. */
function lineAmount(qty: number | null | undefined, rate: number | null | undefined): number | null {
  if (qty == null || rate == null) return null;
  return round2(qty * rate);
}

// GET /budget — the BOQ with its budget line, grouped by category, plus totals.
// Behind requireFinancialView: the budget IS pricing, so anyone with
// hideFinancials must never receive it.
router.get('/', requireProjectMember, requireBudgetView, asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const [project, items] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { budgetStatus: true, budgetContingencyPct: true, budgetFrozenAt: true, budgetFrozenById: true },
    }),
    prisma.bOQItem.findMany({
      where: { projectId },
      orderBy: [{ displaySequence: 'asc' }, { srNo: 'asc' }],
      select: {
        id: true, srNo: true, description: true, category: true, roomZone: true,
        unit: true, makeModel: true, plannedQty: true, isGroup: true,
        budgetLine: { select: { budgetQty: true, budgetRate: true, budgetAmount: true, notes: true, updatedAt: true } },
      },
    }),
  ]);
  if (!project) throw notFound('Project not found');

  const frozenBy = project.budgetFrozenById
    ? await prisma.user.findUnique({ where: { id: project.budgetFrozenById }, select: { name: true, email: true } })
    : null;

  // Group headers carry no cost of their own — they are BOQ section titles.
  const rows = items
    .filter((i) => !i.isGroup)
    .map((i) => ({
      boqItemId: i.id, srNo: i.srNo, description: i.description,
      category: i.category || 'Uncategorised', roomZone: i.roomZone,
      unit: i.unit, makeModel: i.makeModel, plannedQty: i.plannedQty,
      budgetQty: i.budgetLine?.budgetQty ?? null,
      budgetRate: i.budgetLine?.budgetRate ?? null,
      budgetAmount: i.budgetLine?.budgetAmount ?? null,
      notes: i.budgetLine?.notes ?? null,
    }));

  const subtotal = round2(rows.reduce((s, r) => s + (r.budgetAmount ?? 0), 0));
  const contingencyPct = project.budgetContingencyPct ?? 0;
  const contingency = round2((subtotal * contingencyPct) / 100);

  res.json({
    status: project.budgetStatus,
    frozen: project.budgetStatus === 'FROZEN',
    frozenAt: project.budgetFrozenAt,
    frozenBy: frozenBy ? { name: frozenBy.name, email: frozenBy.email } : null,
    contingencyPct,
    rows,
    totals: {
      subtotal,
      contingencyPct,
      contingency,
      // The number that gets frozen — the benchmark for the whole project.
      total: round2(subtotal + contingency),
      linesCosted: rows.filter((r) => r.budgetAmount != null).length,
      linesTotal: rows.length,
    },
  });
}));

// GET /budget/summary — the frozen budget keyed by BOQ item, for the PO builder's
// "Budget vs Actual" panel. Gated only on requireFinancialView (NOT the boq page)
// so anyone who may build a PO can see how it lands against budget. It is still
// pricing, so hideFinancials users are refused.
router.get('/summary', requireProjectMember, requireBudgetView, asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const [project, lines] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { budgetStatus: true } }),
    prisma.bOQBudgetLine.findMany({
      where: { projectId },
      select: { boqItemId: true, budgetQty: true, budgetRate: true, budgetAmount: true, boqItem: { select: { description: true, unit: true, plannedQty: true } } },
    }),
  ]);
  res.json({
    frozen: project?.budgetStatus === 'FROZEN',
    byItem: Object.fromEntries(lines.map((l) => [l.boqItemId, {
      description: l.boqItem.description,
      unit: l.boqItem.unit,
      budgetQty: l.budgetQty ?? l.boqItem.plannedQty,
      budgetRate: l.budgetRate,
      budgetAmount: l.budgetAmount,
    }])),
  });
}));

/** A frozen budget is read-only for everyone — the whole point of freezing it. */
async function assertNotFrozen(projectId: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { budgetStatus: true } });
  if (!p) throw notFound('Project not found');
  if (p.budgetStatus === 'FROZEN') {
    throw forbidden('The budget is frozen and cannot be changed. It can only grow through a Change Order.');
  }
}

// PATCH /budget/lines/:boqItemId — set the costing for one BOQ line.
const lineInput = z.object({
  budgetQty: z.coerce.number().nullable().optional(),
  budgetRate: z.coerce.number().nullable().optional(),
  notes: z.string().nullable().optional(),
});
router.patch('/lines/:boqItemId', requireProjectMember, requireSection('canEditBudget'), asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const item = await prisma.bOQItem.findFirst({ where: { id: req.params.boqItemId, projectId }, select: { id: true, plannedQty: true } });
  if (!item) throw notFound('BOQ item not found');
  const b = lineInput.parse(req.body);

  const existing = await prisma.bOQBudgetLine.findUnique({ where: { boqItemId: item.id } });
  // A frozen budget is locked — BUT it can still GROW (PRD §7): a BOQ item added
  // by a Change Order after the freeze has no budget line yet, so costing that new
  // line is allowed. Editing an EXISTING (originally-frozen) line is never allowed.
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { budgetStatus: true } });
  if (project?.budgetStatus === 'FROZEN') {
    if (existing) throw forbidden('The budget is frozen — existing lines cannot be changed. New scope is added through a Change Order.');
    await audit({ userId: req.user!.sub, projectId, action: 'BUDGET_LINE_ADD_FROZEN', entity: 'BOQItem', entityId: item.id, details: { via: 'change-order scope' } });
  }
  // Costing usually assumes the BOQ quantity, so default to it rather than making
  // the user retype 150 numbers.
  const qty = b.budgetQty !== undefined ? b.budgetQty : existing?.budgetQty ?? item.plannedQty;
  const rate = b.budgetRate !== undefined ? b.budgetRate : existing?.budgetRate ?? null;
  const notes = b.notes !== undefined ? b.notes : existing?.notes ?? null;

  const data = {
    projectId, boqItemId: item.id,
    budgetQty: qty, budgetRate: rate,
    budgetAmount: lineAmount(qty, rate),
    notes, updatedById: req.user!.sub,
  };
  const line = await prisma.bOQBudgetLine.upsert({ where: { boqItemId: item.id }, create: data, update: data });
  res.json({ line });
}));

// PATCH /budget/settings — project-level contingency %.
router.patch('/settings', requireProjectMember, requireSection('canEditBudget'), asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  await assertNotFrozen(projectId);
  const { contingencyPct } = z.object({ contingencyPct: z.coerce.number().min(0).max(100) }).parse(req.body);
  await prisma.project.update({ where: { id: projectId }, data: { budgetContingencyPct: contingencyPct } });
  res.json({ ok: true, contingencyPct });
}));

// POST /budget/freeze — lock it. This is the moment the budget becomes the
// benchmark, so it needs the stronger right and at least one costed line.
router.post('/freeze', requireProjectMember, requireSection('canFreezeBudget'), asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { budgetStatus: true } });
  if (!p) throw notFound('Project not found');
  if (p.budgetStatus === 'FROZEN') throw badRequest('The budget is already frozen.');

  const costed = await prisma.bOQBudgetLine.count({ where: { projectId, budgetAmount: { not: null } } });
  if (costed === 0) throw badRequest('Enter at least one budget rate before freezing.');

  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { budgetStatus: 'FROZEN', budgetFrozenAt: new Date(), budgetFrozenById: req.user!.sub },
    select: { budgetFrozenAt: true },
  });
  await audit({ userId: req.user!.sub, projectId, action: 'BUDGET_FREEZE', entity: 'Project', entityId: projectId, details: { costedLines: costed } });
  res.json({ ok: true, status: 'FROZEN', frozenAt: updated.budgetFrozenAt });
}));

// POST /budget/unfreeze — ADMIN ONLY, and never routine. A frozen budget is
// meant to be permanent; this exists only for a genuine mistake (a wrong rate
// spotted right after freezing). It demands a reason and is logged loudly.
router.post('/unfreeze', requireProjectMember, requireFinancialView, asyncHandler(async (req, res) => {
  if (!isAdmin(req.account?.role)) throw forbidden('Only an admin can unfreeze a budget.');
  const projectId = req.params.projectId;
  const { reason } = z.object({ reason: z.string().trim().min(5, 'Give a reason (min 5 characters) — unfreezing a budget is logged.') }).parse(req.body);

  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { budgetStatus: true } });
  if (p?.budgetStatus !== 'FROZEN') throw badRequest('This budget is not frozen.');

  await prisma.project.update({ where: { id: projectId }, data: { budgetStatus: 'DRAFT', budgetFrozenAt: null, budgetFrozenById: null } });
  await audit({ userId: req.user!.sub, projectId, action: 'BUDGET_UNFREEZE', entity: 'Project', entityId: projectId, details: { reason } });
  res.json({ ok: true, status: 'DRAFT' });
}));

export default router;
