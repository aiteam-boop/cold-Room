import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest } from '../lib/errors';
import { requireAuth, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { isAdmin } from '../lib/enums';
import { audit } from '../lib/audit';

// ── Attendance (field punch) ──────────────────────────────────────────────────
// A site person punches IN / OUT from their phone: a selfie, the device GPS, and a
// server timestamp. Each viewer sees their own punches; an admin sees everyone's.
const router = Router();
router.use(requireAuth);

// Selfie upload (GridFS-backed, like every other upload).
router.post('/upload', requireEdit('attendance'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No photo uploaded');
  res.status(201).json({ fileUrl: `/uploads/${req.file.filename}` });
}));

// Record a punch (the traveller is always the current user — never spoofable).
const punchSchema = z.object({
  type: z.enum(['IN', 'OUT']),
  selfieUrl: z.string().optional().nullable(),
  lat: z.number().optional().nullable(), lng: z.number().optional().nullable(), accuracy: z.number().optional().nullable(),
  address: z.string().optional().nullable(),
  geoAddress: z.string().optional().nullable(),
  projectId: z.string().optional().nullable(), projectName: z.string().optional().nullable(),
});
router.post('/punch', requireEdit('attendance'), asyncHandler(async (req, res) => {
  const b = punchSchema.parse(req.body);
  const u = req.user!;
  const rec = await prisma.attendance.create({
    data: {
      userId: u.sub, userName: u.name, type: b.type,
      selfieUrl: b.selfieUrl || null, lat: b.lat ?? null, lng: b.lng ?? null, accuracy: b.accuracy ?? null,
      address: b.address || null, geoAddress: b.geoAddress || null, projectId: b.projectId || null, projectName: b.projectName || null,
    },
  });
  await audit({ userId: u.sub, action: 'ATTENDANCE_PUNCH', entity: 'Attendance', entityId: rec.id, details: { type: b.type } });
  res.status(201).json({ attendance: rec });
}));

// The current user's own recent punches (drives the In/Out state + personal history).
router.get('/mine', requirePage('attendance'), asyncHandler(async (req, res) => {
  const rows = await prisma.attendance.findMany({ where: { userId: req.user!.sub }, orderBy: { at: 'desc' }, take: 80 });
  res.json({ records: rows });
}));

// Register — admin sees everyone (optional ?userId= & ?date=YYYY-MM-DD); others see own.
router.get('/', requirePage('attendance'), asyncHandler(async (req, res) => {
  const admin = isAdmin(req.account!.role);
  const where: any = {};
  if (!admin) where.userId = req.user!.sub;
  else if (typeof req.query.userId === 'string' && req.query.userId) where.userId = req.query.userId;
  if (typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
    where.at = { gte: new Date(`${req.query.date}T00:00:00`), lte: new Date(`${req.query.date}T23:59:59.999`) };
  }
  const rows = await prisma.attendance.findMany({ where, orderBy: { at: 'desc' }, take: 500 });
  res.json({ records: rows, admin });
}));

export default router;
