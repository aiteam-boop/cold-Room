// ── Fetch UTR numbers from the external Accounts/FMS Google Sheet ──────────────
// Old POs (approved before the in-app payment flow existed) were paid through the
// company's Accounts sheet, which records each bill's Voucher/VR No. and its bank
// UTR. This reads that sheet READ-ONLY (viewer scope — we never write to it) and
// matches each CRMCTS payment to its row so the UTR can show in the pipeline.
//
// Match is by AMOUNT + (invoice OR vendor) — invoice/amount pins the exact
// installment of a split bill; vendor/amount covers rows with no invoice. A match
// is only "confident" when it is unique; anything ambiguous is reported, never
// auto-applied ("correct hona chahiye").
import { google } from 'googleapis';

// The FMS workbook (separate from the app's own SPREADSHEET_ID). Override via env.
const FMS_SHEET_ID = process.env.FMS_SHEET_ID || '1kUNzd5rNMhpSbUMWDovNi-Ayts_lD5HsKMWp-Mbfqq8';
// NewACCOUNTSFMS: headers on row 6, data from row 7. Column indexes:
const COL = { voucher: 0, invoice: 4, vendor: 7, amount: 8, amountToPay: 9, status: 16, utr: 17, vrNo: 41 };

export interface UtrRow { voucher: string; invoice: string; vendor: string; amount: number | null; amountToPay: number | null; status: string; utr: string; vrNo: string }

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const toNum = (s: unknown) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const clean = (s: unknown) => String(s ?? '').trim();

let cachedRows: UtrRow[] | null = null;
let cachedAt = 0;

/** Read NewACCOUNTSFMS rows that carry a UTR. READ-ONLY. Cached 5 min (quota). */
export async function fetchUtrRows(force = false): Promise<UtrRow[]> {
  if (!force && cachedRows && Date.now() - cachedAt < 5 * 60 * 1000) return cachedRows;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set — sheet access unavailable.');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: FMS_SHEET_ID, range: 'NewACCOUNTSFMS!A7:AP4107', valueRenderOption: 'UNFORMATTED_VALUE' });
  const rows = (res.data.values || []).map((r) => ({
    voucher: clean(r[COL.voucher]), invoice: clean(r[COL.invoice]), vendor: clean(r[COL.vendor]),
    amount: toNum(r[COL.amount]), amountToPay: toNum(r[COL.amountToPay]), status: clean(r[COL.status]),
    utr: clean(r[COL.utr]), vrNo: clean(r[COL.vrNo]),
  })).filter((x) => x.utr);
  cachedRows = rows; cachedAt = Date.now();
  return rows;
}

export interface UtrMatch {
  utr: string; vrNo: string; via: 'INVOICE+AMOUNT' | 'VENDOR+AMOUNT';
  sheetVendor: string; sheetInvoice: string; sheetAmount: number | null;
}

/** Find the single confident UTR row for a payment, or null (with a reason). */
export function matchPaymentUtr(
  p: { vendorName?: string | null; invoiceNumber?: string | null; amount: number },
  rows: UtrRow[],
): { match: UtrMatch | null; reason: string; candidates: UtrRow[] } {
  if (!(p.amount > 0)) return { match: null, reason: 'no amount to match on', candidates: [] };
  const amtHit = (row: UtrRow) => (row.amount != null && Math.abs(row.amount - p.amount) < 0.5) || (row.amountToPay != null && Math.abs(row.amountToPay - p.amount) < 0.5);
  const vendorHit = (row: UtrRow) => Boolean(norm(row.vendor) && norm(p.vendorName) && (norm(row.vendor).includes(norm(p.vendorName)) || norm(p.vendorName).includes(norm(row.vendor))));
  const byAmt = rows.filter(amtHit);
  const byInvAmt = p.invoiceNumber ? byAmt.filter((row) => norm(row.invoice) && norm(row.invoice) === norm(p.invoiceNumber)) : [];
  const byVenAmt = byAmt.filter(vendorHit);
  // sheetAmount = the amount actually PAID for this UTR (amountToPay), not the full
  // invoice value (`amount`) which repeats across a bill's installment rows.
  const pack = (row: UtrRow, via: UtrMatch['via']): UtrMatch => ({ utr: clean(row.utr), vrNo: row.vrNo || row.voucher, via, sheetVendor: row.vendor, sheetInvoice: row.invoice, sheetAmount: row.amountToPay ?? row.amount });
  if (byInvAmt.length === 1) return { match: pack(byInvAmt[0], 'INVOICE+AMOUNT'), reason: 'invoice + amount', candidates: byInvAmt };
  if (byVenAmt.length === 1) return { match: pack(byVenAmt[0], 'VENDOR+AMOUNT'), reason: 'vendor + amount', candidates: byVenAmt };
  if (byInvAmt.length > 1) return { match: null, reason: `invoice + amount matched ${byInvAmt.length} rows`, candidates: byInvAmt };
  if (byVenAmt.length > 1) return { match: null, reason: `vendor + amount matched ${byVenAmt.length} rows`, candidates: byVenAmt };
  if (byAmt.length) return { match: null, reason: `only amount matched (${byAmt.length}, vendor didn't) — verify manually`, candidates: byAmt };
  return { match: null, reason: 'no row with this amount', candidates: [] };
}

// For an APPROVED PO/WO (which has no in-app payment record because it was paid via
// the Accounts form): find every sheet row that matches the doc's vendor AND one of
// its amounts (final / basic / any PI value). Returns the de-duplicated UTR rows —
// a single PO may have several (advance / running / balance installments).
export function matchDocUtrs(
  d: { vendorName?: string | null; basicAmount?: number | null; finalAmount?: number | null; piValues?: number[] },
  rows: UtrRow[],
): { utrs: UtrMatch[]; vendorInSheet: number } {
  const amts = [d.finalAmount, d.basicAmount, ...(d.piValues || [])].filter((n): n is number => typeof n === 'number' && n > 0);
  const vendorHit = (row: UtrRow) => Boolean(norm(row.vendor) && norm(d.vendorName) && (norm(row.vendor).includes(norm(d.vendorName)) || norm(d.vendorName).includes(norm(row.vendor))));
  // ±1.5 tolerance absorbs GST rounding (a PO's rounded final vs the paise-exact sheet amount).
  const amtHit = (row: UtrRow) => amts.some((a) => (row.amount != null && Math.abs(row.amount - a) < 1.5) || (row.amountToPay != null && Math.abs(row.amountToPay - a) < 1.5));
  const vendorRows = rows.filter(vendorHit);
  const seen = new Set<string>();
  const utrs: UtrMatch[] = [];
  for (const row of vendorRows.filter(amtHit)) {
    const key = clean(row.utr) + '|' + row.vrNo;
    if (seen.has(key)) continue;
    seen.add(key);
    utrs.push({ utr: clean(row.utr), vrNo: row.vrNo || row.voucher, via: 'VENDOR+AMOUNT', sheetVendor: row.vendor, sheetInvoice: row.invoice, sheetAmount: row.amountToPay ?? row.amount });
  }
  return { utrs, vendorInSheet: vendorRows.length };
}
