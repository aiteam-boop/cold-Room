// ── Read the FMS Accounts sheet's bill-processing STAGES (Option B) ────────────
// After a payment is approved in CRMCTS, the accounts team's own workflow (the
// external NewACCOUNTSFMS sheet) carries it through more stages, each stamped with
// an "Actual" time + a Status:
//   Stage · BILL PROCESSED BY AP (Shivani)   → Actual (col X), Status (col Y)
//   Stage · Bills Approved By Alok Ji         → Actual (col AB)
//   Stage · BILL PAID BY FINANCE (Taraji)     → Actual (col AE), Status (col AF)
// plus an overall "A/C Status" (col U) and the VR No. (col AP).
//
// This reads that sheet READ-ONLY (viewer scope — we never write to it) and, given
// a CRMCTS payment, returns its stage timeline so the app can SHOW where each
// payment stands in Accounts. Match is by AMOUNT + (invoice OR vendor), unique-only
// — exactly like the UTR fetch, so it never attaches the wrong bill.
import { google } from 'googleapis';

const FMS_SHEET_ID = process.env.FMS_SHEET_ID || '1kUNzd5rNMhpSbUMWDovNi-Ayts_lD5HsKMWp-Mbfqq8';
// NewACCOUNTSFMS: multi-row header (stage names rows 2-6, sub-headers row 7), data
// from row 8. 0-based column indexes (verified against the live sheet):
const C = {
  invoice: 4, vendor: 7, amount: 8, amountToPay: 9, utr: 17,
  acStatus: 20,                     // U  · A/C Status (overall)
  apActual: 23, apStatus: 24,       // X/Y · BILL PROCESSED BY AP (Shivani)
  alokActual: 27,                   // AB · Bills Approved By Alok Ji
  finActual: 30, finStatus: 31,     // AE/AF · BILL PAID BY FINANCE (Taraji)
  vrNo: 41,                         // AP · VR NO
};

export interface FmsStageRow {
  vendor: string; amount: number | null; amountToPay: number | null; invoice: string;
  acStatus: string; apActual: string; apStatus: string; alokActual: string;
  finActual: string; finStatus: string; vrNo: string; utr: string;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const toNum = (s: unknown) => { const n = parseFloat(String(s ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const clean = (s: unknown) => String(s ?? '').trim();

let cachedRows: FmsStageRow[] | null = null;
let cachedAt = 0;

/** Read the NewACCOUNTSFMS rows with their stage columns. READ-ONLY. Cached 15 min
 *  (so a busy app never hammers the sheet — at most one read per 15 min per server).
 *  FORMATTED_VALUE so the Actual timestamps come as "dd/mm/yyyy hh:mm:ss" text. */
export async function fetchFmsStageRows(force = false): Promise<FmsStageRow[]> {
  if (!force && cachedRows && Date.now() - cachedAt < 15 * 60 * 1000) return cachedRows;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set — sheet access unavailable.');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: FMS_SHEET_ID, range: 'NewACCOUNTSFMS!A8:AP4107', valueRenderOption: 'FORMATTED_VALUE' });
  const rows = (res.data.values || []).map((r) => ({
    vendor: clean(r[C.vendor]), amount: toNum(r[C.amount]), amountToPay: toNum(r[C.amountToPay]), invoice: clean(r[C.invoice]),
    acStatus: clean(r[C.acStatus]), apActual: clean(r[C.apActual]), apStatus: clean(r[C.apStatus]),
    alokActual: clean(r[C.alokActual]), finActual: clean(r[C.finActual]), finStatus: clean(r[C.finStatus]),
    vrNo: clean(r[C.vrNo]), utr: clean(r[C.utr]),
  })).filter((x) => x.vendor || x.amount != null);
  cachedRows = rows; cachedAt = Date.now();
  return rows;
}

export interface FmsStages {
  acStatus: string;
  ap: { actual: string; status: string } | null;      // BILL PROCESSED BY AP (Shivani)
  alok: { actual: string } | null;                     // Bills Approved By Alok Ji
  finance: { actual: string; status: string } | null;  // BILL PAID BY FINANCE (Taraji)
  vrNo: string; utr: string;
  via: 'INVOICE+AMOUNT' | 'VENDOR+AMOUNT';
  sheetVendor: string; sheetAmount: number | null;
}

/** The single confident stage row for a payment, or null (ambiguous / no match). */
export function matchPaymentStages(
  p: { vendorName?: string | null; invoiceNumber?: string | null; amount: number },
  rows: FmsStageRow[],
): { stages: FmsStages | null; reason: string } {
  if (!(p.amount > 0)) return { stages: null, reason: 'no amount to match on' };
  // ±1 tolerance: a milestone can carry paise (e.g. 3,07,200.5) while the sheet has
  // the rounded rupee (3,07,201) — an exact-0.5 gap must still match. Under 1 rupee so
  // genuinely different amounts (≥1 apart) never merge.
  const amtHit = (row: FmsStageRow) => (row.amount != null && Math.abs(row.amount - p.amount) < 1) || (row.amountToPay != null && Math.abs(row.amountToPay - p.amount) < 1);
  const vendorHit = (row: FmsStageRow) => Boolean(norm(row.vendor) && norm(p.vendorName) && (norm(row.vendor).includes(norm(p.vendorName)) || norm(p.vendorName).includes(norm(row.vendor))));
  const byAmt = rows.filter(amtHit);
  const byInvAmt = p.invoiceNumber ? byAmt.filter((row) => norm(row.invoice) && norm(row.invoice) === norm(p.invoiceNumber)) : [];
  const byVenAmt = byAmt.filter(vendorHit);
  const pick = (row: FmsStageRow, via: FmsStages['via']): FmsStages => ({
    acStatus: row.acStatus,
    ap: (row.apActual || row.apStatus) ? { actual: row.apActual, status: row.apStatus } : null,
    alok: row.alokActual ? { actual: row.alokActual } : null,
    finance: (row.finActual || row.finStatus) ? { actual: row.finActual, status: row.finStatus } : null,
    vrNo: row.vrNo, utr: row.utr, via, sheetVendor: row.vendor, sheetAmount: row.amountToPay ?? row.amount,
  });
  if (byInvAmt.length === 1) return { stages: pick(byInvAmt[0], 'INVOICE+AMOUNT'), reason: 'invoice + amount' };
  if (byVenAmt.length === 1) return { stages: pick(byVenAmt[0], 'VENDOR+AMOUNT'), reason: 'vendor + amount' };
  if (byInvAmt.length > 1) return { stages: null, reason: `invoice + amount matched ${byInvAmt.length} rows` };
  if (byVenAmt.length > 1) return { stages: null, reason: `vendor + amount matched ${byVenAmt.length} rows` };
  return { stages: null, reason: byAmt.length ? `only amount matched (${byAmt.length}, vendor didn't)` : 'no row with this amount' };
}
