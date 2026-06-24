// Client mirror of the server permission model (server/src/lib/permissions.ts).
// Used for nav gating, action-button gating, and the admin Users screen.

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

export const SECTION_KEYS = ['hideFinancials', 'canApprove', 'canMarkPaid'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_LABELS: Record<SectionKey, string> = {
  hideFinancials: 'Hide pricing & financial data',
  canApprove: 'Can approve (PO/WO, GRN, progress entries)',
  canMarkPaid: 'Can mark payment milestones paid (Accounts)',
};

export const SECTION_HINTS: Record<SectionKey, string> = {
  hideFinancials: 'Strips every ₹ amount, contract rate and revenue total from this user — in the UI and the API payloads.',
  canApprove: 'Enables approve / reject on PO/WO, GRNs and progress entries.',
  canMarkPaid: 'Allows marking triggered payment milestones as paid.',
};

export interface PageGrant { view: boolean; edit: boolean }
export type Grants = Partial<Record<PageKey, PageGrant>>;
export type SectionPerms = Partial<Record<SectionKey, boolean>>;

export interface PermUser {
  // ADMIN = full access; any other role is grant-based.
  role: string;
  pageAccess?: Grants;
  sectionPerms?: SectionPerms;
}

export const isAdmin = (u: PermUser | null | undefined): boolean => u?.role === 'ADMIN';

export function canViewPage(u: PermUser | null | undefined, page: PageKey): boolean {
  if (!u) return false;
  if (isAdmin(u)) return true;
  return !!u.pageAccess?.[page]?.view;
}

export function canEditPage(u: PermUser | null | undefined, page: PageKey): boolean {
  if (!u) return false;
  if (isAdmin(u)) return true;
  const g = u.pageAccess?.[page];
  return !!(g?.view && g?.edit);
}

export function hasSection(u: PermUser | null | undefined, flag: SectionKey): boolean {
  if (!u) return false;
  if (isAdmin(u)) return flag !== 'hideFinancials';
  return !!u.sectionPerms?.[flag];
}

export function shouldHideFinancials(u: PermUser | null | undefined): boolean {
  if (!u) return true;
  if (isAdmin(u)) return false;
  return !!u.sectionPerms?.hideFinancials;
}

// First page (in canonical order) the user can view — used as a landing target.
export function firstViewablePage(u: PermUser | null | undefined): PageKey | null {
  return PAGE_KEYS.find((p) => canViewPage(u, p)) ?? null;
}
