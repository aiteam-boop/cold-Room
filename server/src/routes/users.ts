import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors';
import { requireAuth, requireAdmin } from '../middleware/authMiddleware';
import { hashPassword, validatePassword } from '../lib/auth';
import { audit } from '../lib/audit';
import { ROLES, ROLE_LABELS, PROJECT_ROLES } from '../lib/enums';
import {
  PAGE_KEYS, PAGE_LABELS, SECTION_KEYS, SECTION_LABELS,
  APPROVAL_ROLES, APPROVAL_TYPES,
  cleanGrants, cleanSections, parseGrants, parseSections, cleanApprover, parseApprover,
} from '../lib/permissions';

const router = Router();
router.use(requireAuth);
// Every user-management endpoint is ADMIN-only (IMS: only admins manage users).
router.use(requireAdmin);

// Shape of grants/sections coming from the admin UI.
const grantsInput = z.record(z.object({ view: z.boolean().optional(), edit: z.boolean().optional() })).optional();
const sectionsInput = z.record(z.boolean()).optional();
const approverInput = z.object({
  canApprove: z.boolean().optional(),
  approvalRole: z.string().nullable().optional(),
  level: z.coerce.number().optional(),
  types: z.array(z.string()).optional(),
}).optional();
const projectsInput = z
  .array(z.object({ projectId: z.string().min(1), role: z.enum(PROJECT_ROLES).default('ENGINEER') }))
  .optional();

function publicUser(u: {
  id: string; name: string; email: string; role: string; active: boolean;
  whatsapp: string | null; pageAccess: string | null; sectionPerms: string | null; approver?: string | null; createdAt?: Date;
}) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
    whatsapp: u.whatsapp ?? '',
    pageAccess: parseGrants(u.pageAccess),
    sectionPerms: parseSections(u.sectionPerms),
    approver: parseApprover(u.approver),
    createdAt: u.createdAt,
  };
}

// Column selection shared by the user endpoints (keeps `approver` included).
const USER_SELECT = {
  id: true, name: true, email: true, role: true, active: true,
  whatsapp: true, pageAccess: true, sectionPerms: true, approver: true, createdAt: true,
} as const;

// GET /api/users/meta — the page/section catalogue + project list for the UI.
router.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, clientName: true },
    });
    res.json({
      roles: ROLES,
      roleLabels: ROLE_LABELS,
      projectRoles: PROJECT_ROLES,
      pages: PAGE_KEYS.map((key) => ({ key, label: PAGE_LABELS[key] })),
      sections: SECTION_KEYS.map((key) => ({ key, label: SECTION_LABELS[key] })),
      approvalRoles: APPROVAL_ROLES,
      approvalTypes: APPROVAL_TYPES,
      projects,
    });
  })
);

// GET /api/users — list (with grant summary for the table).
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: USER_SELECT,
    });
    res.json({ users: users.map(publicUser) });
  })
);

// GET /api/users/:id — full detail incl. project access.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { ...USER_SELECT, memberships: { select: { projectId: true, role: true } } },
    });
    if (!user) throw notFound('User not found');
    res.json({ user: { ...publicUser(user), projects: user.memberships } });
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string(),
  role: z.enum(ROLES).default('USER'),
  active: z.boolean().default(true),
  whatsapp: z.string().optional(),
  pageAccess: grantsInput,
  sectionPerms: sectionsInput,
  approver: approverInput,
  projects: projectsInput,
});

// POST /api/users — create a user with grants + project access (FR-PM-03).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const pwErr = validatePassword(body.password);
    if (pwErr) throw badRequest(pwErr);
    const exists = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (exists) throw conflict('Email already in use');

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        passwordHash: await hashPassword(body.password),
        role: body.role,
        active: body.active,
        whatsapp: body.whatsapp || null,
        pageAccess: JSON.stringify(cleanGrants(body.pageAccess)),
        sectionPerms: JSON.stringify(cleanSections(body.sectionPerms)),
        approver: JSON.stringify(cleanApprover(body.approver)),
        memberships: body.projects?.length
          ? { create: body.projects.map((p) => ({ projectId: p.projectId, role: p.role })) }
          : undefined,
      },
      select: USER_SELECT,
    });
    await audit({ userId: req.account!.id, action: 'USER_CREATE', entity: 'User', entityId: user.id, details: { role: body.role } });
    res.status(201).json({ user: publicUser(user) });
  })
);

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  whatsapp: z.string().optional(),
  pageAccess: grantsInput,
  sectionPerms: sectionsInput,
  approver: approverInput,
});

// PATCH /api/users/:id — update profile, role, active state and grants.
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found');

    // Guard: an admin cannot deactivate or demote their own account (avoids
    // locking the last admin out of user management).
    if (target.id === req.account!.id) {
      if (body.active === false) throw badRequest('You cannot deactivate your own account');
      if (body.role && body.role !== 'ADMIN') throw badRequest('You cannot remove your own admin role');
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.role !== undefined && { role: body.role }),
        ...(body.active !== undefined && { active: body.active }),
        ...(body.whatsapp !== undefined && { whatsapp: body.whatsapp || null }),
        ...(body.pageAccess !== undefined && { pageAccess: JSON.stringify(cleanGrants(body.pageAccess)) }),
        ...(body.sectionPerms !== undefined && { sectionPerms: JSON.stringify(cleanSections(body.sectionPerms)) }),
        ...(body.approver !== undefined && { approver: JSON.stringify(cleanApprover(body.approver)) }),
      },
      select: USER_SELECT,
    });
    await audit({ userId: req.account!.id, action: 'USER_UPDATE', entity: 'User', entityId: user.id, details: { fields: Object.keys(body) } });
    res.json({ user: publicUser(user) });
  })
);

// POST /api/users/:id/password — admin resets a user's password.
router.post(
  '/:id/password',
  asyncHandler(async (req, res) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const pwErr = validatePassword(password);
    if (pwErr) throw badRequest(pwErr);
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found');
    await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: await hashPassword(password) } });
    await audit({ userId: req.account!.id, action: 'USER_PASSWORD_RESET', entity: 'User', entityId: req.params.id });
    res.json({ ok: true });
  })
);

// PUT /api/users/:id/projects — set the user's project access (+ per-project role).
router.put(
  '/:id/projects',
  asyncHandler(async (req, res) => {
    const { projects } = z.object({ projects: projectsInput }).parse(req.body);
    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound('User not found');
    const list = projects ?? [];

    await prisma.$transaction([
      prisma.projectMember.deleteMany({ where: { userId: req.params.id } }),
      ...(list.length
        ? [prisma.projectMember.createMany({ data: list.map((p) => ({ userId: req.params.id, projectId: p.projectId, role: p.role })) })]
        : []),
    ]);
    await audit({ userId: req.account!.id, action: 'USER_PROJECTS_SET', entity: 'User', entityId: req.params.id, details: { count: list.length } });
    res.json({ ok: true, count: list.length });
  })
);

export default router;
