import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { upload, uploadPdf } from '../middleware/upload';
import { loadProjectProgress } from '../services/projectProgress';

// No-login public DPR form. The engineer opens `/site-forms/:token` (a client route)
// which calls these endpoints. The random linkToken IS the credential, so this router
// is mounted OUTSIDE the requireAuth chain (same model as publicGrn).
const router = Router();

const parseJson = <T>(s: string | null | undefined, fb: T): T => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
async function findByToken(token: string) { return token ? prisma.siteDpr.findFirst({ where: { linkToken: token } }) : null; }

// GET /:token — load the assigned DPR + (for a Site DPR) the project's BOQ.
router.get('/:token', asyncHandler(async (req, res) => {
  const d = await findByToken(req.params.token);
  if (!d) throw notFound('This DPR link is invalid or has expired.');
  let boq: any[] = [];
  if (d.type === 'SITE' && d.projectId) {
    const [items, prog] = await Promise.all([
      prisma.bOQItem.findMany({ where: { projectId: d.projectId, isGroup: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, srNo: true, description: true, category: true, unit: true, plannedQty: true } }),
      loadProjectProgress(d.projectId),
    ]);
    boq = items.map((it) => {
      const p = prog.itemsById.get(it.id);
      return { id: it.id, srNo: it.srNo, description: it.description, head: it.category || '', unit: it.unit || '', plannedQty: it.plannedQty, installedQty: p?.installedQty ?? 0, remainingQty: p?.remainingQty ?? Math.max(it.plannedQty, 0) };
    });
  }
  res.json({
    dpr: {
      id: d.id, type: d.type, dprNumber: d.dprNumber, projectId: d.projectId, projectName: d.projectName,
      clientName: d.clientName, siteLocation: d.siteLocation, dprDate: d.dprDate, engineerName: d.engineerName,
      status: d.status, data: parseJson(d.data, {} as any),
    },
    boq,
  });
}));

// POST /:token/upload — photo per activity.
router.post('/:token/upload', upload.single('file'), asyncHandler(async (req, res) => {
  const d = await findByToken(req.params.token); if (!d) throw notFound('Invalid link.');
  if (!req.file) throw badRequest('No file uploaded');
  res.status(201).json({ fileUrl: `/uploads/${req.file.filename}` });
}));
// POST /:token/upload-pdf — the TBT PDF.
router.post('/:token/upload-pdf', uploadPdf.single('file'), asyncHandler(async (req, res) => {
  const d = await findByToken(req.params.token); if (!d) throw notFound('Invalid link.');
  if (!req.file) throw badRequest('Only PDF files are allowed.');
  res.status(201).json({ fileUrl: `/uploads/${req.file.filename}` });
}));

// POST /:token/submit — save the filled form (draft or final submit).
router.post('/:token/submit', asyncHandler(async (req, res) => {
  const d = await findByToken(req.params.token); if (!d) throw notFound('Invalid link.');
  if (d.status === 'SUBMITTED') throw badRequest('This DPR has already been submitted.');
  const b = z.object({ engineerName: z.string().optional().nullable(), dprDate: z.string().optional().nullable(), data: z.any().optional(), submit: z.boolean().optional() }).parse(req.body);
  const upd = await prisma.siteDpr.update({
    where: { id: d.id },
    data: {
      engineerName: b.engineerName ?? d.engineerName,
      dprDate: b.dprDate ? new Date(b.dprDate) : d.dprDate,
      data: JSON.stringify(b.data ?? {}),
      status: b.submit ? 'SUBMITTED' : d.status,
      submittedAt: b.submit ? new Date() : d.submittedAt,
    },
  });
  res.json({ ok: true, status: upd.status });
}));

export default router;
