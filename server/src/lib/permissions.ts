// IMS-style page access + section permissions.
//
// A USER sees only what an admin grants:
//   • pageAccess  — per-page { view, edit } grants (which pages they can see /
//                   act in). Stored on User.pageAccess as JSON.
//   • sectionPerms— curated cross-cutting capability/visibility toggles.
//                   Stored on User.sectionPerms as JSON.
// ADMIN bypasses all grants (full access), and is never subject to
// "hide financials".

import { isAdmin } from './enums';
import type { Role } from './enums';

// The CRMCTS pages (matches the client sidebar + top-nav + the admin grid).
export const PAGE_KEYS = [
  'dashboard', 'boq', 'drawing',
  'gantt', 'changeorders',
  'pay', 'po', 'wo', 'grn', 'vendors', 'documents',
  'machinemodels',
  'team', 'approvals', 'financials',
  // Room-wise DPR — one grant covers all of its tabs (dashboard, daily entry,
  // the 8 room sheets, handover tracker, milestones).
  'dpr',
  // Procurement register: PO → GRN → invoice → payment, vendor outstanding.
  'reports',
  // FMS — vendor payment entry (finance). Admin grants view/edit per user.
  'fms',
  // Petty Cash — site-manager cash float + expense ledger (finance).
  'pettycash',
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const PAGE_LABELS: Record<PageKey, string> = {
  dashboard: 'Dashboard',
  boq: 'BOQ & Progress',
  drawing: 'Drawing & 3D',
  gantt: 'Gantt / Timeline',
  changeorders: 'Change Orders',
  pay: 'Payment Pipeline',
  po: 'Purchase Orders',
  wo: 'Work Orders',
  grn: 'Payment & Goods Receipt (GRN)',
  vendors: 'Vendors',
  documents: 'Documents',
  machinemodels: 'Machine Models',
  team: 'Team',
  approvals: 'Approvals',
  financials: 'Financials',
  dpr: 'DPR (Room-wise)',
  reports: 'Reports & Registers',
  fms: 'FMS — Vendor Payments',
  pettycash: 'Petty Cash',
};

// Curated section-level toggles (IMS "section permissions").
// Entering the budget and FREEZING it are deliberately two different rights: the
// costing may be typed by one person and locked by whoever owns the number.
// Freezing is what makes the budget the benchmark, so it is the stronger right.
export const SECTION_KEYS = ['hideFinancials', 'canApprove', 'canMarkPaid', 'canEditBudget', 'canFreezeBudget'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  hideFinancials: 'Hide pricing & financial data',
  canApprove: 'Can approve (PO/WO, GRN, progress entries)',
  canMarkPaid: 'Can mark payment milestones paid (Accounts)',
  canEditBudget: 'Can enter the BOQ budget (costing)',
  canFreezeBudget: 'Can FREEZE the budget (locks it for everyone)',
};

export interface PageGrant { view: boolean; edit: boolean }
export type Grants = Partial<Record<PageKey, PageGrant>>;
export type SectionPerms = Partial<Record<SectionKey, boolean>>;

// ── Approver registry ────────────────────────────────────────────────────────
// A curated list of who may approve, used as the single source of truth when
// building an approval chain on a PO/WO/GRN. Approval roles are a preset list
// but a custom role string is allowed. Types gate which document kinds an
// approver may be placed on ('ALL' = any).
export const APPROVAL_ROLES = ['Site Manager', 'Ops Head', 'Director', 'Finance'] as const;
export const APPROVAL_TYPES = ['PO', 'WO', 'GRN', 'VENDOR_PAYMENT'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number] | 'ALL';

// Document types are named PAYMENT in the matrix/chain tables but VENDOR_PAYMENT
// on user records. Route every docType through here before checking rights.
export function approvalTypeForDoc(docType: string): ApprovalType {
  return (docType === 'PAYMENT' ? 'VENDOR_PAYMENT' : docType) as ApprovalType;
}

export interface ApproverProfile {
  canApprove: boolean;
  approvalRole: string | null; // preset or custom label
  level: number;               // ordering hint (1 = first line, higher = senior)
  types: ApprovalType[];       // allowed doc types, or ['ALL']
}

export const EMPTY_APPROVER: ApproverProfile = { canApprove: false, approvalRole: null, level: 1, types: [] };

export function parseApprover(json: string | null | undefined): ApproverProfile {
  if (!json) return { ...EMPTY_APPROVER };
  try {
    const raw = JSON.parse(json) as Partial<ApproverProfile> & { types?: unknown };
    const types = Array.isArray(raw.types)
      ? (raw.types.filter((t) => t === 'ALL' || (APPROVAL_TYPES as readonly string[]).includes(String(t))) as ApprovalType[])
      : [];
    return {
      canApprove: !!raw.canApprove,
      approvalRole: raw.approvalRole ? String(raw.approvalRole) : null,
      level: Number.isFinite(raw.level) ? Number(raw.level) : 1,
      types,
    };
  } catch {
    return { ...EMPTY_APPROVER };
  }
}

// Sanitise the approver profile coming from the admin UI before persisting.
export function cleanApprover(input: unknown): ApproverProfile {
  const raw = (input ?? {}) as Partial<ApproverProfile> & { types?: unknown };
  const canApprove = !!raw.canApprove;
  if (!canApprove) return { ...EMPTY_APPROVER };
  const typesRaw = Array.isArray(raw.types) ? raw.types.map(String) : [];
  const types = (typesRaw.includes('ALL')
    ? ['ALL']
    : APPROVAL_TYPES.filter((t) => typesRaw.includes(t))) as ApprovalType[];
  const level = Number.isFinite(raw.level) ? Math.max(1, Math.round(Number(raw.level))) : 1;
  const approvalRole = raw.approvalRole ? String(raw.approvalRole).trim().slice(0, 60) || null : null;
  return { canApprove: true, approvalRole, level, types };
}

// Whether an approver profile is allowed to approve a given document type.
export function approverHandlesType(p: ApproverProfile | null | undefined, type: ApprovalType): boolean {
  if (!p?.canApprove) return false;
  return p.types.includes('ALL') || p.types.includes(type);
}

// The enriched signed-in account resolved per request (from the DB, not the JWT)
// so deactivation / permission edits take effect immediately.
export interface Account {
  id: string;
  role: Role;
  active: boolean;
  grants: Grants;
  sections: SectionPerms;
}

export function parseGrants(json: string | null | undefined): Grants {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: Grants = {};
    for (const k of PAGE_KEYS) {
      const g = raw?.[k] as { view?: unknown; edit?: unknown } | undefined;
      if (g && typeof g === 'object') out[k] = { view: !!g.view, edit: !!g.edit };
    }
    return out;
  } catch {
    return {};
  }
}

export function parseSections(json: string | null | undefined): SectionPerms {
  if (!json) return {};
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    const out: SectionPerms = {};
    for (const k of SECTION_KEYS) if (raw?.[k]) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

// Sanitise an arbitrary grants object coming from the admin UI to the known
// page keys / boolean shape before persisting.
export function cleanGrants(input: unknown): Grants {
  const raw = (input ?? {}) as Record<string, { view?: unknown; edit?: unknown }>;
  const out: Grants = {};
  for (const k of PAGE_KEYS) {
    const g = raw[k];
    if (g && typeof g === 'object') {
      const view = !!g.view;
      // edit is meaningless without view.
      out[k] = { view, edit: view && !!g.edit };
    }
  }
  return out;
}

export function cleanSections(input: unknown): SectionPerms {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: SectionPerms = {};
  for (const k of SECTION_KEYS) out[k] = !!raw[k];
  return out;
}

// Full grant set — used for ADMIN and for backfilling legacy users.
export function allPagesGrant(edit = true): Grants {
  const g: Grants = {};
  for (const k of PAGE_KEYS) g[k] = { view: true, edit };
  return g;
}

// ── Per-account checks (ADMIN always passes) ─────────────────────────────────

export function canViewPage(acc: Account | undefined | null, page: PageKey): boolean {
  if (!acc) return false;
  if (isAdmin(acc.role)) return true;
  return !!acc.grants[page]?.view;
}

export function canEditPage(acc: Account | undefined | null, page: PageKey): boolean {
  if (!acc) return false;
  if (isAdmin(acc.role)) return true;
  const g = acc.grants[page];
  return !!(g?.view && g?.edit);
}

export function canViewAny(acc: Account | undefined | null, pages: PageKey[]): boolean {
  return pages.some((p) => canViewPage(acc, p));
}

export function canEditAny(acc: Account | undefined | null, pages: PageKey[]): boolean {
  return pages.some((p) => canEditPage(acc, p));
}

export function hasSection(acc: Account | undefined | null, flag: SectionKey): boolean {
  if (!acc) return false;
  // ADMIN has every capability and is never subject to financial hiding.
  if (isAdmin(acc.role)) return flag !== 'hideFinancials';
  return !!acc.sections[flag];
}

// True when financial figures must be stripped/masked for this account.
export function shouldHideFinancials(acc: Account | undefined | null): boolean {
  if (!acc) return true;
  if (isAdmin(acc.role)) return false;
  return !!acc.sections.hideFinancials;
}
