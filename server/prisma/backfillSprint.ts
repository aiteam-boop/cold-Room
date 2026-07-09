// One-time backfill for the Gantt + Vendor + BOQ Cost + GRN + PO sprint.
//
// Prisma applies `@default(...)` at CREATE time only. On MongoDB, a document
// written before a required field existed simply has no such key, and reading it
// back through Prisma fails ("missing required field"). Every field added in
// this sprint is nullable — except `Vendor.isActive` — so this script sets that
// key (and the two new scalar-list fields, for tidiness) on pre-existing rows.
//
// Reads/writes go through the native MongoDB driver rather than Prisma, matching
// services/sheetsSync.ts: Prisma's query engine intermittently fails the Atlas
// TLS handshake on this network, whereas the native driver is reliable.
//
//   npm --prefix server run backfill:sprint
//
// Idempotent: each update targets only documents where the key is absent, so
// re-running it is a no-op.

import 'dotenv/config';
import { MongoClient } from 'mongodb';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const client = new MongoClient(url);
  await client.connect();
  const db = client.db();

  // Vendor.isActive is the only NON-nullable field this sprint adds.
  const vendors = db.collection('Vendor');
  const r1 = await vendors.updateMany({ isActive: { $exists: false } }, { $set: { isActive: true } });
  const r2 = await vendors.updateMany({ boqCategories: { $exists: false } }, { $set: { boqCategories: [] } });
  const r3 = await vendors.updateMany({ workCategories: { $exists: false } }, { $set: { workCategories: [] } });

  console.log(`Vendor.isActive       → ${r1.modifiedCount} document(s) backfilled`);
  console.log(`Vendor.boqCategories  → ${r2.modifiedCount} document(s) backfilled`);
  console.log(`Vendor.workCategories → ${r3.modifiedCount} document(s) backfilled`);

  // Everything else added this sprint is nullable and needs no backfill:
  //   Project.orderReceiveDate / advanceReceiveDate / officialStartDate / drawingApprovals
  //   GanttActivity.completedAt / completedById / completionNotes / responsible*
  //   ProcurementLineItem.boqItemId, ProcurementDocument.kycKind
  //   PaymentMilestone.utrNumber / paymentProofUrl, GRN.photoUrl
  //   Vendor.legalName / tradeName / vendorType / contacts / plants / …
  //
  // T&C clauses gain isStruckOff / isLocked / isCustom, but they live inside the
  // termsSections JSON string and are re-derived on read by
  // normalizeTermsSections(), so stored documents need no migration.

  await client.close();
  console.log('\nBackfill complete.');
}

main().catch((e) => {
  console.error('[backfill:sprint] failed:', e);
  process.exit(1);
});
