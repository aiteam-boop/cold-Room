import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { asyncHandler, badRequest } from '../lib/errors';
import { audit } from '../lib/audit';

// Company branding (logo + CEO signature) used on PO/WO/GRN documents & PDFs.
const ASSETS = path.resolve(process.cwd(), 'assets');
fs.mkdirSync(ASSETS, { recursive: true });
const EXTS = ['png', 'jpg', 'jpeg', 'webp'];

export function brandPath(kind: 'logo' | 'signature'): string | null {
  for (const ext of EXTS) {
    const p = path.join(ASSETS, `${kind}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const router = Router();

// GET /api/branding/:kind — serve the image (public so <img> tags work). 404 if unset.
router.get('/:kind', (req, res) => {
  const kind = req.params.kind === 'logo' ? 'logo' : req.params.kind === 'signature' ? 'signature' : null;
  if (!kind) return res.status(404).end();
  const p = brandPath(kind);
  if (!p) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(p);
});

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
    fs.copyFileSync(req.file.path, path.join(ASSETS, `${kind}.${EXTS.includes(ext) ? ext : 'png'}`));
    await audit({ userId: req.user!.sub, action: 'BRANDING_UPLOAD', entity: 'Branding', details: { kind } });
    res.json({ ok: true, kind });
  })
);

export default router;
