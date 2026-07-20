// Google Sheets sync for CRMCTS.
// One tab per Mongo collection. Column "id" (the Mongo _id) is always first so
// rows can be matched back for Sheet -> DB import (two-way sync).
//
// Requires env: GOOGLE_SERVICE_ACCOUNT_JSON (unquoted single-line JSON) and
// SPREADSHEET_ID. If either is missing, sync is treated as disabled (no-ops).

import { google, sheets_v4 } from 'googleapis';
import { MongoClient, Db } from 'mongodb';
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

// ── Export (Mongo -> Sheet) ─────────────────────────────────────────────────

export type ExportResult = { tab: string; rows: number }[];

// Base URL for turning stored file paths (e.g. "/uploads/xyz.pdf") into full,
// clickable links in the sheet. Set APP_URL to your public domain
// (e.g. https://coldroom.crystalgrp.xyz) for the links to open.
function fileBaseUrl(): string {
  return (process.env.APP_URL || (process.env.CLIENT_ORIGIN || '').split(',')[0] || '').replace(/\/$/, '');
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
/** P onwards: the Cold Room detail the accounts sheet doesn't carry. */
const FMS_EXTRA_HEADERS = [
  'Project', 'PO Number', 'PO PDF', 'GRN Numbers', 'GRN PDFs', 'Invoiced', 'Paid',
  'UTR / Payment Ref', 'Payment Remark', 'PO Status',
];

const dmy = (d: unknown): string => {
  const dt = d instanceof Date ? d : d ? new Date(String(d)) : null;
  if (!dt || Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};
const dmyTime = (d: unknown): string => {
  const dt = d instanceof Date ? d : d ? new Date(String(d)) : null;
  if (!dt || Number.isNaN(dt.getTime())) return '';
  return `${dmy(dt)} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}:${String(dt.getSeconds()).padStart(2, '0')}`;
};
/** Stack one value per GRN, one under the other, inside a single cell. */
const stack = (vals: unknown[]): string => vals.map((v) => (v == null || v === '' ? '—' : String(v))).join('\n');
/** Absolute, click-from-the-sheet URL. /api/* PDFs are signed; /uploads/* are public. */
function fileUrl(raw: unknown, base: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '';
  return base + (raw.startsWith('/api/') ? signApiPath(raw) : raw);
}

export async function exportPaymentAccountFms(): Promise<number> {
  const db = await getDb();
  const base = fileBaseUrl();
  const [docs, grns, projects, users, milestones] = await Promise.all([
    db.collection('ProcurementDoc').find({ type: { $in: ['PO', 'WO'] } }).sort({ createdAt: 1 }).toArray(),
    db.collection('GRN').find({}).sort({ createdAt: 1 }).toArray(),
    db.collection('Project').find({}).project({ name: 1 }).toArray(),
    db.collection('User').find({}).project({ name: 1, email: 1 }).toArray(),
    db.collection('PaymentMilestone').find({}).toArray(),
  ]);
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

  const rows = docs.map((d) => {
    const id = String(d._id);
    const ms = msByDoc.get(id) ?? [];
    // A PO enters this (accounts) sheet ONLY once a payment is actually due —
    // i.e. at least one milestone has been TRIGGERED ("Mark Triggered") or PAID.
    // A PO whose milestones are all still PENDING is not yet an accounts item,
    // even if it's approved.
    const inPipeline = ms.some((m) => m.status === 'TRIGGERED' || m.status === 'PAID');
    if (!inPipeline) return null;
    // Show ONLY approved GRNs — a DRAFT / pending GRN (and its PI/invoice) isn't
    // final, so it must not appear. Each triggered milestone's approved GRN stacks
    // into this same PO row.
    const gs = (grnsByDoc.get(id) ?? []).filter((g) => g.status === 'APPROVED');
    const creator = d.createdById ? userById.get(String(d.createdById)) : undefined;
    const term = (g: Record<string, unknown>) => {
      const m = ms.find((x) => String(x._id) === String(g.milestoneId));
      return m ? `${m.name}${m.percentage ? ` ${m.percentage}%` : ''}` : '';
    };
    const invoiced = gs.reduce((s, g) => s + (Number(g.invoiceValue) || 0), 0);
    const paid = ms.filter((m) => m.status === 'PAID').reduce((s, m) => s + (Number(m.inrAmount) || 0), 0);
    // UTR + its remark live on the milestone (set by Accounts on "Mark Paid"),
    // whether the payment ran through the Pipeline or FMS. A PO can have several
    // paid milestones, so stack one per milestone that carries a UTR/remark,
    // prefixed with the milestone name so it's clear which payment it is.
    const withUtr = ms.filter((m) => m.utrNumber || m.paymentReference || m.remarks);
    const utrCell = stack(withUtr.map((m) => `${m.name}: ${m.utrNumber || m.paymentReference || '—'}`));
    const remarkCell = stack(withUtr.map((m) => `${m.name}: ${m.remarks || '—'}`));

    return [
      dmyTime(d.createdAt),                                   // A Timestamp
      creator?.email ?? '',                                    // B Email address
      creator?.name ?? '',                                     // C User
      stack(gs.map((g) => g.invoiceNumber)),                   // D Invoice Number (per GRN)
      stack(gs.map((g) => dmy(g.invoiceDate))),                // E Invoice Date
      stack(gs.map((g) => dmy(g.piDate))),                     // F Bill received by User = PI date
      d.vendorName ?? '',                                      // G Vendor Name
      Number(d.finalAmount) || 0,                              // H Full Amount
      stack(gs.map((g) => g.amountToPay)),                     // I Amount To Pay
      stack(gs.map((g) => dmy(g.paymentDueDate))),             // J Payment Due Date
      stack(gs.map((g) => g.milestoneName || 'Full Payment')), // K Payment Type
      stack(gs.map(term)),                                     // L Payment Terms (milestone name)
      stack(gs.map((g) => fileUrl(g.invoicePdfUrl, base))),    // M Invoice with Supporting
      stack(gs.map((g) => fileUrl(g.piPdfUrl, base))),         // N PI
      'Coldroom',                                              // O Department
      // ── P onwards: Cold Room detail ──
      projName.get(String(d.projectId)) ?? '',                 // P Project
      d.docNumber ?? '',                                       // Q PO Number
      fileUrl(`/api/projects/${d.projectId}/procurement/docs/${id}/pdf`, base), // R PO PDF
      stack(gs.map((g) => g.grnNumber)),                       // S GRN Numbers
      stack(gs.map((g) => fileUrl(`/api/projects/${g.projectId}/procurement/grns/${String(g._id)}/pdf`, base))), // T GRN PDFs
      invoiced,                                                // U Invoiced
      paid,                                                    // V Paid
      utrCell,                                                 // W UTR / Payment Ref (per milestone)
      remarkCell,                                              // X Payment Remark (per milestone)
      d.status ?? '',                                          // Y PO Status
    ];
  }).filter((r): r is (string | number)[] => r !== null);

  await writeTab(FMS_TAB, [...FMS_ADMIN_HEADERS, ...FMS_EXTRA_HEADERS], rows as (string | number | boolean)[][]);
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
