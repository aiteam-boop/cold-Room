import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { asyncHandler, badRequest } from '../lib/errors';
import { audit } from '../lib/audit';
import { persistBufferToDb, streamFromDb } from '../lib/fileStore';

// Company branding (logo + CEO signature) — appears on every PO/WO/GRN PDF.
// Kept in a small local `assets/` cache AND in Atlas GridFS (under stable keys
// `branding-logo.<ext>` / `branding-signature.<ext>`) so a redeploy that wipes
// the disk does not blank the logo on every generated document.
const ASSETS = path.resolve(process.cwd(), 'assets');
fs.mkdirSync(ASSETS, { recursive: true });
const EXTS = ['png', 'jpg', 'jpeg', 'webp'];
const brandKey = (kind: string, ext: string) => `branding-${kind}.${ext}`;

export function brandPath(kind: 'logo' | 'signature'): string | null {
  for (const ext of EXTS) {
    const p = path.join(ASSETS, `${kind}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const router = Router();

// GET /api/branding/:kind — serve the image (public so <img> tags work). Falls
// back to Atlas when the local cache is cold. 404 if never set.
router.get('/:kind', asyncHandler(async (req, res) => {
  const kind = req.params.kind === 'logo' ? 'logo' : req.params.kind === 'signature' ? 'signature' : null;
  if (!kind) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-cache');

  const p = brandPath(kind);
  if (p) return res.sendFile(p);

  // Not on disk — try each known extension in Atlas GridFS.
  for (const ext of EXTS) {
    if (await streamFromDb(brandKey(kind, ext), res)) return;
  }
  return res.status(404).end();
}));

// POST /api/branding/:kind — admin uploads/replaces the logo or signature.
router.post(
  '/:kind',
  requireAuth,
  requireEdit('documents'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind === 'logo' ? 'logo' : req.params.kind === 'signature' ? 'signature' : null;
    if (!kind) throw badRequest('kind must be "logo" or "signature"');
    if (!req.file) throw badRequest('No file uploaded (field: file)');
    // Remove any previous variants, then store the new one.
    for (const ext of EXTS) { const p = path.join(ASSETS, `${kind}.${ext}`); if (fs.existsSync(p)) fs.rmSync(p); }
    const ext = (path.extname(req.file.originalname).slice(1).toLowerCase() || 'png').replace('jpeg', 'jpg');
    const finalExt = EXTS.includes(ext) ? ext : 'png';
    const bytes = fs.readFileSync(req.file.path);
    fs.writeFileSync(path.join(ASSETS, `${kind}.${finalExt}`), bytes);
    // Persist under the stable branding key so it survives a redeploy.
    await persistBufferToDb(brandKey(kind, finalExt), bytes, req.file.mimetype);
    await audit({ userId: req.user!.sub, action: 'BRANDING_UPLOAD', entity: 'Branding', details: { kind } });
    res.json({ ok: true, kind });
  })
);

export default router;
