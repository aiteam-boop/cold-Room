import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest } from '../lib/errors';
import { requireAuth, requireAdmin } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { isAdmin } from '../lib/enums';
import { parseApprover, approverHandlesType, approvalTypeForDoc } from '../lib/permissions';
import { fixedChainFor, resolveAutoChain, type ChainDocType } from '../services/fixedChain';

// Admin config for the FIXED approval chain per document type.
// Mounted at /api/approval-chains
const router = Router();
router.use(requireAuth);

const DOC_TYPES = ['PO', 'WO', 'TO', 'GRN', 'PAYMENT', 'TRAVEL', 'TRAVEL_EXPENSE', 'ADVANCE'] as const;

// GET /api/approval-chains?docType=PO[&projectId=] — the configured chain.
router.get('/', asyncHandler(async (req, res) => {
  const docType = String(req.query.docType || 'PO').toUpperCase();
  if (!DOC_TYPES.includes(docType as any)) throw badRequest('docType must be PO, WO, TO, GRN, PAYMENT, TRAVEL or TRAVEL_EXPENSE');
  const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : null;
  const { rows, scope } = await fixedChainFor(docType as ChainDocType, projectId);
  res.json({ docType, projectId, scope, chain: rows });
}));

// GET /api/approval-chains/resolve?docType=PO&projectId=…&amount=…
// What chain THIS document would travel if submitted right now. The submit
// screens call this: when source is 'fixed' they submit straight through with
// no approver popup, because the server will route it through this same chain.
router.get('/resolve', asyncHandler(async (req, res) => {
  const docType = String(req.query.docType || 'PO').toUpperCase();
  if (!DOC_TYPES.includes(docType as any)) throw badRequest('docType must be PO, WO, TO, GRN, PAYMENT, TRAVEL or TRAVEL_EXPENSE');
  const projectId = String(req.query.projectId || '');
  if (!projectId) throw badRequest('projectId is required');
  const amount = Number(req.query.amount) || 0;
  const resolved = await resolveAutoChain(docType as ChainDocType, projectId, amount);
  res.json(resolved);
}));

// PUT /api/approval-chains — replace the whole chain for a docType (admin).
// Body: { docType, projectId?, approvers: [{ approverId, order, isActive }] }
const putSchema = z.object({
  docType: z.enum(DOC_TYPES),
  projectId: z.string().nullable().optional(),
  approvers: z.array(z.object({
    approverId: z.string().min(1),
    order: z.coerce.number().int().min(1),
    isActive: z.boolean().default(true),
    canUploadTicket: z.boolean().optional(),
  })),
});

router.put('/', requireAdmin, asyncHandler(async (req, res) => {
  const b = putSchema.parse(req.body);
  const projectId = b.projectId ?? null;

  // Resolve names/roles from the user table so the chain is self-describing, and
  // reject anyone who cannot sign this doc type. buildChain() enforces the same
  // rule at submit time — catching it here stops an admin from saving a chain
  // that would later block every document of that type.
  const ids = b.approvers.map((a) => a.approverId);
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, role: true, active: true, approver: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const type = approvalTypeForDoc(b.docType);

  for (const a of b.approvers) {
    const u = byId.get(a.approverId);
    if (!u) throw badRequest('An approver in the chain no longer exists.');
    if (!u.active) throw badRequest(`${u.name} is deactivated and cannot be an approver.`);
    if (!isAdmin(u.role) && !approverHandlesType(parseApprover(u.approver), type)) {
      throw badRequest(`${u.name} is not registered as an approver for ${b.docType}. Enable it on their user record first.`);
    }
  }

  // Replace the chain for this (docType, projectId) scope. Approvers sharing an
  // `order` are one step (any one of them can approve it). Normalise the sent
  // orders to a contiguous 1..n while PRESERVING which approvers share a step.
  await prisma.approvalChainConfig.deleteMany({ where: { docType: b.docType, projectId } });
  if (b.approvers.length) {
    const distinct = [...new Set(b.approvers.map((a) => a.order))].sort((x, y) => x - y);
    const orderMap = new Map(distinct.map((o, i) => [o, i + 1]));
    await prisma.approvalChainConfig.createMany({
      data: b.approvers
        .slice()
        .sort((x, y) => x.order - y.order)
        .map((a) => {
          const u = byId.get(a.approverId)!;
          const prof = parseApprover(u.approver);
          const approvalRole = prof.approvalRole || (isAdmin(u.role) ? 'Admin' : u.role ?? null);
          return { docType: b.docType, projectId, approverId: a.approverId, approverName: u.name, approverRole: approvalRole, order: orderMap.get(a.order)!, isActive: a.isActive, canUploadTicket: !!a.canUploadTicket };
        }),
    });
  }
  await audit({ userId: req.user!.sub, projectId: projectId ?? undefined, action: 'APPROVAL_CHAIN_SET', entity: 'ApprovalChainConfig', details: { docType: b.docType, count: b.approvers.length } });

  const { rows, scope } = await fixedChainFor(b.docType as ChainDocType, projectId);
  res.json({ ok: true, docType: b.docType, scope, chain: rows });
}));

export default router;
