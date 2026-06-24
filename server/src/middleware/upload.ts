import multer from 'multer';
import path from 'path';
import fs from 'fs';

const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${stamp}-${safe}`);
  },
});

// FR-DM-01: drawings up to 50MB. We apply the same ceiling to BOQ uploads.
export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

export const UPLOADS_PATH = UPLOAD_DIR;
