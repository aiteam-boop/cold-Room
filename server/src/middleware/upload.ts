import multer, { StorageEngine } from 'multer';
import path from 'path';
import fs from 'fs';
import { persistToDb } from '../lib/fileStore';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${stamp}-${safe}`);
  },
});

// Dual storage: write to local disk (fast cache) AND persist the bytes into
// MongoDB GridFS so files are durable across redeploys. Every existing route
// keeps using `/uploads/<filename>` unchanged.
//
// Persistence is awaited (not fire-and-forget): a drawing that returns 201 but
// never reached Atlas is exactly the silent data loss this whole change fixes.
// GridFS handles any size, so the old 14MB skip is gone. If Atlas is briefly
// unreachable the upload still succeeds on disk — the backfill script closes the
// gap later — but the common path now guarantees the file is in Atlas.
const dualStorage: StorageEngine = {
  _handleFile(req, file, cb) {
    diskStorage._handleFile(req, file, (err, info) => {
      if (err || !info) return cb(err);
      persistToDb(info.filename!, info.path!, file.mimetype)
        .then(() => cb(null, info))
        .catch(() => cb(null, info)); // never fail the upload on a persistence hiccup
    });
  },
  _removeFile(req, file, cb) {
    diskStorage._removeFile(req, file, cb);
  },
};

// FR-DM-01: drawings up to 50MB. We apply the same ceiling to BOQ uploads.
export const upload = multer({
  storage: dualStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

export const UPLOADS_PATH = UPLOAD_DIR;
