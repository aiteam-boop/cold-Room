// Google Sheets sync for CRMCTS.
// One tab per Mongo collection. Column "id" (the Mongo _id) is always first so
// rows can be matched back for Sheet -> DB import (two-way sync).
//
// Requires env: GOOGLE_SERVICE_ACCOUNT_JSON (unquoted single-line JSON) and
// SPREADSHEET_ID. If either is missing, sync is treated as disabled (no-ops).

import { google, sheets_v4 } from 'googleapis';
import { MongoClient, Db } from 'mongodb';
import { randomUUID } from 'crypto';
import { signApiPath } from '../lib/signedUrl';

// ── Entity → tab config ─────────────────────────────────────────────────────
// `collection` is the MongoDB collection name (same as the Prisma model name).
// `fields` are the scalar columns to mirror (relations excluded). `id` first.
// Sensitive fields (e.g. User.passwordHash) are intentionally omitted.
//
// Reads go through the native MongoDB driver (not Prisma) — its TLS is reliable
// on all tested networks, whereas Prisma's query engine intermittently fails
// the Atlas TLS handshake here. Documents store `_id` plus the schema field
// names verbatim (only `id` is @map'd to `_id`), so field access is 1:1.

export type EntityConfig = {
  tab: string;
  collection: string;
  fields: string[];
};

export const ENTITIES: EntityConfig[] = [
  {
    tab: 'Users',
    collection: 'User',
    // passwordHash deliberately NOT exported.
    fields: ['id', 'name', 'email', 'role', 'active', 'whatsapp', 'pageAccess', 'sectionPerms', 'twoFactor', 'createdAt'],
  },
  {
    tab: 'Projects',
    collection: 'Project',
    fields: ['id', 'name', 'clientName', 'siteLocation', 'startDate', 'targetCompletionDate', 'status', 'boqLocked', 'boqLockedAt', 'createdById', 'boqAnalyzedAt', 'createdAt', 'updatedAt'],
  },
  {
    tab: 'ProjectMembers',
    collection: 'ProjectMember',
    fields: ['id', 'projectId', 'userId', 'role', 'createdAt'],
  },
  {
    tab: 'BOQItems',
    collection: 'BOQItem',
    fields: ['id', 'projectId', 'srNo', 'description', 'category', 'roomZone', 'unit', 'plannedQty', 'parentId', 'isGroup', 'sortOrder', 'zoneId', 'lockedAt', 'createdAt'],
  },
  {
    tab: 'BOQAnalysis',
    collection: 'BOQAnalysisItem',
    fields: ['id', 'projectId', 'srNo', 'itemName', 'category', 'quantity', 'unit', 'specifications', 'requirements', 'dependencies', 'notes', 'boqItemId', 'sortOrder', 'createdAt'],
  },
  {
    tab: 'ProgressEntries',
    collection: 'ProgressEntry',
    fields: ['id', 'projectId', 'boqItemId', 'submittedById', 'approvedById', 'date', 'quantityInstalled', 'unit', 'photoUrl', 'remarks', 'status', 'approvedAt', 'rejectionReason', 'voidReason', 'createdAt'],
  },
  {
    tab: 'Vendors',
    collection: 'Vendor',
    fields: ['id', 'name', 'type', 'contactPerson', 'phones', 'address', 'email', 'gstin', 'pan', 'bankAccount', 'ifsc', 'createdById', 'createdAt'],
  },
  {
    tab: 'VendorSiteMappings',
    collection: 'VendorSiteMapping',
    fields: ['id', 'vendorId', 'projectId', 'createdAt'],
  },
  {
    tab: 'ProcurementDocs',
    collection: 'ProcurementDoc',
    fields: ['id', 'projectId', 'type', 'docNumber', 'status', 'vendorId', 'vendorName', 'vendorAddress', 'vendorGstin', 'vendorContact', 'vendorPhone', 'docDate', 'againstQuotation', 'invoiceTo', 'shipTo', 'siteAddress', 'basicAmount', 'gstEnabled', 'gstPct', 'gstAmount', 'finalAmount', 'overrides', 'payAdvancePct', 'payBeforeDeliveryPct', 'payRunningPct', 'payPostDeliveryPct', 'payPostCompletionPct', 'payRetentionPct', 'payTriggers', 'termsSections', 'createdById', 'approvedById', 'approvedAt', 'rejectionReason', 'esignApplied', 'lockedAt', 'pdfUrl', 'createdAt', 'updatedAt'],
  },
  {
    tab: 'ProcurementLineItems',
    collection: 'ProcurementLineItem',
    fields: ['id', 'docId', 'srNo', 'description', 'uom', 'qty', 'unitPrice', 'totalPrice', 'isLeadTime', 'leadTimeText', 'sortOrder'],
  },
  {
    tab: 'PaymentMilestones',
    collection: 'PaymentMilestone',
    fields: ['id', 'docId', 'fieldKey', 'name', 'triggerCondition', 'percentage', 'inrAmount', 'expectedDate', 'actualTriggerDate', 'status', 'accountsNotifiedAt', 'paymentDate', 'paymentReference', 'remarks', 'sortOrder'],
  },
  {
    tab: 'GRNs',
    collection: 'GRN',
    fields: ['id', 'projectId', 'docId', 'grnNumber', 'grnDate', 'vendorName', 'siteAddress', 'raisedById', 'vehicleNumber', 'driverName', 'deliveryChallanNumber', 'invoiceNumber', 'invoiceDate', 'invoiceValue', 'invoicePdfUrl', 'ewayBillNumber', 'packingListUrl', 'status', 'approvedById', 'approvedAt', 'rejectionReason', 'pdfUrl', 'createdAt'],
  },
  {
    tab: 'GRNLineItems',
    collection: 'GRNLineItem',
    fields: ['id', 'grnId', 'lineItemId', 'srNo', 'description', 'uom', 'poQty', 'previouslyReceivedQty', 'receiptQty', 'defectQty', 'acceptedQty', 'remarks'],
  },
  {
    tab: 'ProcurementDocuments',
    collection: 'ProcurementDocument',
    fields: ['id', 'projectId', 'type', 'fileName', 'fileUrl', 'mimeType', 'linkedDocNumber', 'vendorId', 'vendorName', 'uploadedById', 'uploadedAt', 'archived', 'archiveReason'],
  },
  {
    tab: 'Drawings',
    collection: 'Drawing',
    fields: ['id', 'projectId', 'fileName', 'fileUrl', 'mimeType', 'fileSize', 'uploadedById', 'version', 'status', 'extractedZones', 'classification', 'uploadedAt'],
  },
  {
    tab: 'ProjectZones',
    collection: 'ProjectZone',
    fields: ['id', 'projectId', 'drawingId', 'zoneName', 'boqCategory', 'roomType', 'coordinates', 'heightM', 'sortOrder', 'createdAt'],
  },
  {
    tab: 'Notifications',
    collection: 'Notification',
    fields: ['id', 'userId', 'type', 'title', 'message', 'projectId', 'relatedDocType', 'relatedDocId', 'link', 'isRead', 'createdAt'],
  },
  {
    tab: 'AuditLogs',
    collection: 'AuditLog',
    fields: ['id', 'projectId', 'userId', 'action', 'entity', 'entityId', 'details', 'createdAt'],
  },
];

// ── Mongo client (native driver — reliable TLS) ─────────────────────────────

let cachedMongo: MongoClient | null = null;

async function getDb(): Promise<Db> {
  if (!cachedMongo) {
    const uri = process.env.DATABASE_URL;
    if (!uri) throw new Error('DATABASE_URL is not set');
    cachedMongo = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
    await cachedMongo.connect();
  }
  // DB name is taken from the connection string (…/crmcts).
  return cachedMongo.db();
}

export async function closeMongo(): Promise<void> {
  if (cachedMongo) {
    await cachedMongo.close();
    cachedMongo = null;
  }
}

// ── Sheets client ───────────────────────────────────────────────────────────

let cachedSheets: sheets_v4.Sheets | null = null;

export function sheetsEnabled(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.SPREADSHEET_ID);
}

export function getSpreadsheetId(): string {
  const id = process.env.SPREADSHEET_ID;
  if (!id) throw new Error('SPREADSHEET_ID is not set');
  return id;
}

export function getSheetsClient(): sheets_v4.Sheets {
  if (cachedSheets) return cachedSheets;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  cachedSheets = google.sheets({ version: 'v4', auth });
  return cachedSheets;
}

// ── Value formatting ────────────────────────────────────────────────────────

function toCell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  // objects/arrays (shouldn't occur for scalars, but be safe)
  return JSON.stringify(v);
}

// ── Tab management ──────────────────────────────────────────────────────────

async function ensureTabs(tabNames: string[]): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = new Set((meta.data.sheets || []).map((s) => s.properties?.title));
  const missing = tabNames.filter((t) => !existing.has(t));
  if (missing.length === 0) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    },
  });
}

/** Overwrite a tab with headers + rows (clears old content first). */
async function writeTab(tab: string, headers: string[], rows: (string | number | boolean)[][]): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${tab}` });
  const values = [headers, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/**
 * Format a tab's Timestamp column (A, from row 2 down) as a DATE_TIME value so
 * its serial-number cells render as dd/mm/yyyy hh:mm:ss AND open the calendar
 * date-picker on click — matching the external ADMIN sheet. Number formats
 * survive value overwrites, but we (re)apply it every export so a freshly
 * (re)created tab always gets it. Never throws into the export path.
 */
async function formatTimestampColumn(tab: string): Promise<void> {
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = getSpreadsheetId();
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' });
    const sheetId = (meta.data.sheets || []).find((s) => s.properties?.title === tab)?.properties?.sheetId;
    if (sheetId == null) return;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, // col A, rows 2..end
            cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm:ss' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        }],
      },
    });
  } catch (err) {
    console.error('[sheetsSync] formatTimestampColumn failed:', (err as Error).message);
  }
}

// ── Export (Mongo -> Sheet) ─────────────────────────────────────────────────

export type ExportResult = { tab: string; rows: number }[];

// Base URL for turning stored file paths (e.g. "/uploads/xyz.pdf") into full,
// clickable links in the sheet. Set APP_URL to your public domain
// (e.g. https://coldroom.crystalgrp.xyz) for the links to open.
//
// The sheet is the SHARED (production) workbook, so a link is worthless if it points
// at localhost — yet a sync run from a dev machine has APP_URL=http://localhost:4100.
// So we NEVER emit a localhost link into the sheet: if the resolved base is empty or
// a localhost/127.0.0.1 URL, fall back to the production domain. Override with
// SHEET_LINK_BASE if the domain ever changes.
const PROD_LINK_BASE = 'https://coldroom.crystalgrp.xyz';
function fileBaseUrl(): string {
  const configured = (process.env.SHEET_LINK_BASE || process.env.APP_URL || (process.env.CLIENT_ORIGIN || '').split(',')[0] || '').replace(/\/$/, '');
  if (!configured || /localhost|127\.0\.0\.1/i.test(configured)) return PROD_LINK_BASE;
  return configured;
}

/** Export one entity by tab name. Reads via the native MongoDB driver. Any
 *  column whose name ends in "Url"/"url" is emitted as an absolute link. */
export async function exportEntity(cfg: EntityConfig): Promise<number> {
  const db = await getDb();
  const base = fileBaseUrl();
  const records = await db.collection(cfg.collection).find({}).toArray();
  const rows = records.map((r) =>
    cfg.fields.map((f) => {
      const raw = f === 'id' ? r._id : (r as Record<string, unknown>)[f];
      if (base && /url$/i.test(f) && typeof raw === 'string' && raw.startsWith('/')) {
        // API links (server-rendered PDFs) require auth, but a link clicked from
        // the sheet can't send a bearer token — so sign them so they open. Static
        // /uploads/* files are already public and need no signature.
        const link = raw.startsWith('/api/') ? signApiPath(raw) : raw;
        return `${base}${link}`;
      }
      return toCell(raw);
    }),
  );
  await writeTab(cfg.tab, cfg.fields, rows);
  return rows.length;
}

// ── "payment Account FMS" — the accounts-facing payment pipeline ─────────────
// One row per PO. Columns A→O mirror the group's A/C FMS "ADMIN" sheet EXACTLY
// (same headers, same order, same dd/MM/yyyy formats) so the row can flow
// straight into it; everything Cold-Room-specific is added from P onwards.
// A PO with several GRNs still occupies ONE row — the per-GRN values stack
// inside the cell, one under the other, PDFs included.

export const FMS_TAB = 'payment Account FMS';
/** A→O: byte-for-byte the ADMIN sheet's headers. Do not reorder or rename. */
const FMS_ADMIN_HEADERS = [
  'Timestamp', 'Email address', 'User', 'Invoice Number', 'Invoice Date',
  'Bill received by User', 'Vendor Name', 'Full Amount', 'Amount To Pay',
  'Payment Due Date', 'Payment Type', 'Payment Terms', 'Invoice with Supporting',
  'PI', 'Department',
];
/** P onwards: the Cold Room detail the accounts sheet doesn't carry.
 * 'Milestone Ref' (last column) is the stable key used by the reverse sync to map
 * a sheet row back to its payment milestone — Accounts must not edit it. */
const FMS_EXTRA_HEADERS = [
  'Project', 'PO Number', 'PO PDF', 'GRN Number', 'GRN PDF', 'Invoiced', 'Paid',
  'Payment Status', 'UTR / Payment Ref', 'Payment Remark', 'PO Status', 'Vendor KYC', 'Milestone Ref',
  // Vendor email + the no-login "Approval Form" link (management marks the payment
  // Approved / On Hold) and the resulting Approval Status.
  'Vendor Email', 'Approval Status', 'Approval Form',
  // Ledger Head — free-text remark the raiser types on the Payment. Placed AFTER
  // "Approval Form" and BEFORE "VR No." (column AF), matching the column inserted
  // in the sheet. VR No. moves to AG and stays PRESERVED, so the accounts UTR/VR
  // array-formulas (which reference the VR column) are unaffected.
  'Ledger Head',
  // VR No. — like "UTR / Payment Ref", the accounts team fills this with their own
  // fetch-from-sheet formula, so our export PRESERVES this column (never overwrites).
  'VR No.',
];

const dmy = (d: unknown): string => {
  const dt = d instanceof Date ? d : d ? new Date(String(d)) : null;
  if (!dt || Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};
// Timestamp column (A) on the accounts sheet — written as a real Google Sheets
// datetime *value* (a serial number), not text, so clicking the cell opens the
// calendar date-picker exactly like the external ADMIN sheet, while the DATE_TIME
// number format on the column (see formatTimestampColumn) still displays it as
// dd/mm/yyyy hh:mm:ss. The serial is built from the India-time (Asia/Kolkata)
// wall-clock so it reads correctly and consistently regardless of the server's
// timezone (the VPS runs UTC; getHours()/getDate() would be 5.5h off and would
// flip whenever a differently-zoned machine ran the sync). RAW keeps it numeric.
const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
// Days between the Sheets/Excel epoch (1899-12-30) and the Unix epoch (1970-01-01).
const SHEETS_EPOCH_OFFSET = 25569;
const istSerial = (d: unknown): number | '' => {
  const dt = d instanceof Date ? d : d ? new Date(String(d)) : null;
  if (!dt || Number.isNaN(dt.getTime())) return '';
  const p: Record<string, string> = {};
  for (const part of IST_PARTS.formatToParts(dt)) p[part.type] = part.value;
  // Sheets serials carry no timezone, so treat the IST wall-clock components as a
  // naive UTC instant: the cell then displays exactly the India-time clock.
  const naiveUtcMs = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return naiveUtcMs / 86400000 + SHEETS_EPOCH_OFFSET;
};
/** Absolute, click-from-the-sheet URL. /api/* PDFs are signed; /uploads/* are public. */
function fileUrl(raw: unknown, base: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '';
  return base + (raw.startsWith('/api/') ? signApiPath(raw) : raw);
}

// ── Reverse sync: sheet → pipeline ───────────────────────────────────────────
// Accounts records a payment by putting the UTR (and optional remark) against a
// row in the 'payment Account FMS' tab (fed from their own a/c sheet). This reads
// those back and marks the matching milestone PAID in the Payment Pipeline — the
// same effect as clicking "Mark Paid" in the app. It is deliberately one-way and
// safe: it ONLY promotes a TRIGGERED milestone to PAID, never un-pays or edits an
// already-paid one, and matches on the hidden 'Milestone Ref' key so it can't hit
// the wrong payment. Runs before every export so an overwrite never drops a UTR.
export async function importPaidFromSheet(): Promise<number> {
  if (!sheetsEnabled()) return 0;
  let vals: string[][] = [];
  try {
    const resp = await getSheetsClient().spreadsheets.values.get({
      spreadsheetId: getSpreadsheetId(),
      // Read wide enough to always include the last columns (UTR/Remark/Milestone
      // Ref) even as columns are added — matching is by header name, not position.
      range: `${FMS_TAB}!A1:AH2000`,
    });
    vals = (resp.data.values as string[][]) || [];
  } catch { return 0; } // tab missing / not yet created → nothing to import
  if (vals.length < 2) return 0;

  const H = vals[0];
  const iRef = H.indexOf('Milestone Ref');
  const iUtr = H.indexOf('UTR / Payment Ref');
  const iRemark = H.indexOf('Payment Remark');
  if (iRef < 0 || iUtr < 0) return 0;

  const db = await getDb();
  // These collections use string (cuid) _ids, not ObjectId — cast filters to any.
  const milestones = db.collection('PaymentMilestone');
  const docsCol = db.collection('ProcurementDoc');
  const audit = db.collection('AuditLog');
  let paid = 0;
  for (const row of vals.slice(1)) {
    const ref = (row[iRef] || '').trim();
    const utr = (row[iUtr] || '').trim();
    // Never import a spreadsheet ERROR or a still-computing formula as a UTR — a
    // broken FMS "fetch UTR" formula shows #REF!/#N/A/Loading…, which is NOT a
    // payment reference. Importing it once wrote "#REF!" onto a paid milestone.
    if (!ref || !utr || utr === '—' || /^#(REF|N\/A|VALUE|ERROR|NAME|DIV|NULL|NUM|GETTING_DATA)/i.test(utr) || /^Loading/i.test(utr)) continue;
    const m = await milestones.findOne({ _id: ref } as never);
    if (!m) continue;
    // Only promote a triggered-but-unpaid milestone; never touch PAID/PENDING.
    if (m.status !== 'TRIGGERED') continue;
    if (m.utrNumber === utr) continue; // already recorded — idempotent
    const remark = iRemark >= 0 ? (row[iRemark] || '').trim() : '';
    const paidAt = new Date();
    // A sheet UTR settles the whole term. Keep amountPaid in step (source of truth
    // for the cost rollups) and log the balance as a part-payment installment.
    const already = typeof m.amountPaid === 'number' && m.amountPaid > 0 ? m.amountPaid : 0;
    const delta = Math.round(((m.inrAmount || 0) - already) * 100) / 100;
    await milestones.updateOne(
      { _id: m._id } as never,
      { $set: { status: 'PAID', amountPaid: m.inrAmount || 0, utrNumber: utr, paymentReference: utr, remarks: remark || m.remarks || null, paymentDate: paidAt } },
    );
    if (delta > 0) {
      await db.collection('PaymentInstallment').insertOne({
        _id: randomUUID(), milestoneId: String(m._id), docId: m.docId, amount: delta,
        utrNumber: utr, paymentReference: utr, paymentDate: paidAt, remarks: remark || null,
        paidById: null, createdAt: paidAt,
      } as never);
    }
    const doc = await docsCol.findOne({ _id: m.docId } as never, { projection: { projectId: 1 } });
    await audit.insertOne({
      _id: randomUUID(), projectId: (doc?.projectId as string) ?? null, userId: null,
      action: 'MILESTONE_PAY_SHEET', entity: 'PaymentMilestone', entityId: String(m._id),
      details: JSON.stringify({ utrNumber: utr, remark, source: 'accounts-sheet' }), createdAt: new Date(),
    } as never);
    paid++;
  }
  return paid;
}

/** 0-based column index → A1 column letter (0→A, 25→Z, 26→AA). */
function colLetter(i: number): string {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Like writeTab, but LEAVES the DATA cells of one-or-more columns untouched. Used
 * for the FMS tab's "UTR / Payment Ref" and "VR No." columns, where the accounts
 * team keeps their OWN fetch-from-sheet formulas — our full-tab overwrite must
 * never wipe them. Each preserved column's HEADER (row 1) is still (re)written so
 * the reverse-sync can find it by name; only the data cells below are preserved.
 * Everything else is cleared and rewritten exactly as writeTab does.
 */
async function writeTabPreservingCols(tab: string, headers: string[], rows: (string | number | boolean)[][], skipCols: number[]): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  const values = [headers, ...rows];
  const skip = new Set(skipCols);
  const nCols = Math.max(headers.length, ...skipCols.map((c) => c + 1));
  // Contiguous runs of NON-preserved columns → the blocks we clear + rewrite.
  const segments: { start: number; end: number }[] = [];
  let segStart = -1;
  for (let c = 0; c < nCols; c++) {
    if (skip.has(c)) { if (segStart >= 0) { segments.push({ start: segStart, end: c - 1 }); segStart = -1; } }
    else if (segStart < 0) segStart = c;
  }
  if (segStart >= 0) segments.push({ start: segStart, end: nCols - 1 });
  // Clear each non-preserved block (all rows) so stale rows go — never the preserved columns.
  await sheets.spreadsheets.values.batchClear({ spreadsheetId, requestBody: { ranges: segments.map((s) => `${tab}!${colLetter(s.start)}1:${colLetter(s.end)}`) } });
  // Write each block's data, plus each preserved column's HEADER only (row 1).
  const data: { range: string; values: (string | number | boolean)[][] }[] = [];
  for (const s of segments) data.push({ range: `${tab}!${colLetter(s.start)}1`, values: values.map((r) => r.slice(s.start, s.end + 1)) });
  for (const c of skipCols) data.push({ range: `${tab}!${colLetter(c)}1`, values: [[headers[c] ?? '']] });
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data } });
}

export async function exportPaymentAccountFms(): Promise<number> {
  // Consume any UTRs Accounts entered before we overwrite the tab.
  try { await importPaidFromSheet(); } catch { /* import is best-effort */ }
  const db = await getDb();
  const base = fileBaseUrl();
  const [docs, grns, projects, users, milestones, kycs, vendors] = await Promise.all([
    db.collection('ProcurementDoc').find({ type: { $in: ['PO', 'WO'] } }).sort({ createdAt: 1 }).toArray(),
    db.collection('GRN').find({}).sort({ createdAt: 1 }).toArray(),
    db.collection('Project').find({}).project({ name: 1 }).toArray(),
    db.collection('User').find({}).project({ name: 1, email: 1 }).toArray(),
    db.collection('PaymentMilestone').find({}).toArray(),
    // Every vendor KYC document on file — Accounts needs these attached to each payment.
    db.collection('ProcurementDocument').find({ type: 'KYC' }).toArray(),
    // Vendor emails for the FMS "Vendor Email" column.
    db.collection('Vendor').find({}).project({ email: 1 }).toArray(),
  ]);
  const grnsCol = db.collection('GRN');
  const vendorEmailById = new Map(vendors.map((v) => [String(v._id), (v.email as string) || '']));
  const projName = new Map(projects.map((p) => [String(p._id), p.name as string]));
  const userById = new Map(users.map((u) => [String(u._id), u as { name: string; email: string }]));
  const grnsByDoc = new Map<string, Record<string, unknown>[]>();
  for (const g of grns) {
    const k = String(g.docId);
    (grnsByDoc.get(k) ?? grnsByDoc.set(k, []).get(k)!).push(g);
  }
  const msByDoc = new Map<string, Record<string, unknown>[]>();
  for (const m of milestones) {
    const k = String(m.docId);
    (msByDoc.get(k) ?? msByDoc.set(k, []).get(k)!).push(m);
  }
  // Vendor KYC docs grouped by vendor, so every row for that vendor carries the
  // full set of KYC PDF links (PAN, cancelled cheque, GST certificate, …).
  const kycByVendor = new Map<string, Record<string, unknown>[]>();
  for (const k of kycs) {
    if (!k.vendorId) continue;
    const key = String(k.vendorId);
    (kycByVendor.get(key) ?? kycByVendor.set(key, []).get(key)!).push(k);
  }
  const kycCellFor = (vendorId: unknown): string => {
    const list = vendorId ? kycByVendor.get(String(vendorId)) ?? [] : [];
    // Single clickable link to a page listing every KYC doc. Google Sheets makes a
    // lone URL clickable; the old multi-line "LABEL: url" text was not (had to be
    // copy-pasted). The page opens without login via the path's signature.
    return list.length ? fileUrl(`/api/vendors/${vendorId}/kyc-view`, base) : '';
  };

  const rows: (string | number)[][] = [];
  for (const d of docs) {
    const id = String(d._id);
    const ms = msByDoc.get(id) ?? [];
    // A PO enters this (accounts) sheet ONLY once a payment is actually due —
    // i.e. at least one milestone has been TRIGGERED ("Mark Triggered") or PAID.
    // A PO whose milestones are all still PENDING is not yet an accounts item.
    const inPipeline = ms.some((m) => m.status === 'TRIGGERED' || m.status === 'PAID');
    if (!inPipeline) continue;
    // Show ONLY approved GRNs — a DRAFT / pending GRN (and its PI/invoice) isn't final.
    const gs = (grnsByDoc.get(id) ?? []).filter((g) => g.status === 'APPROVED');
    const creator = d.createdById ? userById.get(String(d.createdById)) : undefined;
    const kycCell = kycCellFor(d.vendorId);

    // ONE ROW PER GRN: when a PO has several GRNs (one per payment-term milestone),
    // each GRN gets its own row — its own invoice, PI, GRN PDF, and the UTR/remark
    // of the milestone it belongs to. In addition, any TRIGGERED/PAID milestone
    // that has no GRN of its own (e.g. an advance paid without an invoice) gets a
    // row too, so no payment/UTR is ever lost from the accounts sheet.
    const milestoneOf = (g: Record<string, unknown>) =>
      g.milestoneId ? ms.find((x) => String(x._id) === String(g.milestoneId)) ?? null : null;

    const makeRow = (g: Record<string, unknown> | null, m: Record<string, unknown> | null): (string | number)[] => {
      const paidAmt = m && m.status === 'PAID' ? Number(m.inrAmount) || 0 : 0;
      const utr = m ? (m.utrNumber || m.paymentReference || '') as string : '';
      const remark = m ? (m.remarks || '') as string : '';
      const term = m ? `${m.name}${m.percentage ? ` ${m.percentage}%` : ''}` : '';
      const amountToPay = g?.amountToPay ?? (m ? Number(m.inrAmount) || '' : '');
      // A Timestamp = when THIS payment term was TRIGGERED (raised for payment), so
      // each row carries its own trigger date — the FMS team uses it as a unique
      // per-row key. Falls back to the payment date, then the PO/WO creation date,
      // so the cell is never blank (e.g. a term paid via the sheet with no trigger).
      const triggerTs = m?.actualTriggerDate || m?.paymentDate || d.createdAt;
      return [
        istSerial(triggerTs),                                   // A Timestamp (this term's trigger date; real datetime → date-picker; DATE_TIME format below)
        creator?.email ?? '',                                    // B Email address
        creator?.name ?? '',                                     // C User
        (g?.invoiceNumber ?? '') as string,                      // D Invoice Number
        dmy(g?.invoiceDate),                                     // E Invoice Date
        dmy(g?.piDate),                                          // F Bill received by User = PI date
        d.vendorName ?? '',                                      // G Vendor Name
        Number(d.finalAmount) || 0,                              // H Full Amount (PO total)
        amountToPay as string | number,                          // I Amount To Pay
        dmy(g?.paymentDueDate),                                  // J Payment Due Date
        (g?.milestoneName || m?.name || 'Full Payment') as string, // K Payment Type
        term,                                                    // L Payment Terms (milestone)
        fileUrl(g?.invoicePdfUrl, base),                         // M Invoice with Supporting
        fileUrl(g?.piPdfUrl, base),                              // N PI
        'Coldroom',                                              // O Department
        // ── P onwards: Cold Room detail ──
        projName.get(String(d.projectId)) ?? '',                 // P Project
        d.docNumber ?? '',                                       // Q PO Number
        fileUrl(`/api/projects/${d.projectId}/procurement/docs/${id}/pdf`, base) + '&approvals=1', // R PO PDF (with approval trail — Accounts needs the signed copy)
        (g?.grnNumber ?? '') as string,                          // S GRN Number
        g ? fileUrl(`/api/projects/${g.projectId}/procurement/grns/${String(g._id)}/pdf`, base) : '', // T GRN PDF
        Number(g?.invoiceValue) || 0,                            // U Invoiced (this GRN)
        paidAmt,                                                  // V Paid (this milestone)
        // Payment Status: PAID / TRIGGERED / PENDING (empty for an invoice with
        // no milestone yet) — so Accounts sees at a glance what is still due.
        m ? String(m.status) : '',                               // W Payment Status
        utr,                                                     // X UTR / Payment Ref (this milestone)
        remark,                                                  // Y Payment Remark (this milestone)
        d.status ?? '',                                          // Z PO Status
        kycCell,                                                 // AA Vendor KYC (all docs)
        m ? String(m._id) : '',                                  // AB Milestone Ref (reverse-sync key)
        vendorEmailById.get(String(d.vendorId)) ?? '',           // AC Vendor Email
        // AD Approval Status — the management release decision (empty for milestone-
        // only rows that have no GRN/payment yet).
        g ? (g.releaseStatus === 'APPROVED' ? 'Approved' : g.releaseStatus === 'ON_HOLD' ? 'On Hold' : g.releaseStatus === 'RESUBMITTED' ? 'Re-submitted' : 'Pending') : '',
        // AE Approval Form — the no-login link management opens to Approve / On-Hold.
        g?.releaseToken ? `${base}/api/public/payment-approval/${g.releaseToken}` : '',
        (g?.ledgerHead ?? '') as string,                         // AF Ledger Head — free-text payment remark (from the Payment/GRN record)
        // AG VR No. — PRESERVED (accounts array-formula); omitted here like the other preserved columns.
      ];
    };

    // 1) one row per approved GRN (with its linked milestone's payment status)
    const shownMs = new Set<string>();
    for (const g of gs) {
      // Ensure a stable no-login approval-form token for this payment.
      if (!g.releaseToken) { g.releaseToken = randomUUID(); await grnsCol.updateOne({ _id: g._id } as never, { $set: { releaseToken: g.releaseToken } }); }
      const m = milestoneOf(g);
      if (m) shownMs.add(String(m._id));
      rows.push(makeRow(g, m));
    }
    // 2) one row per milestone not already shown by a GRN above — but ONLY terms
    // that were actually RAISED (TRIGGERED) or PAID. A still-PENDING term hasn't
    // been raised for payment yet, so it must NOT appear in the accounts sheet —
    // the sheet reflects real payment activity, not the future schedule. (Same
    // rule for PO and WO — this loop doesn't branch on type.)
    for (const m of ms) {
      if (shownMs.has(String(m._id))) continue;
      if (m.status !== 'TRIGGERED' && m.status !== 'PAID') continue; // skip PENDING (not yet raised)
      rows.push(makeRow(null, m));
    }
  }

  // Order the sheet by each row's Timestamp (column A = this term's trigger date),
  // oldest → newest, so the sheet reads chronologically to anyone who opens it — the
  // visible order now matches the visible date. Reordering is SAFE: the Accounts
  // UTR / VR columns are array formulas keyed off Milestone Ref (col AB), so they
  // follow each row's data, not its physical position.
  rows.sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));

  // Write every column EXCEPT "UTR / Payment Ref" and "VR No.": the accounts team
  // keeps their own fetch-from-sheet formulas there, and our overwrite must not wipe
  // them. (The reverse-sync still reads those columns' computed values.)
  const headers = [...FMS_ADMIN_HEADERS, ...FMS_EXTRA_HEADERS];
  const preserve = ['UTR / Payment Ref', 'VR No.'].map((h) => headers.indexOf(h)).filter((i) => i >= 0);
  if (preserve.length) await writeTabPreservingCols(FMS_TAB, headers, rows as (string | number | boolean)[][], preserve);
  else await writeTab(FMS_TAB, headers, rows as (string | number | boolean)[][]);
  // Make the Timestamp column a real datetime column (date-picker + dd/mm/yyyy hh:mm:ss).
  await formatTimestampColumn(FMS_TAB);
  return rows.length;
}

/** Full export of every configured entity. */
export async function exportAll(): Promise<ExportResult> {
  if (!sheetsEnabled()) throw new Error('Sheets sync disabled (missing env)');
  await ensureTabs([...ENTITIES.map((e) => e.tab), FMS_TAB]);
  const result: ExportResult = [];
  for (const cfg of ENTITIES) {
    const count = await exportEntity(cfg);
    result.push({ tab: cfg.tab, rows: count });
  }
  result.push({ tab: FMS_TAB, rows: await exportPaymentAccountFms() });
  return result;
}

// ── Live (debounced) auto-sync ──────────────────────────────────────────────
// Called from audit() after every create/update. Coalesces a burst of changes
// into a single background export a few seconds later, so we don't hammer the
// Sheets API. Never throws into the request path.
let debounceTimer: NodeJS.Timeout | null = null;
let running = false;
let queued = false;
const DEBOUNCE_MS = Number(process.env.SHEETS_SYNC_DEBOUNCE_MS) || 8000;

async function runAutoSync(): Promise<void> {
  if (running) { queued = true; return; }
  running = true;
  try {
    await exportAll();
  } catch (err) {
    console.error('[sheetsSync] auto export failed:', (err as Error).message);
  } finally {
    running = false;
    if (queued) { queued = false; scheduleSheetSync(2000); }
  }
}

/** Debounced background sync. No-op when sync is disabled. Fire-and-forget. */
export function scheduleSheetSync(delayMs = DEBOUNCE_MS): void {
  if (!sheetsEnabled()) return;
  if (process.env.SHEETS_LIVE_SYNC === 'off') return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void runAutoSync(); }, delayMs);
}

// ── Reverse-sync poll (sheet → pipeline) ─────────────────────────────────────
// Accounts enter UTRs in their connected a/c sheet at any time, with no signal to
// the app — so we poll. exportPaymentAccountFms() imports UTRs before it writes,
// so one periodic call is the whole cycle (pull payments in, refresh the tab).
let fmsPollTimer: NodeJS.Timeout | null = null;
let fmsPolling = false;
export function startFmsReverseSyncPoll(): void {
  if (!sheetsEnabled() || process.env.SHEETS_LIVE_SYNC === 'off') return;
  if (fmsPollTimer) return; // already running
  const everyMs = Number(process.env.FMS_SYNC_POLL_MS) || 180_000; // default 3 min
  fmsPollTimer = setInterval(() => {
    if (fmsPolling) return;
    fmsPolling = true;
    void exportPaymentAccountFms()
      .then((n) => { if (n >= 0) { /* imported + refreshed */ } })
      .catch((e) => console.error('[sheetsSync] FMS reverse-sync poll failed:', (e as Error).message))
      .finally(() => { fmsPolling = false; });
  }, everyMs);
  fmsPollTimer.unref?.(); // never keep the process alive just for this
  console.log(`[sheetsSync] FMS reverse-sync poll every ${Math.round(everyMs / 1000)}s`);
}
