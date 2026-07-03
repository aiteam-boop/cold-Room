import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requirePage, requireEdit } from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';
import { audit } from '../lib/audit';

const router = Router();
router.use(requireAuth);

// KYC status from uploaded KYC docs (Complete >=4 / Partial 1-3 / Missing 0).
function kycStatus(count: number): 'Complete' | 'Partial' | 'Missing' {
  if (count >= 4) return 'Complete';
  if (count >= 1) return 'Partial';
  return 'Missing';
}

const vendorSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['VENDOR', 'CONTRACTOR']).default('VENDOR'),
  contactPerson: z.string().optional(),
  phones: z.string().optional(),
  tel: z.string().optional(),
  fax: z.string().optional(),
  website: z.string().optional(),
  address: z.string().optional(),
  email: z.string().optional(),
  gstin: z.string().optional(),
  cin: z.string().optional(),
  pan: z.string().optional(),
  bankAccount: z.string().optional(),
  ifsc: z.string().optional(),
  projectIds: z.array(z.string()).optional(), // initial site mappings
});

// GET /api/vendors — all vendors (admin/management/procurement).
router.get(
  '/',
  requirePage('vendors'),
  asyncHandler(async (_req, res) => {
    const vendors = await prisma.vendor.findMany({
      orderBy: { createdAt: 'desc' },
      include: { siteMappings: { include: { project: { select: { id: true, name: true } } } }, _count: { select: { docs: true, kycDocs: true } } },
    });
    res.json({ vendors: vendors.map((v) => ({ ...v, kycStatus: kycStatus(v._count.kycDocs) })) });
  })
);

// POST /api/vendors — create a vendor (+ optional site mappings).
router.post(
  '/',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    const body = vendorSchema.parse(req.body);
    const vendor = await prisma.vendor.create({
      data: {
        name: body.name, type: body.type, contactPerson: body.contactPerson, phones: body.phones,
        tel: body.tel, fax: body.fax, website: body.website,
        address: body.address, email: body.email, gstin: body.gstin, cin: body.cin, pan: body.pan,
        bankAccount: body.bankAccount, ifsc: body.ifsc, createdById: req.user!.sub,
        siteMappings: body.projectIds?.length ? { create: body.projectIds.map((projectId) => ({ projectId })) } : undefined,
      },
    });
    await audit({ userId: req.user!.sub, action: 'VENDOR_CREATE', entity: 'Vendor', entityId: vendor.id, details: { name: body.name } });
    res.status(201).json({ vendor });
  })
);

// GET /api/vendors/:id — detail with PO/WO history + KYC docs.
router.get(
  '/:id',
  requirePage('vendors'),
  asyncHandler(async (req, res) => {
    const vendor = await prisma.vendor.findUnique({
      where: { id: req.params.id },
      include: {
        siteMappings: { include: { project: { select: { id: true, name: true } } } },
        docs: { select: { id: true, type: true, docNumber: true, status: true, finalAmount: true, projectId: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        kycDocs: { where: { type: 'KYC' }, orderBy: { uploadedAt: 'desc' } },
      },
    });
    if (!vendor) throw notFound('Vendor not found');
    res.json({ vendor: maskFinancials({ ...vendor, kycStatus: kycStatus(vendor.kycDocs.length) }, req.account) });
  })
);

router.patch(
  '/:id',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    const body = vendorSchema.partial().parse(req.body);
    const vendor = await prisma.vendor.update({
      where: { id: req.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.type !== undefined && { type: body.type }),
        ...(body.contactPerson !== undefined && { contactPerson: body.contactPerson }),
        ...(body.phones !== undefined && { phones: body.phones }),
        ...(body.tel !== undefined && { tel: body.tel }),
        ...(body.fax !== undefined && { fax: body.fax }),
        ...(body.website !== undefined && { website: body.website }),
        ...(body.address !== undefined && { address: body.address }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.gstin !== undefined && { gstin: body.gstin }),
        ...(body.cin !== undefined && { cin: body.cin }),
        ...(body.pan !== undefined && { pan: body.pan }),
        ...(body.bankAccount !== undefined && { bankAccount: body.bankAccount }),
        ...(body.ifsc !== undefined && { ifsc: body.ifsc }),
      },
    });
    await audit({ userId: req.user!.sub, action: 'VENDOR_UPDATE', entity: 'Vendor', entityId: vendor.id });
    res.json({ vendor });
  })
);

// Site mapping (FR-MC-25).
router.post(
  '/:id/sites',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    const { projectId } = z.object({ projectId: z.string() }).parse(req.body);
    const mapping = await prisma.vendorSiteMapping.upsert({
      where: { vendorId_projectId: { vendorId: req.params.id, projectId } },
      update: {}, create: { vendorId: req.params.id, projectId },
    });
    await audit({ userId: req.user!.sub, projectId, action: 'VENDOR_SITE_MAP', entity: 'Vendor', entityId: req.params.id });
    res.status(201).json({ mapping });
  })
);

router.delete(
  '/:id/sites/:projectId',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    await prisma.vendorSiteMapping.deleteMany({ where: { vendorId: req.params.id, projectId: req.params.projectId } });
    res.json({ ok: true });
  })
);

export default router;
