// Durable file storage in MongoDB Atlas — every uploaded drawing, invoice, GRN
// photo and BOQ file survives a disk wipe / redeploy. The local `uploads/`
// folder is only a fast cache.
//
// Storage backend: GridFS (bucket "uploads"). GridFS chunks a file into 255KB
// documents, so there is no size limit — the 26–30MB DXF drawings are stored in
// full. (The previous implementation used a single Prisma `StoredFile.data`
// field, which is capped at Mongo's 16MB per-document limit and silently skipped
// anything larger.)
//
// Reads fall back through three layers so nothing that was ever stored is lost:
//   GridFS  →  legacy StoredFile collection  →  local disk (handled by caller).
//
// Note: generated PO / WO / GRN PDFs are NOT stored here — they are rendered on
// the fly from their Atlas rows every time, so there is nothing to persist and
// nothing to lose. Only genuinely uploaded bytes go through this module.

import fs from 'fs';
import type { Response } from 'express';
import { prisma } from './prisma';
import { getUploadsBucket } from './mongoNative';

const TYPE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', csv: 'text/csv', dxf: 'application/dxf', txt: 'text/plain',
};
function guessType(name: string, fallback?: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return TYPE_BY_EXT[ext] || fallback || 'application/octet-stream';
}

/**
 * Copy a file into GridFS, keyed by filename. Idempotent: an existing entry with
 * the same filename is removed first, so re-persisting never duplicates. Never
 * throws into the caller — persistence must not fail the upload itself.
 */
export async function persistToDb(filename: string, filePath: string, mimeType?: string): Promise<void> {
  try {
    const bucket = await getUploadsBucket();
    // Drop any prior copy of this exact filename (filenames are unique stamps).
    const existing = await bucket.find({ filename }).toArray();
    for (const f of existing) await bucket.delete(f._id);

    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(filePath)
        .pipe(bucket.openUploadStream(filename, { metadata: { contentType: mimeType || guessType(filename) } }))
        .on('error', reject)
        .on('finish', () => resolve());
    });
  } catch (err) {
    console.error('[fileStore] persist failed for', filename, (err as Error).message);
  }
}

/** Persist raw bytes we already hold in memory (e.g. a generated export). */
export async function persistBufferToDb(filename: string, data: Buffer, mimeType?: string): Promise<void> {
  try {
    const bucket = await getUploadsBucket();
    const existing = await bucket.find({ filename }).toArray();
    for (const f of existing) await bucket.delete(f._id);
    await new Promise<void>((resolve, reject) => {
      const up = bucket.openUploadStream(filename, { metadata: { contentType: mimeType || guessType(filename) } });
      up.on('error', reject).on('finish', () => resolve());
      up.end(data);
    });
  } catch (err) {
    console.error('[fileStore] persistBuffer failed for', filename, (err as Error).message);
  }
}

/**
 * Stream a stored file to an HTTP response. Tries GridFS, then the legacy
 * `StoredFile` collection (the few files saved before the GridFS switch).
 * Returns false if the file is in neither — the caller then tries local disk.
 */
export async function streamFromDb(filename: string, res: Response): Promise<boolean> {
  // 1. GridFS
  try {
    const bucket = await getUploadsBucket();
    const files = await bucket.find({ filename }).limit(1).toArray();
    if (files.length) {
      const f = files[0];
      res.setHeader('Content-Type', f.metadata?.contentType || guessType(filename));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      await new Promise<void>((resolve, reject) => {
        bucket.openDownloadStreamByName(filename)
          .on('error', reject)
          .on('end', () => resolve())
          .pipe(res);
      });
      return true;
    }
  } catch (err) {
    console.error('[fileStore] GridFS read failed for', filename, (err as Error).message);
  }

  // 2. Legacy single-document store (files saved before the GridFS switch).
  try {
    const file = await prisma.storedFile.findUnique({ where: { filename } });
    if (file) {
      res.setHeader('Content-Type', file.mimeType || guessType(filename));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(Buffer.from(file.data));
      return true;
    }
  } catch (err) {
    console.error('[fileStore] legacy read failed for', filename, (err as Error).message);
  }

  return false;
}

/**
 * Read a stored file back as a Buffer (GridFS, then the legacy store).
 *
 * `streamFromDb` can only write to an HTTP response, but server-side readers —
 * the KYC document reader, for one — need the bytes in hand. After a redeploy
 * wipes the disk the file is still in Atlas, so this is what keeps those
 * features working on a cold VPS. Returns null when the file is in neither.
 */
export async function readFromDb(filename: string): Promise<Buffer | null> {
  try {
    const bucket = await getUploadsBucket();
    const files = await bucket.find({ filename }).limit(1).toArray();
    if (files.length) {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        bucket.openDownloadStreamByName(filename)
          .on('data', (c: Buffer) => chunks.push(c))
          .on('error', reject)
          .on('end', () => resolve());
      });
      return Buffer.concat(chunks);
    }
  } catch (err) {
    console.error('[fileStore] GridFS buffer read failed for', filename, (err as Error).message);
  }
  try {
    const file = await prisma.storedFile.findUnique({ where: { filename } });
    if (file) return Buffer.from(file.data);
  } catch (err) {
    console.error('[fileStore] legacy buffer read failed for', filename, (err as Error).message);
  }
  return null;
}

/**
 * Restore the branding logo/signature from Atlas into a local folder on startup.
 *
 * Most files are served lazily (the /uploads route falls back to GridFS on a
 * cache miss), but the PDF renderer reads the logo/signature straight off disk
 * while building a PO. After a redeploy that wipes the disk those two files must
 * already be present, or every generated PO loses its logo — so we eagerly pull
 * just them back.
 */
export async function restoreBrandingCache(assetsDir: string): Promise<void> {
  try {
    const bucket = await getUploadsBucket();
    for (const kind of ['logo', 'signature']) {
      // Skip if any variant is already cached on disk.
      const present = ['png', 'jpg', 'jpeg', 'webp'].some((e) => fs.existsSync(`${assetsDir}/${kind}.${e}`));
      if (present) continue;
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const key = `branding-${kind}.${ext}`;
        const files = await bucket.find({ filename: key }).limit(1).toArray();
        if (!files.length) continue;
        await new Promise<void>((resolve, reject) => {
          bucket.openDownloadStreamByName(key)
            .on('error', reject)
            .pipe(fs.createWriteStream(`${assetsDir}/${kind}.${ext}`))
            .on('error', reject)
            .on('finish', () => resolve());
        });
        console.log(`[fileStore] restored branding ${kind}.${ext} from Atlas`);
        break;
      }
    }
  } catch (err) {
    console.error('[fileStore] branding restore failed:', (err as Error).message);
  }
}

/** Is this file durably stored (GridFS or legacy)? Used by the backfill/report. */
export async function isPersisted(filename: string): Promise<boolean> {
  try {
    const bucket = await getUploadsBucket();
    if ((await bucket.find({ filename }).limit(1).toArray()).length) return true;
  } catch { /* fall through */ }
  const legacy = await prisma.storedFile.findUnique({ where: { filename }, select: { filename: true } }).catch(() => null);
  return !!legacy;
}
