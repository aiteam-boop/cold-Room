// Central definition of the string "enum" values used across the app.
// (SQLite has no native enums, so we validate in code.)

// ── Global account roles (IMS-style) ────────────────────────────────────────
// ADMIN always has full access. Every other role (USER, CEO, SITE_ENGINEER…)
// is grant-based — it sees only what an admin explicitly grants (pages +
// section permissions + project access). The role beyond ADMIN is effectively
// a descriptive label; access comes from the grants, so admins stay in control.
export const ROLES = ['USER', 'ADMIN', 'CEO', 'SITE_ENGINEER', 'SITE_SUPERVISOR', 'SAFETY_ENGINEER'] as const;
export type Role = (typeof ROLES)[number];

// Human-friendly labels for the account-role dropdown.
export const ROLE_LABELS: Record<Role, string> = {
  USER: 'User',
  ADMIN: 'Admin',
  CEO: 'CEO',
  SITE_ENGINEER: 'Site Engineer',
  SITE_SUPERVISOR: 'Site Supervisor',
  SAFETY_ENGINEER: 'Safety Engineer',
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

// ── Vendor master (Sprint PRD §5) ────────────────────────────────────────────
export const VENDOR_TYPES = ['MANUFACTURER', 'TRADER', 'CONTRACTOR', 'SERVICE_PROVIDER'] as const;
export type VendorType = (typeof VENDOR_TYPES)[number];

// The 9 BOQ categories a vendor may supply.
export const BOQ_CATEGORIES = [
  'PUF Panels', 'Refrigeration Units', 'Refrigerant Piping', 'Insulated Doors',
  'Air Curtains', 'MS Structure', 'Drain Piping', 'Electrical', 'Other',
] as const;

// Work categories, shown only when vendorType = CONTRACTOR.
export const WORK_CATEGORIES = [
  'Panel Erection', 'Refrigeration Installation', 'Electrical Works', 'Plumbing', 'Civil', 'Other',
] as const;

// KYC document kinds. A vendor's KYC is COMPLETE only with the first three.
export const KYC_KINDS = [
  'GST_CERTIFICATE', 'PAN_CARD', 'CANCELLED_CHEQUE',
  'MSME_CERTIFICATE', 'INCORPORATION_CERTIFICATE', 'TRADE_LICENCE', 'OTHER',
] as const;
export type KycKind = (typeof KYC_KINDS)[number];

export const KYC_KIND_LABELS: Record<KycKind, string> = {
  GST_CERTIFICATE: 'GST Certificate',
  PAN_CARD: 'PAN Card',
  CANCELLED_CHEQUE: 'Cancelled Cheque',
  MSME_CERTIFICATE: 'MSME Certificate',
  INCORPORATION_CERTIFICATE: 'Incorporation Certificate',
  TRADE_LICENCE: 'Trade Licence',
  OTHER: 'Other Document',
};

/** The three documents that make a vendor's KYC COMPLETE. */
export const KYC_REQUIRED_KINDS: KycKind[] = ['GST_CERTIFICATE', 'PAN_CARD', 'CANCELLED_CHEQUE'];

export const CONTACT_AUTHORITY_LEVELS = ['Decision Maker', 'Technical', 'Commercial', 'Operations', 'Other'] as const;
export const BANK_ACCOUNT_TYPES = ['Current', 'Savings'] as const;
export const MAX_VENDOR_CONTACTS = 10;
export const MAX_CONTACT_PHONES = 3;

// ── Drawing approval checklist (Sprint PRD §2.2) ─────────────────────────────
// The 4 standard drawings. Admins may add custom types ('Custom') — no limit.
export const DRAWING_APPROVAL_TYPES = ['PUF_PANEL', 'REFRIGERATION', 'DOOR', 'ELECTRICAL', 'CUSTOM'] as const;
export type DrawingApprovalType = (typeof DRAWING_APPROVAL_TYPES)[number];

export const DRAWING_APPROVAL_STATUSES = ['PENDING', 'IN_REVIEW', 'APPROVED'] as const;
export type DrawingApprovalStatus = (typeof DRAWING_APPROVAL_STATUSES)[number];

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function isProjectRole(v: unknown): v is ProjectRole {
  return typeof v === 'string' && (PROJECT_ROLES as readonly string[]).includes(v);
}

// Global-role admin check. The single source of truth for "full access".
export const isAdmin = (role?: string | null): boolean => role === 'ADMIN';
