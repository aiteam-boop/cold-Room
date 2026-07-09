// Push every file in the local uploads/ folder into MongoDB Atlas (GridFS), so
// nothing that was uploaded before durable storage was wired up is lost on the
// next redeploy.
//
//   npx tsx scripts/backfillFilesToAtlas.ts          # report only (default)
//   npx tsx scripts/backfillFilesToAtlas.ts --apply  # actually upload
//
// Idempotent: a file already in GridFS is skipped. Files already in the legacy
// single-document StoredFile collection ARE re-uploaded to GridFS so everything
// lands in one place, then can be read back through the GridFS-first path.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { getUploadsBucket, closeMongoNative } from '../src/lib/mongoNative';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');

(async () => {
  const apply = process.argv.includes('--apply');
  const bucket = await getUploadsBucket();

  let files: string[] = [];
  try { files = fs.readdirSync(UPLOAD_DIR).filter((f) => fs.statSync(path.join(UPLOAD_DIR, f)).isFile()); }
  catch { console.log('No uploads/ folder — nothing to back up.'); await closeMongoNative(); return; }

  // What is already in GridFS?
  const inGridFs = new Set((await bucket.find({}).toArray()).map((f) => f.filename));

  let uploaded = 0, skipped = 0, failed = 0, bytes = 0;
  console.log(`${apply ? 'BACKFILL' : 'DRY RUN'} — ${files.length} files in uploads/\n`);

  for (const filename of files) {
    const filePath = path.join(UPLOAD_DIR, filename);
    const size = fs.statSync(filePath).size;
    if (inGridFs.has(filename)) { skipped++; continue; }

    const mb = (size / 1e6).toFixed(1);
    if (!apply) { console.log(`  would upload  ${filename}  (${mb}MB)`); uploaded++; bytes += size; continue; }

    try {
      await new Promise<void>((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(bucket.openUploadStream(filename))
          .on('error', reject)
          .on('finish', () => resolve());
      });
      console.log(`  uploaded  ${filename}  (${mb}MB)`);
      uploaded++; bytes += size;
    } catch (e) {
      console.error(`  FAILED    ${filename}: ${(e as Error).message}`);
      failed++;
    }
  }

  console.log(`\n${apply ? 'uploaded' : 'would upload'}: ${uploaded} (${(bytes / 1e6).toFixed(1)}MB) · already in Atlas: ${skipped} · failed: ${failed}`);
  if (!apply) console.log('\nRe-run with --apply to upload.');
  await closeMongoNative();
})().catch((e) => { console.error(e); process.exit(1); });
