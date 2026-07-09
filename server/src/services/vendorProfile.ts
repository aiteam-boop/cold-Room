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
