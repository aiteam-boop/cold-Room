// Durable file storage in MongoDB (via Prisma `StoredFile.data: Bytes`). Every
// uploaded file is copied into the database so files survive a disk wipe /
// redeploy — the local `uploads/` folder becomes just a fast cache.
//
// MongoDB caps a document at 16MB, so files larger than ~14MB (e.g. big DXF
// drawings) are skipped here and remain disk-only.

import fs from 'fs';
import type { Response } from 'express';
import { prisma } from './prisma';

const MAX_DB_BYTES = 14 * 1024 * 1024;

const TYPE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel', csv: 'text/csv', dxf: 'application/dxf', txt: 'text/plain',
};
function guessType(name: string, fallback?: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return TYPE_BY_EXT[ext] || fallback || 'application/octet-stream';
}

// Copy a file from disk into the DB (upsert by filename). Never throws into the
// caller — persistence must not fail the upload.
export async function persistToDb(filename: string, filePath: string, mimeType?: string): Promise<void> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_DB_BYTES) {
      console.warn(`[fileStore] ${filename} is ${(stat.size / 1e6).toFixed(1)}MB (> DB limit) — kept on disk only.`);
      return;
    }
    const data = fs.readFileSync(filePath);
    await prisma.storedFile.upsert({
      where: { filename },
      update: { data, size: stat.size, mimeType: mimeType || guessType(filename) },
      create: { filename, data, size: stat.size, mimeType: mimeType || guessType(filename) },
    });
  } catch (err) {
    console.error('[fileStore] persist failed for', filename, (err as Error).message);
  }
}

// Send a file from the DB to an HTTP response. Returns false if not stored.
export async function streamFromDb(filename: string, res: Response): Promise<boolean> {
  try {
    const file = await prisma.storedFile.findUnique({ where: { filename } });
    if (!file) return false;
    res.setHeader('Content-Type', file.mimeType || guessType(filename));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(Buffer.from(file.data));
    return true;
  } catch (err) {
    console.error('[fileStore] read failed for', filename, (err as Error).message);
    return false;
  }
}
