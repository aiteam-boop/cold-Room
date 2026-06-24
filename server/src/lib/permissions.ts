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

// The 12 CRMCTS pages (matches the client sidebar + top-nav + the admin grid).
export const PAGE_KEYS = [
  'dashboard', 'boq', 'drawing',
  'pay', 'po', 'wo', 'grn', 'vendors', 'documents',
  'team', 'approvals', 'financials',
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const PAGE_LABELS: Record<PageKey, string> = {
  dashboard: 'Dashboard',
  boq: 'BOQ & Progress',
  drawing: 'Drawing & 3D',
  pay: 'Payment Pipeline',
  po: 'Purchase Orders',
  wo: 'Work Orders',
  grn: 'GRNs',
  vendors: 'Vendors',
  documents: 'Documents',
  team: 'Team',
  approvals: 'Approvals',
  financials: 'Financials',
};

// Curated section-level toggles (IMS "section permissions").
export const SECTION_KEYS = ['hideFinancials', 'canApprove', 'canMarkPaid'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  hideFinancials: 'Hide pricing & financial data',
  canApprove: 'Can approve (PO/WO, GRN, progress entries)',
  canMarkPaid: 'Can mark payment milestones paid (Accounts)',
};

export interface PageGrant { view: boolean; edit: boolean }
export type Grants = Partial<Record<PageKey, PageGrant>>;
export type SectionPerms = Partial<Record<SectionKey, boolean>>;

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
