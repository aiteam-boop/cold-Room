// Vendor master profile — the Json sub-documents on the Vendor row.
// (Sprint PRD §5.)
//
// Each collection is stored as a Json array rather than its own table: they are
// small, unbounded-but-tiny, always loaded with the vendor, and never queried
// across vendors. The legacy scalar columns (contactPerson, phones, bankAccount,
// ifsc, address) are kept in sync with the *primary* contact / bank / plant so
// that PO snapshots and every existing read path keep working untouched.

import { randomUUID } from 'crypto';
import {
  BANK_ACCOUNT_TYPES, BOQ_CATEGORIES, CONTACT_AUTHORITY_LEVELS,
  KYC_REQUIRED_KINDS, MAX_CONTACT_PHONES, MAX_VENDOR_CONTACTS,
  VENDOR_TYPES, WORK_CATEGORIES,
} from '../lib/enums';
import type { KycKind } from '../lib/enums';

export interface VendorContact {
  id: string; name: string; designation: string | null;
  authorityLevel: string | null; phones: string[]; email: string | null; isPrimary: boolean;
}
export interface VendorPlant {
  id: string; address: string; address2: string | null;
  city: string | null; state: string | null; pin: string | null; gstin: string | null;
}
export interface VendorBillingAddress { address: string; city: string | null; state: string | null; pin: string | null }
export interface VendorBankAccount {
  id: string; bankName: string; branch: string | null; ifsc: string | null;
  accountNo: string; accountType: string | null; beneficiaryName: string | null; isPrimary: boolean;
}
export interface VendorRate {
  id: string; itemDescription: string; unit: string | null; rate: number;
  effectiveFrom: string | null; effectiveTo: string | null; notes: string | null;
}

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};
const isoDay = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const id = (v: unknown) => (typeof v === 'string' && v ? v : randomUUID());
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  allowed.includes(v as T) ? (v as T) : null;

/** Exactly one entry is primary: the first flagged one, else the first entry. */
function pickPrimary<T extends { isPrimary: boolean }>(list: T[]): T[] {
  if (list.length === 0) return list;
  const idx = Math.max(list.findIndex((x) => x.isPrimary), 0);
  return list.map((x, i) => ({ ...x, isPrimary: i === idx }));
}

export function normalizeContacts(raw: unknown): VendorContact[] {
  const list = arr(raw).slice(0, MAX_VENDOR_CONTACTS).flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const name = str(o.name);
    if (!name) return []; // a contact without a name is not a contact
    return [{
      id: id(o.id), name,
      designation: str(o.designation),
      authorityLevel: oneOf(o.authorityLevel, CONTACT_AUTHORITY_LEVELS),
      phones: arr(o.phones).map(str).filter((p): p is string => !!p).slice(0, MAX_CONTACT_PHONES),
      email: str(o.email),
      isPrimary: o.isPrimary === true,
    }];
  });
  return pickPrimary(list);
}

export function normalizePlants(raw: unknown): VendorPlant[] {
  return arr(raw).flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const address = str(o.address);
    if (!address) return [];
    return [{
      id: id(o.id), address, address2: str(o.address2),
      city: str(o.city), state: str(o.state), pin: str(o.pin), gstin: str(o.gstin),
    }];
  });
}

export function normalizeBillingAddress(raw: unknown): VendorBillingAddress | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const address = str(o.address);
  if (!address) return null;
  return { address, city: str(o.city), state: str(o.state), pin: str(o.pin) };
}

export function normalizeBankAccounts(raw: unknown): VendorBankAccount[] {
  const list = arr(raw).flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const accountNo = str(o.accountNo);
    const bankName = str(o.bankName);
    if (!accountNo || !bankName) return [];
    return [{
      id: id(o.id), bankName, accountNo,
      branch: str(o.branch), ifsc: str(o.ifsc)?.toUpperCase() ?? null,
      accountType: oneOf(o.accountType, BANK_ACCOUNT_TYPES),
      beneficiaryName: str(o.beneficiaryName),
      isPrimary: o.isPrimary === true,
    }];
  });
  return pickPrimary(list);
}

/**
 * Rate chart. Old rates are never deleted — a rate change is a new entry with a
 * new effectiveFrom date, so `rateFor()` can reconstruct history.
 */
export function normalizeRateChart(raw: unknown): VendorRate[] {
  return arr(raw).flatMap((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const itemDescription = str(o.itemDescription);
    const rate = Number(o.rate);
    if (!itemDescription || !Number.isFinite(rate) || rate < 0) return [];
    return [{
      id: id(o.id), itemDescription, rate: Math.round(rate * 100) / 100,
      unit: str(o.unit),
      effectiveFrom: isoDay(o.effectiveFrom), effectiveTo: isoDay(o.effectiveTo),
      notes: str(o.notes),
    }];
  });
}

export function normalizeCategories(raw: unknown, allowed: readonly string[]): string[] {
  return [...new Set(arr(raw).map(str).filter((c): c is string => !!c && allowed.includes(c)))];
}

export const normalizeBoqCategories = (raw: unknown) => normalizeCategories(raw, BOQ_CATEGORIES);
export const normalizeWorkCategories = (raw: unknown) => normalizeCategories(raw, WORK_CATEGORIES);
export const normalizeVendorType = (raw: unknown) => oneOf(raw, VENDOR_TYPES);

/**
 * The rate this vendor charges for an item on a given date. Picks the entry
 * whose date window contains `on`, preferring the most recently effective one
 * (rates are date-ranged, and an open-ended effectiveTo means "still current").
 */
export function rateFor(rateChart: VendorRate[], itemDescription: string, on: Date = new Date()): VendorRate | null {
  const key = itemDescription.toLowerCase().trim();
  if (!key) return null;
  const day = on.toISOString().slice(0, 10);
  const matches = rateChart
    .filter((r) => r.itemDescription.toLowerCase().trim() === key)
    .filter((r) => (!r.effectiveFrom || r.effectiveFrom <= day) && (!r.effectiveTo || r.effectiveTo >= day));
  if (matches.length === 0) return null;
  return matches.sort((a, b) => (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? ''))[0];
}

/**
 * KYC badge. COMPLETE requires GST certificate + PAN card + cancelled cheque.
 *
 * Documents uploaded before `kycKind` existed have a null kind; for those rows
 * we fall back to the old count-based heuristic (>= 4 docs = Complete) so
 * existing vendors don't regress to "Partial" overnight.
 */
export function kycStatus(docs: { kycKind: string | null }[]): 'Complete' | 'Partial' | 'Missing' {
  if (docs.length === 0) return 'Missing';
  const kinds = new Set(docs.map((d) => d.kycKind).filter(Boolean) as KycKind[]);
  if (kinds.size === 0) return docs.length >= 4 ? 'Complete' : 'Partial'; // legacy rows
  if (KYC_REQUIRED_KINDS.every((k) => kinds.has(k))) return 'Complete';
  return 'Partial';
}

// ── KYC completeness score (Procurement PRD §4 · Workstream C) ────────────────
// One checklist of the things a vendor needs before we can raise a PO and *pay*
// them. Each item is worth an equal share of the score; the mandatory ones gate
// usability — a vendor missing any mandatory item is "not usable" (a payment
// can't go out, e.g. no email = no payment intimation, no bank = nowhere to pay).
export interface KycScoreItem { key: string; label: string; done: boolean; mandatory: boolean }
export interface KycScore {
  items: KycScoreItem[];
  completed: number;
  total: number;
  percent: number;
  mandatoryMissing: string[];  // labels of the mandatory items still missing
  usable: boolean;             // true only when every mandatory item is present
  level: 'Complete' | 'Usable' | 'Incomplete' | 'Missing';
}

export function kycScore(
  vendor: { email?: string | null; gstin?: string | null; bankAccount?: string | null; ifsc?: string | null; bankAccounts?: unknown },
  docs: { kycKind: string | null }[],
): KycScore {
  const kinds = new Set(docs.map((d) => d.kycKind).filter(Boolean) as KycKind[]);
  // Legacy vendors uploaded docs before `kycKind` existed — count 4+ untyped docs
  // as covering the three required certificates, so they don't regress overnight.
  const legacyComplete = kinds.size === 0 && docs.length >= 4;
  const hasDoc = (k: KycKind) => kinds.has(k) || legacyComplete;
  const bankOk = (() => {
    const accs = normalizeBankAccounts(vendor.bankAccounts);
    if (accs.some((a) => a.accountNo && a.ifsc)) return true;
    return Boolean(vendor.bankAccount && vendor.ifsc);
  })();
  const filled = (v?: string | null) => Boolean(v && v.trim());
  const items: KycScoreItem[] = [
    { key: 'GST_CERTIFICATE', label: 'GST Certificate', done: hasDoc('GST_CERTIFICATE'), mandatory: true },
    { key: 'PAN_CARD', label: 'PAN Card', done: hasDoc('PAN_CARD'), mandatory: true },
    { key: 'CANCELLED_CHEQUE', label: 'Cancelled Cheque', done: hasDoc('CANCELLED_CHEQUE'), mandatory: true },
    { key: 'BANK_ACCOUNT', label: 'Bank Account', done: bankOk, mandatory: true },
    { key: 'EMAIL', label: 'Email ID', done: filled(vendor.email), mandatory: true },
    { key: 'GST_NUMBER', label: 'GST Number', done: filled(vendor.gstin), mandatory: false },
  ];
  const completed = items.filter((i) => i.done).length;
  const total = items.length;
  const percent = Math.round((completed / total) * 100);
  const mandatoryMissing = items.filter((i) => i.mandatory && !i.done).map((i) => i.label);
  const usable = mandatoryMissing.length === 0;
  const level: KycScore['level'] = completed === 0 ? 'Missing' : completed === total ? 'Complete' : usable ? 'Usable' : 'Incomplete';
  return { items, completed, total, percent, mandatoryMissing, usable, level };
}

/**
 * Derive the legacy scalar columns from the rich profile, so PO snapshots and
 * every existing read path (DocPaper, PDF, sheets sync) keep working.
 */
export function legacyMirror(profile: { contacts: VendorContact[]; bankAccounts: VendorBankAccount[] }) {
  const contact = profile.contacts.find((c) => c.isPrimary) ?? profile.contacts[0];
  const bank = profile.bankAccounts.find((b) => b.isPrimary) ?? profile.bankAccounts[0];
  return {
    ...(contact && {
      contactPerson: contact.name,
      phones: contact.phones.join(', ') || null,
      ...(contact.email && { email: contact.email }),
    }),
    ...(bank && { bankAccount: bank.accountNo, ifsc: bank.ifsc }),
  };
}
