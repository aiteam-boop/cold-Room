// Server-side financial masking. When a USER has the "Hide pricing & financial
// data" section permission, every ₹ amount must be stripped from the API
// payload itself — not just hidden in the UI — so the data is blocked through
// APIs, direct links and browser inspection too.

import type { Account } from './permissions';
import { shouldHideFinancials } from './permissions';

// Monetary field names used across procurement / vendors / approvals.
const MONEY_FIELDS = new Set([
  'basicAmount', 'finalAmount', 'gstAmount',
  'unitPrice', 'totalPrice', 'inrAmount', 'invoiceValue',
  'totalValue', 'totalWithGst',
  'amountInvoiced', 'amountAdvanced', 'amountPaid', 'amountPending',
  'totalPO', 'totalWO', 'totalInvoiced', 'totalPaid', 'totalPending',
  // BOQ Cost view (Sprint PRD §6): site engineers see quantities, never prices.
  'totalCost', 'advancePaid', 'balancePending',
  'totalOrderedCost', 'totalAdvancePaid', 'totalBalancePending',
  'grandTotalCost', 'grandAdvancePaid', 'grandBalancePending',
  // Vendor rate chart (Sprint PRD §5.1.5).
  'rate',
]);

// Deep-clone, replacing any known monetary field's value with null. Arrays and
// nested objects are walked. Non-money fields (percentages, counts, dates,
// statuses) are preserved so the page still renders — only the rupee values go.
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = MONEY_FIELDS.has(k) ? null : scrub(v);
    }
    return out;
  }
  return value;
}

// Returns the payload unchanged for users who may see money (incl. ADMIN), or a
// scrubbed copy when the account has hideFinancials.
export function maskFinancials<T>(data: T, acc: Account | undefined | null): T {
  if (!shouldHideFinancials(acc)) return data;
  return scrub(data) as T;
}
