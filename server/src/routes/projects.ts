import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requireAdmin, requireEdit } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { PROJECT_STATUSES, PROJECT_ROLES, isAdmin } from '../lib/enums';
import { loadProjectProgress } from '../services/projectProgress';

const router = Router();
router.use(requireAuth);

// Helper: projects visible to the current user. Global ADMIN sees all; everyone
// else sees only the projects an admin has granted them access to (membership).
async function visibleProjectIds(userId: string, role: string): Promise<string[] | 'ALL'> {
  if (isAdmin(role)) return 'ALL';
  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  });
  return memberships.map((m) => m.projectId);
}

// GET /api/projects — list with computed completion + risk for cards.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await visibleProjectIds(req.account!.id, req.account!.role);
    const projects = await prisma.project.findMany({
      where: scope === 'ALL' ? {} : { id: { in: scope } },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { boqItems: true, entries: true, members: true } } },
    });

    const cards = await Promise.all(
      projects.map(async (p) => {
        const prog = await loadProjectProgress(p.id);
        return {
          id: p.id,
          name: p.name,
          clientName: p.clientName,
          siteLocation: p.siteLocation,
          status: p.status,
          startDate: p.startDate,
          targetCompletionDate: p.targetCompletionDate,
          boqLocked: p.boqLocked,
          counts: p._count,
          completionPct: prog.overall.completionPct,
          estimatedCompletionDate: prog.overall.estimatedCompletionDate,
          delayRisk: prog.risk,
        };
      })
    );
    res.json({ projects: cards });
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  clientName: z.string().optional(),
  siteLocation: z.string().optional(),
  startDate: z.string().datetime().optional().or(z.string().date().optional()),
  targetCompletionDate: z.string().datetime().optional().or(z.string().date().optional()),
});

// POST /api/projects — ADMIN only (FR-PM-01).
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const project = await prisma.project.create({
      data: {
        name: body.name,
        clientName: body.clientName,
        siteLocation: body.siteLocation,
        startDate: body.startDate ? new Date(body.startDate) : null,
        targetCompletionDate: body.targetCompletionDate ? new Date(body.targetCompletionDate) : null,
        createdById: req.user!.sub,
        members: { create: { userId: req.user!.sub, role: 'ADMIN' } },
      },
    });
    await audit({ userId: req.user!.sub, projectId: project.id, action: 'PROJECT_CREATE', entity: 'Project', entityId: project.id });
    res.status(201).json({ project });
  })
);

// GET /api/projects/:projectId — workspace header data.
router.get(
  '/:projectId',
  requireProjectMember,
  asyncHandler(async (req, res) => {
    const project = await prisma.project.findUnique({
      where: { id: req.params.projectId },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        members: { include: { user: { select: { id: true, name: true, email: true, role: true } } } },
        _count: { select: { boqItems: true, drawings: true, zones: true, entries: true } },
      },
    });
    if (!project) throw notFound('Project not found');
    const prog = await loadProjectProgress(project.id);
    res.json({ project, progress: prog.overall, risk: prog.risk, role: req.projectRole });
  })
);

const updateSchema = createSchema.partial().extend({
  status: z.enum(PROJECT_STATUSES).optional(),
});

// PATCH /api/projects/:projectId — ADMIN of project (FR-PM-04 status).
router.patch(
  '/:projectId',
  requireProjectMember,
  asyncHandler(async (req, res) => {
    if (req.projectRole !== 'ADMIN') throw forbidden('Only project admin can edit');
    const body = updateSchema.parse(req.body);
    const project = await prisma.project.update({
      where: { id: req.params.projectId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.clientName !== undefined && { clientName: body.clientName }),
        ...(body.siteLocation !== undefined && { siteLocation: body.siteLocation }),
        ...(body.startDate !== undefined && { startDate: body.startDate ? new Date(body.startDate) : null }),
        ...(body.targetCompletionDate !== undefined && {
          targetCompletionDate: body.targetCompletionDate ? new Date(body.targetCompletionDate) : null,
        }),
        ...(body.status !== undefined && { status: body.status }),
      },
    });
    await audit({ userId: req.user!.sub, projectId: project.id, action: 'PROJECT_UPDATE', entity: 'Project', entityId: project.id, details: body });
    res.json({ project });
  })
);

// ── Members (FR-PM-03) ──────────────────────────────────────────────────────

const memberSchema = z.object({ email: z.string().email(), role: z.enum(PROJECT_ROLES) });

router.post(
  '/:projectId/members',
  requireProjectMember,
  requireEdit('team'),
  asyncHandler(async (req, res) => {
    const body = memberSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user) throw badRequest('No user with that email. Ask an admin to create the account first.');
    const member = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: req.params.projectId, userId: user.id } },
      update: { role: body.role },
      create: { projectId: req.params.projectId, userId: user.id, role: body.role },
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'MEMBER_ADD', entity: 'ProjectMember', entityId: member.id, details: { email: body.email, role: body.role } });
    res.status(201).json({ member });
  })
);

router.delete(
  '/:projectId/members/:userId',
  requireProjectMember,
  requireEdit('team'),
  asyncHandler(async (req, res) => {
    await prisma.projectMember.deleteMany({
      where: { projectId: req.params.projectId, userId: req.params.userId },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'MEMBER_REMOVE', entity: 'ProjectMember', entityId: req.params.userId });
    res.json({ ok: true });
  })
);

// GET /api/projects/:projectId/audit — audit trail (admin/management).
router.get(
  '/:projectId/audit',
  requireProjectMember,
  asyncHandler(async (req, res) => {
    if (!['ADMIN', 'MANAGEMENT', 'SUPERVISOR'].includes(req.projectRole!)) throw forbidden();
    const logs = await prisma.auditLog.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { user: { select: { name: true, email: true } } },
    });
    res.json({ logs });
  })
);

export default router;
