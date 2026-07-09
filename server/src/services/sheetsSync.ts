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

/** Full export of every configured entity. */
export async function exportAll(): Promise<ExportResult> {
  if (!sheetsEnabled()) throw new Error('Sheets sync disabled (missing env)');
  await ensureTabs(ENTITIES.map((e) => e.tab));
  const result: ExportResult = [];
  for (const cfg of ENTITIES) {
    const count = await exportEntity(cfg);
    result.push({ tab: cfg.tab, rows: count });
  }
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
