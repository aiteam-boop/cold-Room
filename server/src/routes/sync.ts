import { Router } from 'express';
import { asyncHandler, badRequest } from '../lib/errors';
import { requireAuth, requireAdmin } from '../middleware/authMiddleware';
import { exportAll, sheetsEnabled } from '../services/sheetsSync';

// Admin-only manual "Sync now" — pushes the whole database to Google Sheets.
const router = Router();
router.use(requireAuth, requireAdmin);

router.post(
  '/sheets',
  asyncHandler(async (_req, res) => {
    if (!sheetsEnabled()) throw badRequest('Google Sheets sync is not configured (set GOOGLE_SERVICE_ACCOUNT_JSON and SPREADSHEET_ID).');
    const tabs = await exportAll();
    const total = tabs.reduce((a, b) => a + b.rows, 0);
    res.json({ ok: true, total, tabs });
  })
);

export default router;
