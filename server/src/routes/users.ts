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
  employeeCode?: string | null;
  whatsapp: string | null; pageAccess: string | null; sectionPerms: string | null; approver?: string | null; createdAt?: Date;
  lastLoginAt?: Date | null; lastLogoutAt?: Date | null;
}) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
    employeeCode: u.employeeCode ?? '',
    whatsapp: u.whatsapp ?? '',
    pageAccess: parseGrants(u.pageAccess),
    sectionPerms: parseSections(u.sectionPerms),
    approver: parseApprover(u.approver),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt ?? null,
    lastLogoutAt: u.lastLogoutAt ?? null,
  };
}

// Column selection shared by the user endpoints (keeps `approver` included).
const USER_SELECT = {
  id: true, name: true, email: true, role: true, active: true, employeeCode: true,
  whatsapp: true, pageAccess: true, sectionPerms: true, approver: true, createdAt: true,
  lastLoginAt: true, lastLogoutAt: true,
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
      // 'dpr' is admin-only (enforced in routes/dpr.ts), so granting it to a
      // non-admin does nothing — keep it out of the grantable-pages grid.
      pages: PAGE_KEYS.filter((key) => key !== 'dpr').map((key) => ({ key, label: PAGE_LABELS[key] })),
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

// GET /api/users/:id/activity — everything this user has done in the app:
// what they RAISED (POs, WOs, GRNs, payments, vendors, change orders), what they
// DECIDED (approved / rejected, per document type), and the raw action trail.
// Counts come from the documents themselves — not from parsing audit strings —
// so they stay right even if an audit action is ever renamed.
const safeParse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// Decisions are counted from the AUDIT LOG, not from ApprovalAction: an approval
// taken without an approval chain (the legacy/admin path) never writes an
// ApprovalAction row, so that table under-reports. The audit log records every
// decision on every path. Maps each decision action to the document it acted on.
// The *_REJECT actions are historical: approvers now put a document ON HOLD
// (*_HOLD) instead of rejecting it. Both are kept so old activity still reads.
const DECISION_DOC: Record<string, string> = {
  PROC_DOC_APPROVE: 'PO/WO', PROC_DOC_HOLD: 'PO/WO', PROC_DOC_REJECT: 'PO/WO',
  GRN_APPROVE: 'GRN', GRN_HOLD: 'GRN', GRN_REJECT: 'GRN',
  FMS_APPROVE: 'Payment', FMS_HOLD: 'Payment', FMS_REJECT: 'Payment',
  CO_APPROVE: 'Change order', CO_REJECT: 'Change order',
  ENTRY_APPROVE: 'DPR entry', ENTRY_REJECT: 'DPR entry',
};

router.get(
  '/:id/activity',
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, role: true, lastLoginAt: true, lastLogoutAt: true, createdAt: true } });
    if (!user) throw notFound('User not found');

    const [docs, grnCount, paymentCount, vendorCount, changeOrderCount, decisions, loginCount, totalActions, logs, attendanceLogs] = await Promise.all([
      prisma.procurementDoc.findMany({ where: { createdById: userId }, select: { type: true } }),
      prisma.gRN.count({ where: { raisedById: userId } }),
      prisma.vendorPayment.count({ where: { filledById: userId } }),
      prisma.vendor.count({ where: { createdById: userId } }),
      prisma.changeOrder.count({ where: { createdById: userId } }),
      prisma.auditLog.findMany({ where: { userId, action: { in: Object.keys(DECISION_DOC) } }, select: { action: true } }),
      prisma.auditLog.count({ where: { userId, action: 'USER_LOGIN' } }),
      prisma.auditLog.count({ where: { userId } }),
      prisma.auditLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { project: { select: { name: true } } },
      }),
      // Login/logout events, oldest→newest, so we can pair them into sessions.
      prisma.auditLog.findMany({
        where: { userId, action: { in: ['USER_LOGIN', 'USER_LOGOUT'] } },
        orderBy: { createdAt: 'asc' },
        take: 400,
        select: { action: true, createdAt: true },
      }),
    ]);

    // Pair each login with the next logout into an attendance session. A login
    // with no following logout is still shown (open / unknown checkout).
    const attendance: { loginAt: Date; logoutAt: Date | null }[] = [];
    for (const ev of attendanceLogs) {
      if (ev.action === 'USER_LOGIN') {
        attendance.push({ loginAt: ev.createdAt, logoutAt: null });
      } else if (attendance.length && attendance[attendance.length - 1].logoutAt === null) {
        attendance[attendance.length - 1].logoutAt = ev.createdAt;
      }
    }
    attendance.reverse(); // most recent session first

    // Decisions tallied per document type (PO/WO, GRN, Payment, …). "On hold"
    // also absorbs the historical *_REJECT actions from before the rename.
    const tally = (...verbs: string[]) =>
      decisions
        .filter((d) => verbs.some((v) => d.action.endsWith(`_${v}`)))
        .reduce<Record<string, number>>((m, d) => { const k = DECISION_DOC[d.action]; m[k] = (m[k] ?? 0) + 1; return m; }, {});
    const approved = tally('APPROVE');
    const onHold = tally('HOLD', 'REJECT');
    const sum = (o: Record<string, number>) => Object.values(o).reduce((s, n) => s + n, 0);

    res.json({
      user,
      summary: {
        lastLoginAt: user.lastLoginAt,
        lastLogoutAt: user.lastLogoutAt,
        loginCount,
        totalActions,
        created: {
          PO: docs.filter((d) => d.type === 'PO').length,
          WO: docs.filter((d) => d.type === 'WO').length,
          GRN: grnCount,
          PAYMENT: paymentCount,
          VENDOR: vendorCount,
          CHANGE_ORDER: changeOrderCount,
        },
        approved, onHold,
        totalApproved: sum(approved),
        totalOnHold: sum(onHold),
      },
      // Login → logout sessions (attendance), most recent first.
      attendance: attendance.slice(0, 60).map((s) => ({
        loginAt: s.loginAt,
        logoutAt: s.logoutAt,
        durationMs: s.logoutAt ? new Date(s.logoutAt).getTime() - new Date(s.loginAt).getTime() : null,
      })),
      // Most recent first; capped so a heavy user doesn't blow up the response.
      actions: logs.map((l) => ({
        id: l.id, action: l.action, entity: l.entity, entityId: l.entityId,
        details: safeParse(l.details), at: l.createdAt, projectName: l.project?.name ?? null,
      })),
    });
  })
);

// GET /api/users/:id/attendance?month=YYYY-MM — a per-day attendance calendar
// built from the USER_LOGIN / USER_LOGOUT audit trail. For each calendar day
// (India time) we report the FIRST login and the LAST logout of that day.
const IST = 'Asia/Kolkata';
const istDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: IST }); // YYYY-MM-DD
const istTime = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit' }); // HH:mm

router.get(
  '/:id/attendance',
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
    if (!user) throw notFound('User not found');

    // Which month? Default to the current month (India time).
    const nowDay = istDay(new Date()); // YYYY-MM-DD
    const mReq = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ''));
    const year = mReq ? Number(mReq[1]) : Number(nowDay.slice(0, 4));
    const month0 = mReq ? Number(mReq[2]) - 1 : Number(nowDay.slice(5, 7)) - 1; // 0-based
    const monthKey = `${year}-${String(month0 + 1).padStart(2, '0')}`;

    // Pull a padded UTC window around the month so IST-day bucketing near the
    // month edges can't drop an event.
    const start = new Date(Date.UTC(year, month0, 1) - 12 * 3600 * 1000);
    const end = new Date(Date.UTC(year, month0 + 1, 1) + 12 * 3600 * 1000);
    const events = await prisma.auditLog.findMany({
      where: { userId, action: { in: ['USER_LOGIN', 'USER_LOGOUT'] }, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true },
    });

    const byDay: Record<string, { firstLogin: Date | null; lastLogout: Date | null }> = {};
    for (const e of events) {
      const day = istDay(e.createdAt);
      const b = (byDay[day] ||= { firstLogin: null, lastLogout: null });
      if (e.action === 'USER_LOGIN') { if (!b.firstLogin) b.firstLogin = e.createdAt; }
      else { b.lastLogout = e.createdAt; }
    }

    const days = Object.entries(byDay)
      .filter(([d]) => d.startsWith(monthKey))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, b]) => ({
        date,
        login: b.firstLogin ? istTime(b.firstLogin) : null,
        logout: b.lastLogout ? istTime(b.lastLogout) : null,
      }));

    res.json({ user, month: monthKey, today: nowDay, days });
  })
);

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string(),
  role: z.enum(ROLES).default('USER'),
  active: z.boolean().default(true),
  employeeCode: z.string().trim().optional(),
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
        employeeCode: body.employeeCode?.trim() || null,
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
  employeeCode: z.string().trim().optional(),
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
        ...(body.employeeCode !== undefined && { employeeCode: body.employeeCode?.trim() || null }),
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
