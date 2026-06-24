// Central definition of the string "enum" values used across the app.
// (SQLite has no native enums, so we validate in code.)

// ── Global account roles (IMS-style) ────────────────────────────────────────
// ADMIN always has full access. Every other role (USER, CEO, SITE_ENGINEER…)
// is grant-based — it sees only what an admin explicitly grants (pages +
// section permissions + project access). The role beyond ADMIN is effectively
// a descriptive label; access comes from the grants, so admins stay in control.
export const ROLES = ['USER', 'ADMIN', 'CEO', 'SITE_ENGINEER'] as const;
export type Role = (typeof ROLES)[number];

// Human-friendly labels for the account-role dropdown.
export const ROLE_LABELS: Record<Role, string> = {
  USER: 'User',
  ADMIN: 'Admin',
  CEO: 'CEO',
  SITE_ENGINEER: 'Site Engineer',
};

// ── Per-project roles ────────────────────────────────────────────────────────
// These live on ProjectMember.role and drive the approval-workflow semantics
// inside a project (kept intact). They are NOT the global account role.
export const PROJECT_ROLES = ['ADMIN', 'ENGINEER', 'SUPERVISOR', 'CLIENT', 'MANAGEMENT'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ENTRY_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'VOIDED'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const DRAWING_STATUSES = ['PROCESSING', 'APPROVED', 'ARCHIVED'] as const;
export type DrawingStatus = (typeof DRAWING_STATUSES)[number];

// Per-project roles that can never modify data (read-only).
export const READ_ONLY_ROLES: ProjectRole[] = ['CLIENT', 'MANAGEMENT'];

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function isProjectRole(v: unknown): v is ProjectRole {
  return typeof v === 'string' && (PROJECT_ROLES as readonly string[]).includes(v);
}

// Global-role admin check. The single source of truth for "full access".
export const isAdmin = (role?: string | null): boolean => role === 'ADMIN';
