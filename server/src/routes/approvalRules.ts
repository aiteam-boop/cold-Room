// Admin CRUD for the value-threshold approval matrix (DPR PRD §3.2 G6).
// Mounted at /api/approval-rules. Admin-only: this table decides who can sign
// what, so it must never be editable by the people it governs.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { isAdmin } from '../lib/enums';
import { parseApprover, approverHandlesType, approvalTypeForDoc } from '../lib/permissions';
import { bandLabel, chainForAmount, type MatrixDocType } from '../services/approvalMatrix';

const router = Router();
router.use(requireAuth);

const requireAdmin = asyncHandler(async (req, _res, next) => {
  if (!isAdmin(req.account?.role)) throw forbidden('Only an administrator can change the approval matrix.');
  next();
});

const DOC_TYPES = ['PO', 'WO', 'TO', 'GRN', 'PAYMENT'] as const;

const ruleSchema = z.object({
  projectId: z.string().nullable().optional(),
  docType: z.enum(DOC_TYPES),
  minAmount: z.coerce.number().nonnegative().default(0),
  maxAmount: z.coerce.number().positive().nullable().optional(),
  approverId: z.string().min(1),
  order: z.coerce.number().int().min(1).default(1),
  isActive: z.boolean().optional(),
});

/** A band must be non-empty, and the approver must be allowed to sign that doc type. */
async function validateRule(b: z.infer<typeof ruleSchema>) {
  if (b.maxAmount != null && b.maxAmount <= b.minAmount) {
    throw badRequest(`The upper limit must be greater than the lower limit (${b.minAmount}).`);
  }
  const user = await prisma.user.findUnique({ where: { id: b.approverId }, select: { id: true, name: true, active: true, approver: true } });
  if (!user) throw notFound('Approver not found');
  if (!user.active) throw badRequest(`${user.name} is deactivated and cannot be an approver.`);

  const prof = parseApprover(user.approver);
  if (!approverHandlesType(prof, approvalTypeForDoc(b.docType))) {
    throw badRequest(`${user.name} is not registered as an approver for ${b.docType}. Enable it on their user record first.`);
  }
  return { user, prof };
}

// GET /api/approval-rules?docType=PO&projectId=…
router.get('/', asyncHandler(async (req, res) => {
  const docType = DOC_TYPES.includes(req.query.docType as MatrixDocType) ? (req.query.docType as MatrixDocType) : undefined;
  const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;

  const rules = await prisma.approvalRule.findMany({
    where: { ...(docType ? { docType } : {}), ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}) },
    orderBy: [{ docType: 'asc' }, { order: 'asc' }, { minAmount: 'asc' }],
  });
  res.json({ rules: rules.map((r) => ({ ...r, bandLabel: bandLabel(r.minAmount, r.maxAmount) })) });
}));

/**
 * GET /api/approval-rules/preview?docType=PO&projectId=…&amount=200000
 * "Who would have to sign a PO of this value?" — backs the live preview in the
 * chain builder and the admin matrix screen.
 */
router.get('/preview', asyncHandler(async (req, res) => {
  const docType = (DOC_TYPES.includes(req.query.docType as MatrixDocType) ? req.query.docType : 'PO') as MatrixDocType;
  const projectId = String(req.query.projectId ?? '');
  const amount = Number(req.query.amount ?? 0);
  if (!projectId) throw badRequest('projectId is required');
  res.json(await chainForAmount(docType, projectId, Number.isFinite(amount) ? amount : 0));
}));

// The candidate approvers for a doc type — everyone whose user record already
// designates them an approver of that type.
router.get('/candidates', asyncHandler(async (req, res) => {
  const docType = (DOC_TYPES.includes(req.query.docType as MatrixDocType) ? req.query.docType : 'PO') as MatrixDocType;
  const users = await prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true, approver: true } });
  res.json({
    candidates: users
      .map((u) => ({ ...u, profile: parseApprover(u.approver) }))
      .filter((u) => approverHandlesType(u.profile, approvalTypeForDoc(docType)))
      .map((u) => ({ id: u.id, name: u.name, email: u.email, approvalRole: u.profile.approvalRole, level: u.profile.level })),
  });
}));

router.post('/', requireAdmin, asyncHandler(async (req, res) => {
  const b = ruleSchema.parse(req.body);
  const { user, prof } = await validateRule(b);
  const rule = await prisma.approvalRule.create({
    data: {
      projectId: b.projectId ?? null, docType: b.docType,
      minAmount: b.minAmount, maxAmount: b.maxAmount ?? null,
      approverId: user.id, approverName: user.name, approverRole: prof.approvalRole,
      order: b.order, isActive: b.isActive ?? true,
    },
  });
  await audit({ userId: req.user!.sub, projectId: b.projectId ?? undefined, action: 'APPROVAL_RULE_CREATE', entity: 'ApprovalRule', entityId: rule.id, details: rule });
  res.status(201).json({ rule });
}));

router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await prisma.approvalRule.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Rule not found');
  const b = ruleSchema.partial().parse(req.body);
  const merged = { ...existing, ...b, maxAmount: b.maxAmount !== undefined ? b.maxAmount ?? null : existing.maxAmount } as z.infer<typeof ruleSchema>;
  const { user, prof } = await validateRule(merged);

  const rule = await prisma.approvalRule.update({
    where: { id: existing.id },
    data: {
      ...(b.docType !== undefined && { docType: b.docType }),
      ...(b.projectId !== undefined && { projectId: b.projectId }),
      ...(b.minAmount !== undefined && { minAmount: b.minAmount }),
      ...(b.maxAmount !== undefined && { maxAmount: b.maxAmount ?? null }),
      ...(b.approverId !== undefined && { approverId: user.id, approverName: user.name, approverRole: prof.approvalRole }),
      ...(b.order !== undefined && { order: b.order }),
      ...(b.isActive !== undefined && { isActive: b.isActive }),
    },
  });
  await audit({ userId: req.user!.sub, action: 'APPROVAL_RULE_UPDATE', entity: 'ApprovalRule', entityId: rule.id, details: b });
  res.json({ rule });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
  const existing = await prisma.approvalRule.findUnique({ where: { id: req.params.id } });
  if (!existing) throw notFound('Rule not found');
  await prisma.approvalRule.delete({ where: { id: existing.id } });
  await audit({ userId: req.user!.sub, action: 'APPROVAL_RULE_DELETE', entity: 'ApprovalRule', entityId: existing.id, details: existing });
  res.json({ ok: true });
}));

export default router;
