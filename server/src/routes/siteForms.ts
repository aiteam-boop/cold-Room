import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload, uploadPdf } from '../middleware/upload';
import { loadProjectProgress } from '../services/projectProgress';
import { sendEmail, appClientUrl, isEmailEnabled, approvalCcEmail } from '../services/email';
import { audit } from '../lib/audit';

// ── Site Forms (DPR) ──────────────────────────────────────────────────────────
// Global page, two form types: Site-Engineer activity-wise DPR and Safety-Engineer
// checklist DPR. The whole form is stored as a JSON blob (`data`); listing/filtering
// uses the indexed columns. Gated by the `siteforms` page grant.
const router = Router();
router.use(requireAuth);

const parseJson = <T>(s: string | null | undefined, fb: T): T => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
function serialize(d: any) { return { ...d, data: parseJson(d.data, {} as any) }; }

async function nextDprNumber(type: string): Promise<string> {
  const prefix = type === 'SAFETY' ? 'DPR-SAFE' : 'DPR-SITE';
  const rows = await prisma.siteDpr.findMany({ where: { type }, select: { dprNumber: true } });
  let max = 0;
  for (const r of rows) { const m = /(\d+)\s*$/.exec(r.dprNumber || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}

// ── List (optional ?type=SITE|SAFETY & ?projectId=) ──────────────────────────
router.get('/', requirePage('siteforms'), asyncHandler(async (req, res) => {
  const where: any = {};
  if (req.query.type === 'SITE' || req.query.type === 'SAFETY') where.type = req.query.type;
  if (typeof req.query.projectId === 'string' && req.query.projectId) where.projectId = req.query.projectId;
  const rows = await prisma.siteDpr.findMany({ where, orderBy: { createdAt: 'desc' }, take: 400 });
  res.json({ dprs: rows.map(serialize) });
}));

// ── Project BOQ (quantities only) for the "BOQ — Today's Installation" table ──
// Site-Engineer–gated (NOT the full `boq` grant) and returns NO money — just the
// planned / installed / remaining quantities, reusing the same progress rollup the
// BOQ reconcile view uses.
router.get('/project-boq/:projectId', requirePage('siteforms'), asyncHandler(async (req, res) => {
  const projectId = req.params.projectId;
  const [items, prog] = await Promise.all([
    prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: { id: true, srNo: true, description: true, category: true, unit: true, plannedQty: true } }),
    loadProjectProgress(projectId),
  ]);
  const out = items.map((it) => {
    const p = prog.itemsById.get(it.id);
    return {
      id: it.id, srNo: it.srNo, description: it.description, head: it.category || '', unit: it.unit || '',
      plannedQty: it.plannedQty, installedQty: p?.installedQty ?? 0,
      remainingQty: p?.remainingQty ?? Math.max(it.plannedQty, 0),
    };
  });
  res.json({ items: out });
}));

// ── Uploads (photo per activity, and the TBT PDF) ────────────────────────────
router.post('/upload', requireEdit('siteforms'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('No file uploaded');
  res.status(201).json({ fileUrl: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
}));
router.post('/upload-pdf', requireEdit('siteforms'), uploadPdf.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Only PDF files are allowed — please upload a PDF.');
  res.status(201).json({ fileUrl: `/uploads/${req.file.filename}`, fileName: req.file.originalname });
}));

// ── Get one ──────────────────────────────────────────────────────────────────
router.get('/:id', requirePage('siteforms'), asyncHandler(async (req, res) => {
  const d = await prisma.siteDpr.findUnique({ where: { id: req.params.id } });
  if (!d) throw notFound('DPR not found');
  res.json({ dpr: serialize(d) });
}));

// ── Create (Save draft / Submit) ─────────────────────────────────────────────
const createSchema = z.object({
  type: z.enum(['SITE', 'SAFETY']),
  projectId: z.string().optional().nullable(),
  projectName: z.string().optional().nullable(),
  clientName: z.string().optional().nullable(),
  siteLocation: z.string().optional().nullable(),
  dprDate: z.string().optional().nullable(),
  engineerName: z.string().optional().nullable(),
  data: z.any().optional(),
  submit: z.boolean().optional(),
});
router.post('/', requireEdit('siteforms'), asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  const u = req.user!;
  const dprNumber = await nextDprNumber(b.type);
  const d = await prisma.siteDpr.create({
    data: {
      dprNumber, type: b.type,
      projectId: b.projectId || null, projectName: b.projectName || null,
      clientName: b.clientName || null, siteLocation: b.siteLocation || null,
      dprDate: b.dprDate ? new Date(b.dprDate) : new Date(), engineerName: b.engineerName || null,
      status: b.submit ? 'SUBMITTED' : 'DRAFT',
      data: JSON.stringify(b.data ?? {}),
      createdById: u.sub, createdByName: u.name,
    },
  });
  await audit({ userId: u.sub, action: 'SITEDPR_CREATE', entity: 'SiteDpr', entityId: d.id, details: { type: b.type, dprNumber } });
  res.status(201).json({ dpr: serialize(d) });
}));

// ── Assign to an engineer (no-login link, same idea as the Goods-Receipt flow) ──
// Creates (or re-uses) a DPR row for this project+type with a random token + email,
// then best-effort emails the `/site-forms/:token` link. The link is always returned
// so the office can copy it. The engineer fills + submits with no login.
router.post('/assign', requireEdit('siteforms'), asyncHandler(async (req, res) => {
  const b = z.object({
    type: z.enum(['SITE', 'SAFETY']),
    projectId: z.string().optional().nullable(), projectName: z.string().optional().nullable(),
    clientName: z.string().optional().nullable(), siteLocation: z.string().optional().nullable(),
    dprDate: z.string().optional().nullable(),
    email: z.string().email('Enter a valid email.'),
    dprId: z.string().optional().nullable(),
  }).parse(req.body);
  const u = req.user!;
  let dpr = b.dprId ? await prisma.siteDpr.findUnique({ where: { id: b.dprId } }) : null;
  const token = dpr?.linkToken || crypto.randomBytes(24).toString('hex');
  if (dpr) {
    dpr = await prisma.siteDpr.update({ where: { id: dpr.id }, data: { assignedEmail: b.email, linkToken: token, assignedAt: new Date(), status: dpr.status === 'SUBMITTED' ? dpr.status : 'ASSIGNED' } });
  } else {
    const dprNumber = await nextDprNumber(b.type);
    dpr = await prisma.siteDpr.create({ data: {
      dprNumber, type: b.type, projectId: b.projectId || null, projectName: b.projectName || null,
      clientName: b.clientName || null, siteLocation: b.siteLocation || null,
      dprDate: b.dprDate ? new Date(b.dprDate) : new Date(), status: 'ASSIGNED', data: JSON.stringify({}),
      createdById: u.sub, createdByName: u.name, assignedEmail: b.email, linkToken: token, assignedAt: new Date(),
    } });
  }
  const link = `${appClientUrl()}/site-forms/${token}`;
  const who = b.type === 'SAFETY' ? 'Safety Engineer' : 'Site Engineer';
  if (isEmailEnabled()) {
    try {
      await sendEmail({
        to: b.email, cc: approvalCcEmail(),
        subject: `DPR to fill — ${dpr.dprNumber} (${who})`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
          <p>Hi,</p>
          <p>Please fill the <strong>${who} Daily Progress Report</strong>${dpr.projectName ? ` for <strong>${dpr.projectName}</strong>` : ''} and submit it — no login needed.</p>
          <p style="margin:22px 0"><a href="${link}" style="background:#052379;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open DPR form</a></p>
          <p style="font-size:12px;color:#64748b">Or paste this link in your browser:<br>${link}</p>
        </div>`,
      });
    } catch { /* email is best-effort; the link is still returned */ }
  }
  await audit({ userId: u.sub, action: 'SITEDPR_ASSIGN', entity: 'SiteDpr', entityId: dpr.id, details: { type: b.type, email: b.email } });
  res.json({ ok: true, link, email: b.email, emailed: isEmailEnabled(), dprId: dpr.id, linkToken: token });
}));

// ── Delete (own draft, or admin) ─────────────────────────────────────────────
router.delete('/:id', requireEdit('siteforms'), asyncHandler(async (req, res) => {
  const d = await prisma.siteDpr.findUnique({ where: { id: req.params.id } });
  if (!d) throw notFound('DPR not found');
  await prisma.siteDpr.delete({ where: { id: d.id } });
  await audit({ userId: req.user!.sub, action: 'SITEDPR_DELETE', entity: 'SiteDpr', entityId: d.id, details: { dprNumber: d.dprNumber } });
  res.json({ ok: true });
}));

export default router;
