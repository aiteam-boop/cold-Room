import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { audit } from '../lib/audit';
import { renderPackingListPdf } from '../services/procurementPdf';
import { packingListShape, signedDocsFor, invoiceDocsFor, GRN_INVOICE_TYPE } from './procurement';
import { uploadPdf, upload } from '../middleware/upload';
import { SIGNED_TYPE } from '../services/grnReminders';

// ── Public, no-login Goods-Receipt form (Amisha interview 63/64, Phase 2) ──────
// A site engineer receives a share link `/grn/:token` by email when the office
// assigns a goods receipt to them. The 24-byte random token IS the credential —
// there is no auth here, so this router is mounted OUTSIDE the requireAuth chain.
// The engineer records what actually arrived (vehicle, dates, e-way bill,
// received qty per item) and marks it completed, which locks the record.
const router = Router();

const parseJson = (s: string | null | undefined, fallback: unknown) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };


async function findByToken(token: string) {
  return prisma.goodsReceipt.findFirst({
    where: { linkToken: token },
    include: {
      lineItems: { orderBy: { srNo: 'asc' } },
      doc: { select: { docNumber: true, type: true } },
      project: { select: { name: true, clientName: true, siteLocation: true, clientPoNumber: true } },
    },
  });
}

// Only the fields the site engineer needs — deliberately NO rupee values (the
// PO/payment amounts stay inside the authenticated app, not on a public link).
function publicSerialize(gr: any, signedDocs: any[] = [], invoiceDocs: any[] = []) {
  return {
    id: gr.id,
    grnNumber: gr.grnNumber,
    status: gr.status,
    mode: gr.mode,
    vendorName: gr.vendorName,
    siteAddress: gr.siteAddress,
    vehicleNumber: gr.vehicleNumber,
    vehicleSize: gr.vehicleSize,
    invoiceNumber: gr.invoiceNumber,
    ewayBillNumber: gr.ewayBillNumber,
    dispatchDate: gr.dispatchDate,
    deliveryDate: gr.deliveryDate,
    remarks: gr.remarks,
    siteSupervisor: gr.siteSupervisor,
    packingListNo: gr.packingListNo,
    photoUrl: gr.photoUrl,
    billingConfirmedAt: gr.billingConfirmedAt,
    customColumns: parseJson(gr.customColumns, []),
    doc: gr.doc,
    project: gr.project,
    signedDocs,
    invoiceDocs,
    lineItems: (gr.lineItems || []).map((l: any) => ({
      id: l.id,
      srNo: l.srNo,
      description: l.description,
      uom: l.uom ?? null,
      poQty: l.poQty,
      previouslyReceivedQty: l.previouslyReceivedQty,
      remainingToReceive: Math.max((l.poQty || 0) - (l.previouslyReceivedQty || 0), 0),
      receiptQty: l.receiptQty,
      defectQty: l.defectQty,
      acceptedQty: l.acceptedQty,
      photoUrl: l.photoUrl,
      customValues: parseJson(l.customValues, {}),
      remarks: l.remarks,
    })),
  };
}

// GET /:token — load the goods receipt the engineer must fill.
router.get('/:token', asyncHandler(async (req, res) => {
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  res.json({ goodsReceipt: publicSerialize(gr, await signedDocsFor(gr.grnNumber), await invoiceDocsFor(gr.grnNumber)) });
}));

// GET /:token/pdf — download the packing-list PDF (the engineer prints/signs it).
router.get('/:token/pdf', asyncHandler(async (req, res) => {
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="PackingList-${gr.grnNumber}.pdf"`);
  renderPackingListPdf(packingListShape(gr), res);
}));

// The engineer edits delivery fields + received qty. Columns (the packing-list
// structure) are set by the office and are NOT accepted from the public link.
const updateSchema = z.object({
  vehicleNumber: z.string().nullable().optional(),
  vehicleSize: z.string().nullable().optional(),
  invoiceNumber: z.string().nullable().optional(),
  dispatchDate: z.string().nullable().optional(),
  deliveryDate: z.string().nullable().optional(),
  ewayBillNumber: z.string().nullable().optional(),
  remarks: z.string().nullable().optional(),
  siteSupervisor: z.string().nullable().optional(),
  packingListNo: z.coerce.number().int().nullable().optional(),
  lineItems: z.array(z.object({
    id: z.string().optional(),
    description: z.string().optional(),
    customValues: z.any().optional(),
    receiptQty: z.coerce.number().catch(0),
    defectQty: z.coerce.number().nullable().optional(),
    remarks: z.string().nullable().optional(),
  })).optional(),
});

// PATCH /:token — save progress (mirrors the office edit, keyed by token).
router.patch('/:token', asyncHandler(async (req, res) => {
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  if (gr.status !== 'DRAFT') throw badRequest('This goods receipt is already submitted and locked.');
  const b = updateSchema.parse(req.body);

  if (b.lineItems && gr.mode === 'CUSTOM') {
    // Full sync — the engineer may add/remove rows on a packing list.
    const keepIds = b.lineItems.filter((l) => l.id).map((l) => l.id!);
    if (keepIds.length) await prisma.goodsReceiptLine.deleteMany({ where: { grId: gr.id, id: { notIn: keepIds } } });
    else await prisma.goodsReceiptLine.deleteMany({ where: { grId: gr.id } });
    let sr = 0;
    for (const l of b.lineItems) {
      const accepted = Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0);
      const data = { srNo: ++sr, description: l.description ?? '', customValues: l.customValues != null ? JSON.stringify(l.customValues) : null, receiptQty: Number(l.receiptQty) || 0, defectQty: Number(l.defectQty) || 0, acceptedQty: accepted, remarks: l.remarks ?? undefined };
      if (l.id) await prisma.goodsReceiptLine.update({ where: { id: l.id }, data });
      else await prisma.goodsReceiptLine.create({ data: { ...data, grId: gr.id } });
    }
  } else if (b.lineItems) {
    // DIRECT — the PO lines are fixed; only received/defect/remarks are edited.
    for (const l of b.lineItems) {
      if (!l.id) continue;
      const accepted = Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0);
      await prisma.goodsReceiptLine.update({ where: { id: l.id }, data: { receiptQty: Number(l.receiptQty) || 0, defectQty: Number(l.defectQty) || 0, acceptedQty: accepted, remarks: l.remarks ?? undefined } });
    }
  }

  const updated = await prisma.goodsReceipt.update({
    where: { id: gr.id },
    data: {
      vehicleNumber: b.vehicleNumber ?? undefined,
      vehicleSize: b.vehicleSize ?? undefined,
      invoiceNumber: b.invoiceNumber ?? undefined,
      ewayBillNumber: b.ewayBillNumber ?? undefined,
      remarks: b.remarks ?? undefined,
      siteSupervisor: b.siteSupervisor ?? undefined,
      dispatchDate: b.dispatchDate ? new Date(b.dispatchDate) : (b.dispatchDate === null ? null : undefined),
      deliveryDate: b.deliveryDate ? new Date(b.deliveryDate) : (b.deliveryDate === null ? null : undefined),
      ...(b.packingListNo !== undefined && { packingListNo: b.packingListNo }),
    },
    include: {
      lineItems: { orderBy: { srNo: 'asc' } },
      doc: { select: { docNumber: true, type: true } },
      project: { select: { name: true, clientName: true, siteLocation: true, clientPoNumber: true } },
    },
  });
  res.json({ goodsReceipt: publicSerialize(updated) });
}));

// POST /:token/lines/:lineId/photo — attach the per-item delivery photo (B5).
// Camera or gallery image from the mobile form. Only while the GR is a DRAFT.
router.post('/:token/lines/:lineId/photo', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Please attach a photo.');
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  if (gr.status !== 'DRAFT') throw badRequest('This goods receipt is already submitted and locked.');
  const line = gr.lineItems.find((l) => l.id === req.params.lineId);
  if (!line) throw notFound('Line not found on this goods receipt.');
  const fileUrl = `/uploads/${req.file.filename}`;
  await prisma.goodsReceiptLine.update({ where: { id: line.id }, data: { photoUrl: fileUrl } });
  res.status(201).json({ ok: true, photoUrl: fileUrl });
}));

// POST /:token/invoice — the engineer uploads the vendor invoice(s) WHILE filling
// the GRN, to cross-check the received quantities. PDF OR image; multiple allowed.
router.post('/:token/invoice', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Please attach the invoice (PDF or image).');
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  if (gr.status !== 'DRAFT') throw badRequest('This goods receipt is already submitted and locked.');
  const fileUrl = `/uploads/${req.file.filename}`;
  await prisma.procurementDocument.create({ data: { projectId: gr.projectId, type: GRN_INVOICE_TYPE, fileName: req.file.originalname, fileUrl, linkedDocNumber: gr.grnNumber, vendorName: gr.vendorName, mimeType: req.file.mimetype } });
  await audit({ projectId: gr.projectId, action: 'GOODS_RECEIPT_INVOICE_UPLOAD_PUBLIC', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber, fileName: req.file.originalname, via: 'site-engineer-link' } });
  res.status(201).json({ ok: true, invoiceDocs: await invoiceDocsFor(gr.grnNumber) });
}));

// POST /:token/submit — the engineer confirms delivery; the record is locked.
// `submittedAt` starts the daily "signed packing list pending" reminder clock.
router.post('/:token/submit', asyncHandler(async (req, res) => {
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  if (gr.status !== 'DRAFT') throw badRequest('This goods receipt is already submitted.');
  // B5: a photo is COMPULSORY for every item that actually arrived (receiptQty > 0)
  // — strict enforcement with site staff. Lines with nothing received are exempt.
  const missing = gr.lineItems.filter((l) => (l.receiptQty || 0) > 0 && !l.photoUrl);
  if (missing.length) throw badRequest(`Add a delivery photo for every received item before submitting. Missing on ${missing.length} item(s) (Sr. ${missing.map((l) => l.srNo).join(', ')}).`);
  const updated = await prisma.goodsReceipt.update({ where: { id: gr.id }, data: { status: 'RECEIVED', submittedAt: new Date() } });
  await audit({ projectId: gr.projectId, action: 'GOODS_RECEIPT_SUBMIT_PUBLIC', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber, via: 'site-engineer-link', siteEngineerEmail: gr.siteEngineerEmail } });
  res.json({ ok: true, goodsReceipt: publicSerialize({ ...gr, ...updated, lineItems: gr.lineItems, doc: gr.doc, project: gr.project }) });
}));

// POST /:token/signed — the engineer uploads the signed & stamped packing list.
// HARD requirement: PDF only (uploadPdf filters non-PDFs). Multiple allowed.
router.post('/:token/signed', uploadPdf.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Please attach a PDF. Only PDF files are accepted for the signed packing list.');
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  if (gr.status !== 'RECEIVED') throw badRequest('Please mark the goods receipt completed first, then upload the signed packing list.');
  const fileUrl = `/uploads/${req.file.filename}`;
  await prisma.procurementDocument.create({ data: { projectId: gr.projectId, type: SIGNED_TYPE, fileName: req.file.originalname, fileUrl, linkedDocNumber: gr.grnNumber, vendorName: gr.vendorName, mimeType: req.file.mimetype } });
  await audit({ projectId: gr.projectId, action: 'GOODS_RECEIPT_SIGNED_UPLOAD_PUBLIC', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber, fileName: req.file.originalname, via: 'site-engineer-link' } });
  res.status(201).json({ ok: true, signedDocs: await signedDocsFor(gr.grnNumber) });
}));

// POST /:token/confirm-billing — confirm material received & close the GRN from
// the public link. Same guards as the office endpoint; needs a signed copy first.
router.post('/:token/confirm-billing', asyncHandler(async (req, res) => {
  const gr = await findByToken(req.params.token);
  if (!gr) throw notFound('This link is invalid or has expired.');
  if (gr.status !== 'RECEIVED') throw badRequest('Please mark the goods receipt completed first.');
  if (gr.billingConfirmedAt) throw badRequest('This goods receipt is already confirmed.');
  const signedCount = await prisma.procurementDocument.count({ where: { type: SIGNED_TYPE, linkedDocNumber: gr.grnNumber, archived: false } });
  if (signedCount === 0) throw badRequest('Upload the signed packing list before confirming.');
  const updated = await prisma.goodsReceipt.update({ where: { id: gr.id }, data: { billingConfirmedAt: new Date() } });
  await audit({ projectId: gr.projectId, action: 'GOODS_RECEIPT_BILLING_CONFIRM_PUBLIC', entity: 'GoodsReceipt', entityId: gr.id, details: { grnNumber: gr.grnNumber, via: 'site-engineer-link' } });
  res.json({ ok: true, goodsReceipt: publicSerialize({ ...gr, ...updated }, await signedDocsFor(gr.grnNumber)) });
}));

export default router;
