import type { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../lib/auth';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyPathSignature } from '../lib/signedUrl';
import type { Role, ProjectRole } from '../lib/enums';
import { READ_ONLY_ROLES, isAdmin } from '../lib/enums';
import { isDprOwner } from '../lib/dprAccess';
import type { Account, PageKey, SectionKey } from '../lib/permissions';
import {
  parseGrants, parseSections,
  canViewPage, canEditPage, canViewAny, canEditAny, hasSection, shouldHideFinancials,
} from '../lib/permissions';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
      // The enriched, DB-resolved account (role + active + grants). Source of
      // truth for all permission checks — so deactivation and permission edits
      // take effect immediately, without waiting for a new token.
      account?: Account;
      // Per-project effective role, resolved by requireProjectMember.
      projectRole?: ProjectRole;
    }
  }
}

// Require a valid JWT AND an active account. Populates req.user + req.account.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  // Shareable signed links (e.g. PDF URLs and the vendor KYC page exported to
  // Google Sheets) carry a path-bound ?sig=... instead of a bearer header,
  // because a link clicked from an external app can't send Authorization. Honor
  // it only for GET requests to a "/pdf" file endpoint or a "/kyc-view" KYC list
  // page, and only when the signature matches this exact path — so it unlocks
  // that one read-only resource and grants no other capability. A valid signature
  // can only be minted with JWT_SECRET, so it can't be forged.
  const reqPath = req.originalUrl.split('?')[0];
  if (
    req.method === 'GET' &&
    (reqPath.endsWith('/pdf') || reqPath.endsWith('/kyc-view')) &&
    verifyPathSignature(reqPath, req.query.sig as string | undefined)
  ) {
    req.user = { sub: 'signed-link', email: '', role: 'ADMIN' as Role, name: 'Signed link' };
    req.account = { id: 'signed-link', role: 'ADMIN' as Role, active: true, grants: {}, sections: {} };
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next(unauthorized('Missing bearer token'));
  }
  let payload: JwtPayload;
  try {
    payload = verifyToken(header.slice(7));
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }
  req.user = payload;

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, active: true, pageAccess: true, sectionPerms: true },
  });
  if (!user) return next(unauthorized('Account no longer exists'));
  if (!user.active) return next(unauthorized('Account is deactivated'));

  req.account = {
    id: user.id,
    role: user.role as Role,
    active: user.active,
    grants: parseGrants(user.pageAccess),
    sections: parseSections(user.sectionPerms),
  };
  next();
}

// Require the global ADMIN account role.
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.account) return next(unauthorized());
  if (!isAdmin(req.account.role)) return next(forbidden('Admin only'));
  next();
}

// API-key management is a security surface, so it is restricted to ONE named
// super-admin identity (an email), not every admin. Configurable via env.
export const SUPERADMIN_EMAIL = (process.env.API_SUPERADMIN_EMAIL || 'admin@crmcts.dev').toLowerCase();
export function isSuperAdmin(email?: string | null): boolean {
  return !!email && email.toLowerCase() === SUPERADMIN_EMAIL;
}
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (!isSuperAdmin(req.user.email)) return next(forbidden('API key management is restricted to the super-admin.'));
  next();
}

// Require the caller to be a room-wise DPR owner (a specific email allowlist,
// NOT every admin). See lib/dprAccess.ts.
export function requireDprOwner(req: Request, _res: Response, next: NextFunction) {
  if (!req.account) return next(unauthorized());
  if (!isDprOwner(req.user?.email)) return next(forbidden('The room-wise DPR is restricted to its owner.'));
  next();
}

// Require one of the given global roles (kept for completeness).
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) return next(unauthorized());
    if (!roles.includes(req.account.role)) return next(forbidden('Insufficient role'));
    next();
  };
}

// ── Page / section guards (ADMIN bypasses all) ───────────────────────────────

// User must be able to VIEW the page (read access).
export function requirePage(page: PageKey) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) return next(unauthorized());
    if (!canViewPage(req.account, page)) return next(forbidden('You do not have access to this page'));
    next();
  };
}

// User must be able to EDIT the page (perform write/action operations).
export function requireEdit(page: PageKey) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) return next(unauthorized());
    if (!canEditPage(req.account, page)) return next(forbidden('You do not have edit access to this page'));
    next();
  };
}

// View access to ANY of the given pages (shared endpoints, e.g. procurement
// docs that back the Payment Pipeline / PO / WO tabs).
export function requireAnyPage(...pages: PageKey[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) return next(unauthorized());
    if (!canViewAny(req.account, pages)) return next(forbidden('You do not have access to this page'));
    next();
  };
}

// Edit access to ANY of the given pages.
export function requireAnyEdit(...pages: PageKey[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) return next(unauthorized());
    if (!canEditAny(req.account, pages)) return next(forbidden('You do not have edit access to this page'));
    next();
  };
}

// Block endpoints that inherently expose money (e.g. PO/WO/GRN PDFs) for users
// who have "Hide pricing & financial data". ADMIN always passes.
export function requireFinancialView(req: Request, _res: Response, next: NextFunction) {
  if (!req.account) return next(unauthorized());
  if (shouldHideFinancials(req.account)) return next(forbidden('Financial data is hidden for your account'));
  next();
}

// Access to the BOQ & Budget page. A budget capability (enter or freeze) IS the
// grant — you can't cost a budget you can't see, so canEditBudget / canFreezeBudget
// see it regardless of the boq page grant or hideFinancials. Otherwise fall back
// to the normal rule: the boq page + financial view.
export function requireBudgetView(req: Request, _res: Response, next: NextFunction) {
  if (!req.account) return next(unauthorized());
  if (hasSection(req.account, 'canEditBudget') || hasSection(req.account, 'canFreezeBudget')) return next();
  if (shouldHideFinancials(req.account)) return next(forbidden('The budget is hidden for your account.'));
  if (!canViewPage(req.account, 'boq')) return next(forbidden('You do not have access to the budget.'));
  next();
}

// User must hold a section-level capability (canApprove / canMarkPaid).
export function requireSection(flag: SectionKey) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) return next(unauthorized());
    if (!hasSection(req.account, flag)) return next(forbidden('You do not have this permission'));
    next();
  };
}

// Require the user to be a member of :projectId (ADMIN bypasses membership).
// Resolves req.projectRole to the user's effective role for the project.
export async function requireProjectMember(req: Request, _res: Response, next: NextFunction) {
  if (!req.account) return next(unauthorized());
  const projectId = req.params.projectId || req.params.id;
  if (!projectId) return next(forbidden('No project in scope'));

  if (isAdmin(req.account.role)) {
    req.projectRole = 'ADMIN';
    return next();
  }
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: req.account.id } },
  });
  if (!member) return next(forbidden('You do not have access to this project'));
  req.projectRole = member.role as ProjectRole;
  next();
}

// Block read-only project roles (CLIENT, MANAGEMENT) from write actions.
export function requireWriteAccess(req: Request, _res: Response, next: NextFunction) {
  if (req.account && isAdmin(req.account.role)) return next();
  const role = req.projectRole;
  if (!role) return next(unauthorized());
  if (READ_ONLY_ROLES.includes(role)) return next(forbidden('Read-only role cannot modify data'));
  next();
}

// Require a specific per-project role (after requireProjectMember).
export function requireProjectRole(...roles: ProjectRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.account && isAdmin(req.account.role)) return next();
    const role = req.projectRole;
    if (!role) return next(unauthorized());
    if (!roles.includes(role)) return next(forbidden('Insufficient project role'));
    next();
  };
}
