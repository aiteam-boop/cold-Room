import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requireAdmin, requireEdit, isSuperAdmin } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { PROJECT_STATUSES, PROJECT_ROLES, DRAWING_APPROVAL_TYPES, DRAWING_APPROVAL_STATUSES, isAdmin } from '../lib/enums';
import { loadProjectProgress } from '../services/projectProgress';
import {
  computeOfficialStartDate, normalizeDrawingApprovals, summarizeDrawingApprovals,
  defaultDrawingApprovals,
} from '../services/drawingApprovals';

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

const MS_DAY = 86_400_000;

// GET /api/projects — the multi-project dashboard (Sprint PRD §10.1). Each card
// carries everything it renders: completion gauge, days remaining, delay-risk
// badge, item quick-stats and a timeline mini-bar.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = await visibleProjectIds(req.account!.id, req.account!.role);
    const allProjects = await prisma.project.findMany({
      where: scope === 'ALL' ? {} : { id: { in: scope } },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { boqItems: true, entries: true, members: true } } },
    });
    // Test/sandbox projects are visible only to the super-admin. Filtered in JS
    // (not the query) because Prisma+Mongo won't match rows where testOnly is
    // still missing — only super-admins should ever see them anyway.
    const superAdmin = isSuperAdmin(req.user?.email);
    const projects = superAdmin ? allProjects : allProjects.filter((p) => !p.testOnly);

    // One query for every project's activities rather than one per project.
    const acts = await prisma.ganttActivity.findMany({
      where: { projectId: { in: projects.map((p) => p.id) } },
      select: { projectId: true, plannedEndDate: true, actualEndDate: true, actualStartDate: true, percentComplete: true },
    });
    const actsByProject = new Map<string, typeof acts>();
    for (const a of acts) {
      const list = actsByProject.get(a.projectId) ?? [];
      list.push(a);
      actsByProject.set(a.projectId, list);
    }

    const now = new Date();
    const cards = await Promise.all(
      projects.map(async (p) => {
        const prog = await loadProjectProgress(p.id);
        const drawing = summarizeDrawingApprovals(normalizeDrawingApprovals(p.drawingApprovals), now);

        // Gantt delay: an activity is delayed only when it is past its planned
        // end AND has no recorded completion. Same rule as routes/gantt.ts.
        const mine = actsByProject.get(p.id) ?? [];
        const delayedActs = mine.filter((a) => !a.actualEndDate && a.percentComplete < 100 && now > a.plannedEndDate);
        const worstDelay = delayedActs.reduce((m, a) => Math.max(m, Math.ceil((now.getTime() - a.plannedEndDate.getTime()) / MS_DAY)), 0);

        // The card's badge is driven by real Gantt delay when a timeline exists,
        // and falls back to the BOQ burn-rate estimate when it doesn't.
        const delayRisk = delayedActs.length > 0
          ? { level: 'DELAYED', message: `${delayedActs.length} activity(ies) delayed · worst ${worstDelay}d` }
          : prog.risk;

        const target = p.targetCompletionDate;
        const daysRemaining = target ? Math.ceil((target.getTime() - now.getTime()) / MS_DAY) : null;

        // Mini-bar: how far through the planned calendar we are, start → target.
        // If a manual Start date is set it wins; otherwise the clock starts on the
        // LATEST of PO received / Drawing approved / First advance — and we record
        // WHICH one, so the card can label it ("from PO received", etc.).
        const startCands = ([
          { d: p.orderReceiveDate, label: 'PO received' },
          { d: p.officialStartDate, label: 'Drawing approved' },
          { d: p.advanceReceiveDate, label: 'First advance' },
        ].filter((x) => x.d) as { d: Date; label: string }[]);
        const maxCand = startCands.length ? startCands.reduce((a, b) => (b.d.getTime() > a.d.getTime() ? b : a)) : null;
        const start = p.startDate ?? (maxCand?.d ?? null);
        const startSource = p.startDate ? 'Manual' : (maxCand?.label ?? null);
        let timelinePct: number | null = null;
        if (start && target && target.getTime() > start.getTime()) {
          const raw = ((now.getTime() - start.getTime()) / (target.getTime() - start.getTime())) * 100;
          timelinePct = Math.round(Math.min(Math.max(raw, 0), 100) * 10) / 10;
        }

        const items = prog.items; // loadProjectProgress already excludes group rows
        return {
          id: p.id,
          name: p.name,
          clientName: p.clientName,
          siteLocation: p.siteLocation,
          siteSupervisor: p.siteSupervisor ?? null,
          siteSupervisorId: p.siteSupervisorId ?? null,
          clientPoNumber: p.clientPoNumber,
          clientPos: p.clientPos ?? null,
          clientGstin: p.clientGstin ?? null,
          status: p.status,
          startDate: p.startDate,
          officialStartDate: p.officialStartDate,
          orderReceiveDate: p.orderReceiveDate,
          advanceReceiveDate: p.advanceReceiveDate,
          effectiveStartDate: start,
          startSource,
          targetCompletionDate: target,
          boqLocked: p.boqLocked,
          counts: p._count,
          completionPct: prog.overall.completionPct,
          estimatedCompletionDate: prog.overall.estimatedCompletionDate,
          delayRisk,
          daysRemaining,
          timelinePct,
          pendingDrawingApproval: !drawing.allApproved,
          drawingApprovalLabel: drawing.label,
          stats: {
            completed: items.filter((i) => i.completionPct >= 100).length,
            inProgress: items.filter((i) => i.completionPct > 0 && i.completionPct < 100).length,
            notStarted: items.filter((i) => i.completionPct === 0).length,
          },
          gantt: { total: mine.length, delayed: delayedActs.length, worstDelay },
        };
      })
    );

    // Returned newest-first (the query's order). The dashboard re-sorts client
    // side — its default is delay severity, but "last updated" needs this order.
    res.json({ projects: cards });
  })
);

// GET /api/projects/site-supervisors — active users for the project-form
// "Site supervisor" dropdown. The picked user's id is stored on the project so the
// weekly pending-deposit email can reach them. Any Admin/CEO (who alone can edit a
// project) may read this small name/email list.
router.get(
  '/site-supervisors',
  asyncHandler(async (req, res) => {
    const canEditProject = isAdmin(req.account!.role) || req.account!.role === 'CEO';
    if (!canEditProject) throw forbidden('Only an Admin or CEO can edit a project.');
    const users = await prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    res.json({ users });
  })
);

// One client PO the project is booked against, with an optional uploaded proof.
const clientPoSchema = z.object({ number: z.string().trim().min(1).max(120), proofUrl: z.string().max(1000).nullable().optional() });
const createSchema = z.object({
  name: z.string().min(1),
  clientName: z.string().optional(),
  siteLocation: z.string().optional(),
  siteSupervisor: z.string().trim().max(120).nullable().optional(),
  siteSupervisorId: z.string().nullable().optional(),
  clientPoNumber: z.string().optional(),
  clientPos: z.array(clientPoSchema).optional(),
  clientGstin: z.string().trim().max(20).nullable().optional(),
  startDate: z.string().datetime().optional().or(z.string().date().optional()),
  targetCompletionDate: z.string().datetime().optional().or(z.string().date().optional()),
  orderReceiveDate: z.string().nullable().optional(),
  advanceReceiveDate: z.string().nullable().optional(),
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
        siteSupervisor: body.siteSupervisor ?? null,
        siteSupervisorId: body.siteSupervisorId ?? null,
        // Legacy single field stays in sync with the first client PO for consumers
        // (packing-list default) that still read it.
        clientPoNumber: body.clientPos?.length ? body.clientPos[0].number : body.clientPoNumber,
        ...(body.clientPos !== undefined && { clientPos: body.clientPos }),
        clientGstin: body.clientGstin ?? null,
        startDate: body.startDate ? new Date(body.startDate) : null,
        targetCompletionDate: body.targetCompletionDate ? new Date(body.targetCompletionDate) : null,
        orderReceiveDate: body.orderReceiveDate ? new Date(body.orderReceiveDate) : null,
        advanceReceiveDate: body.advanceReceiveDate ? new Date(body.advanceReceiveDate) : null,
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
    // A test/sandbox project can't be opened by anyone but the super-admin.
    if (project.testOnly && !isSuperAdmin(req.user?.email)) throw notFound('Project not found');
    const prog = await loadProjectProgress(project.id);
    const drawingApproval = summarizeDrawingApprovals(normalizeDrawingApprovals(project.drawingApprovals));
    res.json({ project, progress: prog.overall, risk: prog.risk, role: req.projectRole, drawingApproval });
  })
);

// GET /api/projects/:projectId/site-presence — who is on this site and when,
// derived from the travel plans booked against this project. Read-only; visible
// to any project member (dashboard panel "Who's on site").
router.get(
  '/:projectId/site-presence',
  requireProjectMember,
  asyncHandler(async (req, res) => {
    const plans = await prisma.travelPlan.findMany({
      where: { projectId: req.params.projectId, status: { not: 'DRAFT' } },
      select: { planNumber: true, employeeName: true, fromDate: true, toDate: true, destination: true, days: true, status: true },
      orderBy: { fromDate: 'desc' },
    });
    res.json({ presence: plans });
  })
);

const updateSchema = createSchema.partial().extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  // On edit these dates must also accept `null` so the owner can CLEAR a date
  // that was set at creation — the create schema only allowed a string.
  clientName: z.string().nullable().optional(),
  siteLocation: z.string().nullable().optional(),
  clientPoNumber: z.string().nullable().optional(),
  startDate: z.string().min(1).nullable().optional(),
  targetCompletionDate: z.string().min(1).nullable().optional(),
  // Two of the three start-date parameters (the third — drawing approval — is
  // computed from the checklist, never set directly). See PRD §2.1.
  orderReceiveDate: z.string().nullable().optional(),
  advanceReceiveDate: z.string().nullable().optional(),
});

// PATCH /api/projects/:projectId — editable only by a global ADMIN or CEO
// account. No other role may change a project's core details, whatever their
// per-project membership role. requireProjectMember is deliberately NOT used: a
// CEO can edit any project without being a member of it, exactly like an admin.
router.patch(
  '/:projectId',
  asyncHandler(async (req, res) => {
    const canEditProject = isAdmin(req.account!.role) || req.account!.role === 'CEO';
    if (!canEditProject) throw forbidden('Only an Admin or CEO can edit a project.');
    const exists = await prisma.project.findUnique({ where: { id: req.params.projectId }, select: { id: true } });
    if (!exists) throw notFound('Project not found');
    const body = updateSchema.parse(req.body);
    const project = await prisma.project.update({
      where: { id: req.params.projectId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.clientName !== undefined && { clientName: body.clientName }),
        ...(body.siteLocation !== undefined && { siteLocation: body.siteLocation }),
        ...(body.siteSupervisor !== undefined && { siteSupervisor: body.siteSupervisor }),
        ...(body.siteSupervisorId !== undefined && { siteSupervisorId: body.siteSupervisorId }),
        ...(body.clientPos !== undefined && { clientPos: body.clientPos, clientPoNumber: body.clientPos?.[0]?.number ?? null }),
        ...(body.clientPos === undefined && body.clientPoNumber !== undefined && { clientPoNumber: body.clientPoNumber }),
        ...(body.clientGstin !== undefined && { clientGstin: body.clientGstin }),
        ...(body.startDate !== undefined && { startDate: body.startDate ? new Date(body.startDate) : null }),
        ...(body.targetCompletionDate !== undefined && {
          targetCompletionDate: body.targetCompletionDate ? new Date(body.targetCompletionDate) : null,
        }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.orderReceiveDate !== undefined && { orderReceiveDate: body.orderReceiveDate ? new Date(body.orderReceiveDate) : null }),
        ...(body.advanceReceiveDate !== undefined && { advanceReceiveDate: body.advanceReceiveDate ? new Date(body.advanceReceiveDate) : null }),
      },
    });
    await audit({ userId: req.user!.sub, projectId: project.id, action: 'PROJECT_UPDATE', entity: 'Project', entityId: project.id, details: body });
    res.json({ project });
  })
);

// POST /api/projects/:projectId/client-po-proof — upload a proof (PDF or image) for a
// client PO. Returns the file URL; the modal stores it on the PO entry, then saves.
// Admin/CEO only (same as project edit). Does not itself change the project.
router.post('/:projectId/client-po-proof', upload.single('file'), asyncHandler(async (req, res) => {
  const canEditProject = isAdmin(req.account!.role) || req.account!.role === 'CEO';
  if (!canEditProject) throw forbidden('Only an Admin or CEO can edit a project.');
  if (!req.file) throw badRequest('Please attach the proof (PDF or image).');
  const exists = await prisma.project.findUnique({ where: { id: req.params.projectId }, select: { id: true } });
  if (!exists) throw notFound('Project not found');
  const fileUrl = `/uploads/${req.file.filename}`;
  res.status(201).json({ ok: true, fileUrl });
}));

// ── Drawing Approval checklist (Sprint PRD §2.2) ─────────────────────────────
// Reachable from both project settings and the Gantt view. Editing is gated on
// the Gantt edit grant — the same person (Amisha) owns the timeline anchor.

async function drawingApprovalPayload(projectId: string) {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { drawingApprovals: true, orderReceiveDate: true, advanceReceiveDate: true, officialStartDate: true },
  });
  if (!p) throw notFound('Project not found');
  return {
    ...summarizeDrawingApprovals(normalizeDrawingApprovals(p.drawingApprovals)),
    orderReceiveDate: p.orderReceiveDate,
    advanceReceiveDate: p.advanceReceiveDate,
  };
}

router.get(
  '/:projectId/drawing-approvals',
  requireProjectMember,
  asyncHandler(async (req, res) => {
    res.json(await drawingApprovalPayload(req.params.projectId));
  })
);

const nullableDate = z.string().nullable().optional();
const approvalItemSchema = z.object({
  id: z.string().optional(),
  type: z.enum(DRAWING_APPROVAL_TYPES).optional(),
  name: z.string().trim().min(1),
  tatDays: z.coerce.number().int().min(1).default(4),
  drawingReceivedDate: nullableDate,
  plannedDate: nullableDate,
  actualDate: nullableDate,
  responsibleUserId: z.string().nullable().optional(),
  responsibleName: z.string().optional(),
  documentUrl: z.string().nullable().optional(),
  status: z.enum(DRAWING_APPROVAL_STATUSES).optional(),
});

// PUT — replace the whole checklist. The client always sends the full array
// (add / remove / tick are all one save), and officialStartDate is recomputed
// from it here, so the stored date and the checklist can never drift apart.
router.put(
  '/:projectId/drawing-approvals',
  requireProjectMember,
  requireEdit('gantt'),
  asyncHandler(async (req, res) => {
    const { items } = z.object({ items: z.array(approvalItemSchema).min(1, 'At least one drawing is required.') }).parse(req.body);
    const normalized = normalizeDrawingApprovals(items);
    const officialStartDate = computeOfficialStartDate(normalized);

    await prisma.project.update({
      where: { id: req.params.projectId },
      data: { drawingApprovals: normalized as unknown as object, officialStartDate },
    });
    await audit({
      userId: req.user!.sub, projectId: req.params.projectId, action: 'DRAWING_APPROVAL_UPDATE',
      entity: 'Project', entityId: req.params.projectId,
      details: { approved: normalized.filter((i) => i.status === 'APPROVED').length, total: normalized.length, officialStartDate },
    });
    res.json(await drawingApprovalPayload(req.params.projectId));
  })
);

// POST — reset the checklist back to the 4 standard drawings.
router.post(
  '/:projectId/drawing-approvals/reset',
  requireProjectMember,
  requireEdit('gantt'),
  asyncHandler(async (req, res) => {
    await prisma.project.update({
      where: { id: req.params.projectId },
      data: { drawingApprovals: defaultDrawingApprovals() as unknown as object, officialStartDate: null },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'DRAWING_APPROVAL_RESET', entity: 'Project', entityId: req.params.projectId });
    res.json(await drawingApprovalPayload(req.params.projectId));
  })
);

// POST — attach the final approved drawing PDF to one checklist row.
router.post(
  '/:projectId/drawing-approvals/:itemId/document',
  requireProjectMember,
  requireEdit('gantt'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded (field: file)');
    if (req.file.mimetype !== 'application/pdf') throw badRequest('Only PDF drawings can be attached.');
    const p = await prisma.project.findUnique({ where: { id: req.params.projectId }, select: { drawingApprovals: true } });
    if (!p) throw notFound('Project not found');

    const items = normalizeDrawingApprovals(p.drawingApprovals);
    const target = items.find((i) => i.id === req.params.itemId);
    if (!target) throw notFound('Drawing checklist item not found');
    target.documentUrl = `/uploads/${req.file.filename}`;

    await prisma.project.update({ where: { id: req.params.projectId }, data: { drawingApprovals: items as unknown as object } });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'DRAWING_APPROVAL_DOC', entity: 'Project', entityId: req.params.projectId, details: { itemId: target.id, fileName: req.file.originalname } });
    res.status(201).json(await drawingApprovalPayload(req.params.projectId));
  })
);

// ── Members (FR-PM-03) ──────────────────────────────────────────────────────

const memberSchema = z.object({ email: z.string().email(), role: z.enum(PROJECT_ROLES) });

// Active accounts that are NOT already on this project — feeds the "Invite
// Member" dropdown so admins pick from existing users instead of typing.
router.get(
  '/:projectId/invitable-users',
  requireProjectMember,
  requireEdit('team'),
  asyncHandler(async (req, res) => {
    const members = await prisma.projectMember.findMany({ where: { projectId: req.params.projectId }, select: { userId: true } });
    const memberIds = members.map((m) => m.userId);
    const users = await prisma.user.findMany({
      where: { active: true, ...(memberIds.length ? { id: { notIn: memberIds } } : {}) },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    });
    res.json({ users });
  })
);

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
