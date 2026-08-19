import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound, forbidden } from '../lib/errors';
import { requireAuth, requirePage, requireEdit } from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';
import { audit } from '../lib/audit';
import { appBaseUrl } from '../services/email';
import {
  BANK_ACCOUNT_TYPES, BOQ_CATEGORIES, CONTACT_AUTHORITY_LEVELS, KYC_KINDS,
  MAX_CONTACT_PHONES, MAX_VENDOR_CONTACTS, VENDOR_TYPES, WORK_CATEGORIES,
} from '../lib/enums';
import {
  kycStatus, legacyMirror, normalizeBankAccounts, normalizeBillingAddress,
  normalizeBoqCategories, normalizeContacts, normalizePlants, normalizeRateChart,
  normalizeWorkCategories, rateFor,
} from '../services/vendorProfile';

const router = Router();
router.use(requireAuth);

// ── Validation ───────────────────────────────────────────────────────────────
// Shapes mirror services/vendorProfile.ts. Zod guards the boundary; the
// normalize* helpers then enforce the invariants (single primary, no nameless
// contacts, etc.) so a hand-crafted request can't corrupt the Json columns.

const contactSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  designation: z.string().nullable().optional(),
  authorityLevel: z.enum(CONTACT_AUTHORITY_LEVELS).nullable().optional(),
  phones: z.array(z.string()).max(MAX_CONTACT_PHONES).optional(),
  email: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});
const plantSchema = z.object({
  id: z.string().optional(),
  address: z.string().trim().min(1),
  address2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  pin: z.string().nullable().optional(),
  gstin: z.string().nullable().optional(),
});
const bankSchema = z.object({
  id: z.string().optional(),
  bankName: z.string().trim().min(1),
  accountNo: z.string().trim().min(1),
  branch: z.string().nullable().optional(),
  ifsc: z.string().nullable().optional(),
  accountType: z.enum(BANK_ACCOUNT_TYPES).nullable().optional(),
  beneficiaryName: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
});
const rateSchema = z.object({
  id: z.string().optional(),
  itemDescription: z.string().trim().min(1),
  unit: z.string().nullable().optional(),
  rate: z.coerce.number().nonnegative(),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const vendorSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['VENDOR', 'CONTRACTOR']).default('VENDOR'),
  // Legacy scalars — still accepted so old clients / inline create keep working.
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

  // ── Full profile (Sprint PRD §5) ──
  legalName: z.string().nullable().optional(),
  tradeName: z.string().nullable().optional(),
  vendorType: z.enum(VENDOR_TYPES).nullable().optional(),
  boqCategories: z.array(z.enum(BOQ_CATEGORIES)).optional(),
  workCategories: z.array(z.enum(WORK_CATEGORIES)).optional(),
  contacts: z.array(contactSchema).max(MAX_VENDOR_CONTACTS).optional(),
  plants: z.array(plantSchema).optional(),
  billingAddress: z.object({
    address: z.string(), city: z.string().nullable().optional(),
    state: z.string().nullable().optional(), pin: z.string().nullable().optional(),
  }).nullable().optional(),
  bankAccounts: z.array(bankSchema).optional(),
  rateChart: z.array(rateSchema).optional(),
  registeredSince: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

/** True only when the body explicitly states a non-contractor type. */
function isNonContractor(b: Partial<z.infer<typeof vendorSchema>>): boolean {
  if (b.vendorType) return b.vendorType !== 'CONTRACTOR';
  if (b.type) return b.type !== 'CONTRACTOR';
  return false; // type not stated → leave work categories alone
}

/**
 * Map a validated body onto Prisma column values. The Json collections are
 * normalized here, and the legacy scalar columns are re-derived from the
 * primary contact / bank account so the two representations never disagree.
 */
function toVendorData(b: z.infer<typeof vendorSchema>) {
  const contacts = b.contacts !== undefined ? normalizeContacts(b.contacts) : undefined;
  const bankAccounts = b.bankAccounts !== undefined ? normalizeBankAccounts(b.bankAccounts) : undefined;

  const data: Record<string, unknown> = {
    ...(b.name !== undefined && { name: b.name }),
    ...(b.type !== undefined && { type: b.type }),
    ...(b.contactPerson !== undefined && { contactPerson: b.contactPerson }),
    ...(b.phones !== undefined && { phones: b.phones }),
    ...(b.tel !== undefined && { tel: b.tel }),
    ...(b.fax !== undefined && { fax: b.fax }),
    ...(b.website !== undefined && { website: b.website }),
    ...(b.address !== undefined && { address: b.address }),
    ...(b.email !== undefined && { email: b.email }),
    ...(b.gstin !== undefined && { gstin: b.gstin }),
    ...(b.cin !== undefined && { cin: b.cin }),
    ...(b.pan !== undefined && { pan: b.pan }),
    ...(b.bankAccount !== undefined && { bankAccount: b.bankAccount }),
    ...(b.ifsc !== undefined && { ifsc: b.ifsc }),

    ...(b.legalName !== undefined && { legalName: b.legalName }),
    ...(b.tradeName !== undefined && { tradeName: b.tradeName }),
    ...(b.vendorType !== undefined && { vendorType: b.vendorType }),
    ...(b.boqCategories !== undefined && { boqCategories: normalizeBoqCategories(b.boqCategories) }),
    // Work categories only mean something for contractors. Clear them only when
    // this request actually says the vendor is NOT one — a partial PATCH that
    // omits the type must not silently wipe an existing contractor's categories.
    ...(b.workCategories !== undefined && {
      workCategories: isNonContractor(b) ? [] : normalizeWorkCategories(b.workCategories),
    }),
    ...(contacts !== undefined && { contacts }),
    ...(b.plants !== undefined && { plants: normalizePlants(b.plants) }),
    ...(b.billingAddress !== undefined && { billingAddress: normalizeBillingAddress(b.billingAddress) }),
    ...(bankAccounts !== undefined && { bankAccounts }),
    ...(b.rateChart !== undefined && { rateChart: normalizeRateChart(b.rateChart) }),
    ...(b.registeredSince !== undefined && { registeredSince: b.registeredSince ? new Date(b.registeredSince) : null }),
    ...(b.isActive !== undefined && { isActive: b.isActive }),
  };

  // Keep the denormalized primary contact / bank in step with the rich profile,
  // but never let it clobber a value the caller set explicitly in this request.
  const mirror = legacyMirror({ contacts: contacts ?? [], bankAccounts: bankAccounts ?? [] });
  for (const [k, v] of Object.entries(mirror)) if (data[k] === undefined) data[k] = v;

  return data;
}

// GET /api/vendors — all vendors. `?activeOnly=1` hides deactivated vendors
// (PO/WO vendor search uses this; the vendor master page shows everything).
router.get(
  '/',
  requirePage('vendors'),
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
    const vendors = await prisma.vendor.findMany({
      where: activeOnly ? { isActive: true } : {},
      orderBy: { createdAt: 'desc' },
      include: {
        siteMappings: { include: { project: { select: { id: true, name: true } } } },
        kycDocs: { where: { type: 'KYC' }, select: { kycKind: true } },
        _count: { select: { docs: true } },
      },
    });
    res.json({
      vendors: vendors.map(({ kycDocs, ...v }) => ({ ...v, kycStatus: kycStatus(kycDocs), kycDocCount: kycDocs.length })),
    });
  })
);

// GET /api/vendors/meta — the option lists the vendor form renders.
router.get(
  '/meta',
  requirePage('vendors'),
  asyncHandler(async (_req, res) => {
    res.json({
      vendorTypes: VENDOR_TYPES,
      boqCategories: BOQ_CATEGORIES,
      workCategories: WORK_CATEGORIES,
      authorityLevels: CONTACT_AUTHORITY_LEVELS,
      bankAccountTypes: BANK_ACCOUNT_TYPES,
      kycKinds: KYC_KINDS,
      maxContacts: MAX_VENDOR_CONTACTS,
      maxPhonesPerContact: MAX_CONTACT_PHONES,
    });
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
        ...(toVendorData(body) as { name: string }),
        createdById: req.user!.sub,
        siteMappings: body.projectIds?.length ? { create: body.projectIds.map((projectId) => ({ projectId })) } : undefined,
      },
    });
    await audit({ userId: req.user!.sub, action: 'VENDOR_CREATE', entity: 'Vendor', entityId: vendor.id, details: { name: body.name } });
    res.status(201).json({ vendor });
  })
);

// GET /api/vendors/:id/kyc-view — a tiny standalone HTML page listing this
// vendor's KYC documents as clickable links. Reached via a SIGNED link from the
// FMS sheet (Accounts isn't logged in) — the signed-link gate in requireAuth
// unlocks this exact path. One clickable cell in the sheet → this page → each doc
// opens with a click, instead of the old copy-paste-the-URL text.
router.get(
  '/:id/kyc-view',
  requireAuth,
  asyncHandler(async (req, res) => {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { name: true } });
    const docs = vendor
      ? await prisma.procurementDocument.findMany({ where: { vendorId: req.params.id, type: 'KYC' }, orderBy: { uploadedAt: 'desc' }, select: { kycKind: true, fileName: true, fileUrl: true } })
      : [];
    const base = appBaseUrl();
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
    const items = docs.map((d) => {
      const url = typeof d.fileUrl === 'string' && d.fileUrl.startsWith('/') ? base + d.fileUrl : (d.fileUrl || '#');
      const label = d.kycKind ? d.kycKind.replace(/_/g, ' ') : (d.fileName || 'KYC document');
      return `<li><a href="${esc(url)}" target="_blank" rel="noreferrer">📄 ${esc(label)}</a>${d.fileName ? ` <span class="f">— ${esc(d.fileName)}</span>` : ''}</li>`;
    }).join('');
    const name = esc(vendor?.name || 'Vendor');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KYC — ${name}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 18px;color:#0f172a}h1{font-size:18px;color:#052379}ul{line-height:2.2;padding-left:18px}a{color:#1d4ed8;text-decoration:none}a:hover{text-decoration:underline}.f{color:#94a3b8;font-size:13px}.n{color:#64748b}</style></head>
<body><h1>KYC documents — ${name}</h1>${docs.length ? `<ul>${items}</ul>` : '<p class="n">No KYC documents on file for this vendor.</p>'}</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
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
    res.json({ vendor: maskFinancials({ ...vendor, kycStatus: kycStatus(vendor.kycDocs) }, req.account) });
  })
);

router.patch(
  '/:id',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    const body = vendorSchema.partial().parse(req.body);
    const vendor = await prisma.vendor.update({
      where: { id: req.params.id },
      data: toVendorData(body as z.infer<typeof vendorSchema>),
    });
    await audit({ userId: req.user!.sub, action: 'VENDOR_UPDATE', entity: 'Vendor', entityId: vendor.id });
    res.json({ vendor });
  })
);

// DELETE /api/vendors/:id — remove a vendor (for duplicates / mistakes). Blocked
// if the vendor has any PO/WO or payment linked, so a vendor with real
// transactions can never be orphaned. A "clean" vendor also takes its own
// subordinate data (quotations, item lists, KYC docs) and site mappings with it.
router.delete(
  '/:id',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    if (!vendor) throw notFound('Vendor not found');
    const [docs, payments] = await Promise.all([
      prisma.procurementDoc.count({ where: { vendorId: vendor.id } }),
      prisma.vendorPayment.count({ where: { vendorId: vendor.id } }),
    ]);
    if (docs > 0 || payments > 0) {
      throw forbidden(`This vendor has ${docs} PO/WO${docs === 1 ? '' : 's'}${payments ? ` and ${payments} payment${payments === 1 ? '' : 's'}` : ''} linked, so it can’t be deleted. Only duplicate/unused vendors (no transactions) can be removed.`);
    }
    await prisma.vendorQuotation.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.bOQItemList.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.procurementDocument.deleteMany({ where: { vendorId: vendor.id } });
    await prisma.vendor.delete({ where: { id: vendor.id } }); // site mappings cascade
    await audit({ userId: req.user!.sub, action: 'VENDOR_DELETE', entity: 'Vendor', entityId: vendor.id, details: { name: vendor.name } });
    res.json({ ok: true });
  })
);

// ── Rate chart ───────────────────────────────────────────────────────────────
// Rates are append-only: updating a price adds a new date-ranged entry rather
// than overwriting the old one, so PO history stays explicable.

router.get(
  '/:id/rates',
  requirePage('vendors'),
  asyncHandler(async (req, res) => {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { rateChart: true } });
    if (!vendor) throw notFound('Vendor not found');
    const rateChart = normalizeRateChart(vendor.rateChart);
    // ?item= returns the rate in force today for that item (PO auto-suggest).
    const item = typeof req.query.item === 'string' ? req.query.item : undefined;
    res.json({
      rates: rateChart,
      ...(item && { suggested: rateFor(rateChart, item), history: rateChart.filter((r) => r.itemDescription.toLowerCase().trim() === item.toLowerCase().trim()) }),
    });
  })
);

// POST /api/vendors/:id/rates — add a rate entry (a price change is a new row).
router.post(
  '/:id/rates',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    const entry = rateSchema.parse(req.body);
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { rateChart: true } });
    if (!vendor) throw notFound('Vendor not found');

    const existing = normalizeRateChart(vendor.rateChart);
    const [added] = normalizeRateChart([entry]);
    if (!added) throw badRequest('Invalid rate entry.');

    // Close out the previous open-ended rate for the same item, so the two
    // windows don't overlap and rateFor() stays unambiguous.
    const key = added.itemDescription.toLowerCase().trim();
    const rateChart = existing.map((r) =>
      r.itemDescription.toLowerCase().trim() === key && !r.effectiveTo && added.effectiveFrom
        ? { ...r, effectiveTo: added.effectiveFrom }
        : r
    );
    rateChart.push(added);

    await prisma.vendor.update({ where: { id: req.params.id }, data: { rateChart: rateChart as unknown as object } });
    await audit({ userId: req.user!.sub, action: 'VENDOR_RATE_ADD', entity: 'Vendor', entityId: req.params.id, details: { item: added.itemDescription, rate: added.rate } });
    res.status(201).json({ rates: rateChart });
  })
);

// DELETE a rate entry. Kept for typo correction — a genuine price change should
// POST a new dated entry instead of deleting history.
router.delete(
  '/:id/rates/:rateId',
  requireEdit('vendors'),
  asyncHandler(async (req, res) => {
    const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { rateChart: true } });
    if (!vendor) throw notFound('Vendor not found');
    const rateChart = normalizeRateChart(vendor.rateChart).filter((r) => r.id !== req.params.rateId);
    await prisma.vendor.update({ where: { id: req.params.id }, data: { rateChart: rateChart as unknown as object } });
    await audit({ userId: req.user!.sub, action: 'VENDOR_RATE_DELETE', entity: 'Vendor', entityId: req.params.id, details: { rateId: req.params.rateId } });
    res.json({ rates: rateChart });
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
