import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { COMPANY } from './procurement';

// pdfkit's built-in Helvetica lacks the ₹ glyph; use "Rs." for reliable output.
const INR = (n: number | null | undefined) => (n == null ? '' : 'Rs. ' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

function assetPath(names: string[]): string | null {
  const dirs = [path.resolve(process.cwd(), '../client/public'), path.resolve(process.cwd(), 'assets')];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p)) return p; }
  return null;
}
const logoPath = () => assetPath(['logo.png', 'logo.jpg', 'logo.jpeg', 'crystal-logo.png', 'crystal-logo.jpg']);
const signPath = () => assetPath(['signature.png', 'signature.jpg', 'signature.jpeg', 'akash-signature.png']);

interface DocForPdf {
  type: string; docNumber: string; status: string; docDate: Date;
  vendorName?: string | null; vendorAddress?: string | null; vendorGstin?: string | null;
  vendorContact?: string | null; vendorPhone?: string | null;
  againstQuotation?: string | null; invoiceTo?: string | null; shipTo?: string | null; siteAddress?: string | null;
  basicAmount: number; gstEnabled: boolean; gstPct: number; gstAmount: number; finalAmount: number;
  esignApplied: boolean;
  lineItems: { srNo: number; description: string; uom?: string | null; qty: number; unitPrice: number; totalPrice: number; isLeadTime: boolean; leadTimeText?: string | null }[];
  termsSections: { title: string; text: string }[];
}

const BORDER = '#000000';
const HEAD_BG = '#0f2942';

// Renders a PO/WO into the exact Quatre Agro bordered grid format.
export function renderProcurementPdf(doc: DocForPdf, stream: NodeJS.WritableStream) {
  const isWO = doc.type === 'WO';
  const pdf = new PDFDocument({ size: 'A4', margin: 24 });
  pdf.pipe(stream);
  const L = 24, R = pdf.page.width - 24, W = R - L;
  const PAGE_BOTTOM = pdf.page.height - 30;

  const line = (x1: number, y1: number, x2: number, y2: number) => pdf.lineWidth(0.6).moveTo(x1, y1).lineTo(x2, y2).stroke(BORDER);
  const rect = (x: number, y: number, w: number, h: number) => pdf.lineWidth(0.6).rect(x, y, w, h).stroke(BORDER);
  // Draw text inside a box with padding; returns the text height used.
  const cell = (x: number, y: number, w: number, text: string, opts: { font?: string; size?: number; align?: 'left' | 'right' | 'center'; color?: string; pad?: number } = {}) => {
    const pad = opts.pad ?? 3;
    pdf.font(opts.font || 'Helvetica').fontSize(opts.size || 8).fillColor(opts.color || '#111111');
    pdf.text(text || '', x + pad, y + pad, { width: w - pad * 2, align: opts.align || 'left' });
    return pdf.heightOfString(text || '', { width: w - pad * 2 });
  };
  const textH = (text: string, w: number, size = 8, pad = 3) => { pdf.fontSize(size); return pdf.heightOfString(text || ' ', { width: w - pad * 2 }); };

  let y = L;

  // ── Header band: company (left) + logo (right) ──
  const logoW = 96, headH = 52;
  const compW = W - logoW;
  rect(L, y, compW, headH); rect(L + compW, y, logoW, headH);
  cell(L, y + 3, compW, COMPANY.name, { font: 'Helvetica-Bold', size: 11, color: HEAD_BG });
  cell(L, y + 17, compW, COMPANY.address, { size: 7.5, color: '#222' });
  cell(L, y + 35, compW, `Email: ${COMPANY.email} | web: ${COMPANY.web}`, { size: 7.5, color: '#1d4ed8' });
  const logo = logoPath();
  if (logo) { try { pdf.image(logo, L + compW + (logoW - 46) / 2, y + 3, { fit: [46, 46] }); } catch { /* ignore */ } }
  else { pdf.font('Helvetica-Bold').fontSize(13).fillColor('#111').text('Crystal', L + compW, y + 18, { width: logoW, align: 'center' }); }
  y += headH;

  // ── Title bar ──
  const titleH = 16;
  pdf.rect(L, y, W, titleH).fillAndStroke('#e9eef5', BORDER);
  pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(HEAD_BG).text(isWO ? 'Work Order' : 'Purchase Order', L, y + 4, { width: W, align: 'center' });
  y += titleH;

  // ── To (vendor) + Date / No / Against Quotation ──
  const rightW = 168, leftW = W - rightW;
  // "To," is a single typed block (vendorAddress). Fall back to the legacy
  // separate fields for older documents.
  const vendorBlock = (doc.vendorAddress && doc.vendorAddress.trim())
    ? doc.vendorAddress
    : [doc.vendorName, doc.vendorContact, doc.vendorPhone, doc.vendorGstin ? `GSTIN : ${doc.vendorGstin}` : ''].filter(Boolean).join('\n');
  const toH = textH('To,', leftW, 8);
  const blockH = Math.max(6 + toH + textH(vendorBlock || ' ', leftW, 8), 90);
  rect(L, y, leftW, blockH);
  cell(L, y + 3, leftW, 'To,', { font: 'Helvetica-Bold', size: 8 });
  cell(L, y + 3 + toH, leftW, vendorBlock, { font: 'Helvetica', size: 8 });
  // right: three stacked cells
  const cH = blockH / 3;
  rect(L + leftW, y, rightW, cH); rect(L + leftW, y + cH, rightW, cH); rect(L + leftW, y + 2 * cH, rightW, blockH - 2 * cH);
  cell(L + leftW, y + cH / 2 - 5, rightW, `Date : ${doc.docDate.toLocaleDateString('en-GB')}`, { size: 8, align: 'center', font: 'Helvetica-Bold' });
  cell(L + leftW, y + cH + cH / 2 - 5, rightW, `${isWO ? 'WO' : 'PO'} No.: ${doc.docNumber}`, { size: 8, align: 'center', font: 'Helvetica-Bold' });
  cell(L + leftW, y + 2 * cH + 3, rightW, `Against Quotation:\n${doc.againstQuotation || ''}`, { size: 7.5, align: 'center', font: 'Helvetica-Bold' });
  y += blockH;

  // ── Invoice To | Ship To ──
  const halfW = W / 2;
  const invText = doc.invoiceTo || COMPANY.invoiceTo;
  const shipText = (isWO ? doc.siteAddress : doc.shipTo) || '';
  const ivH = Math.max(textH(invText, halfW, 7.5), textH(shipText, halfW, 7.5)) + 16;
  rect(L, y, halfW, ivH); rect(L + halfW, y, halfW, ivH);
  cell(L, y + 2, halfW, 'Invoice To:', { font: 'Helvetica-Bold', size: 8 });
  cell(L, y + 12, halfW, invText, { size: 7.5 });
  cell(L + halfW, y + 2, halfW, isWO ? 'Site Address:' : 'Ship To:', { font: 'Helvetica-Bold', size: 8 });
  cell(L + halfW, y + 12, halfW, shipText, { size: 7.5 });
  y += ivH;

  // ── Line items table (with UOM column) ──
  const cols = [
    { k: 'sr', t: 'Sr No.', w: 28, align: 'center' as const },
    { k: 'desc', t: 'Description', w: W - 28 - 42 - 38 - 66 - 78, align: 'left' as const },
    { k: 'uom', t: 'UOM', w: 42, align: 'center' as const },
    { k: 'qty', t: 'Qty', w: 38, align: 'center' as const },
    { k: 'rate', t: 'Unit Price', w: 66, align: 'right' as const },
    { k: 'amt', t: 'Total Price', w: 78, align: 'right' as const },
  ];
  const colX = (i: number) => L + cols.slice(0, i).reduce((s, c) => s + c.w, 0);

  const drawHead = () => {
    const hh = 16;
    pdf.rect(L, y, W, hh).fillAndStroke(HEAD_BG, BORDER);
    cols.forEach((c, i) => { pdf.font('Helvetica-Bold').fontSize(7.5).fillColor('white').text(c.t, colX(i) + 2, y + 5, { width: c.w - 4, align: c.align }); });
    // vertical separators
    let vx = L; for (const c of cols) { vx += c.w; if (vx < R) line(vx, y, vx, y + hh); }
    y += hh;
  };
  drawHead();

  for (const it of doc.lineItems) {
    if (it.isLeadTime) {
      const h = 14;
      if (y + h > PAGE_BOTTOM) { pdf.addPage(); y = L; drawHead(); }
      rect(L, y, W, h);
      cell(colX(1), y, W - cols[0].w, `Lead Time: ${it.leadTimeText || ''}`, { size: 7.5, color: '#6d28d9', font: 'Helvetica-Oblique' });
      y += h; continue;
    }
    const descH = textH(it.description, cols[1].w, 7.5);
    const rowH = Math.max(descH + 6, 18);
    if (y + rowH > PAGE_BOTTOM) { pdf.addPage(); y = L; drawHead(); }
    rect(L, y, W, rowH);
    let vx = L; for (const c of cols) { vx += c.w; if (vx < R) line(vx, y, vx, y + rowH); }
    cell(colX(0), y, cols[0].w, String(it.srNo), { size: 7.5, align: 'center' });
    cell(colX(1), y, cols[1].w, it.description, { size: 7.5 });
    cell(colX(2), y, cols[2].w, it.uom || '', { size: 7.5, align: 'center' });
    cell(colX(3), y, cols[3].w, it.qty ? it.qty.toLocaleString('en-IN') : '', { size: 7.5, align: 'center' });
    cell(colX(4), y, cols[4].w, it.unitPrice ? INR(it.unitPrice) : '', { size: 7.5, align: 'right' });
    cell(colX(5), y, cols[5].w, it.totalPrice ? INR(it.totalPrice) : '', { size: 7.5, align: 'right' });
    y += rowH;
  }

  // ── Totals (right-aligned bordered rows) ──
  const totLabelX = colX(4), totLabelW = cols[4].w, totValW = cols[5].w;
  const totRow = (label: string, val: string, bold = false) => {
    const h = 15;
    if (y + h > PAGE_BOTTOM) { pdf.addPage(); y = L; }
    rect(totLabelX, y, totLabelW, h); rect(totLabelX + totLabelW, y, totValW, h);
    cell(totLabelX, y + 3, totLabelW, label, { font: 'Helvetica-Bold', size: 8, align: 'right', color: HEAD_BG });
    cell(totLabelX + totLabelW, y + 3, totValW, val, { font: 'Helvetica-Bold', size: 8, align: 'right', color: HEAD_BG });
    y += h;
  };
  totRow('Basic Amount', INR(doc.basicAmount));
  if (doc.gstEnabled) totRow(`GST ${doc.gstPct}%`, INR(doc.gstAmount));
  totRow('Final Amount', INR(doc.finalAmount));
  y += 6;

  // ── Terms & Conditions ──
  if (y + 30 > PAGE_BOTTOM) { pdf.addPage(); y = L; }
  pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(HEAD_BG).text('TERMS & CONDITIONS', L, y, { width: W, align: 'center' });
  y = pdf.y + 4;
  for (const s of doc.termsSections) {
    const titleHt = textH(s.title, W, 8.5);
    const bodyHt = textH(s.text, W, 8);
    if (y + titleHt + bodyHt + 8 > PAGE_BOTTOM) { pdf.addPage(); y = L; }
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor('#111').text(s.title, L, y, { width: W });
    y = pdf.y;
    pdf.font('Helvetica').fontSize(8).fillColor('#333').text(s.text, L, y, { width: W });
    y = pdf.y + 6;
  }

  // ── Signature block (bordered, 2 cells) ──
  const sigH = 86;
  if (y + sigH > PAGE_BOTTOM) { pdf.addPage(); y = L; }
  y += 6;
  rect(L, y, halfW, sigH); rect(L + halfW, y, halfW, sigH);
  cell(L, y + 4, halfW, COMPANY.name, { font: 'Helvetica-Bold', size: 8.5 });
  if (doc.esignApplied) {
    const sig = signPath();
    const sigFont = assetPath(['Signature-Font.ttf', 'GreatVibes-Regular.ttf']);
    if (sig) { try { pdf.image(sig, L + 8, y + 18, { fit: [160, 46] }); } catch { /* ignore */ } }
    else if (sigFont) { try { pdf.registerFont('Signature', sigFont); pdf.font('Signature').fontSize(30).fillColor('#1d3a8a').text(COMPANY.signatoryName, L + 10, y + 20); } catch { pdf.font('Helvetica-Oblique').fontSize(20).fillColor('#1d3a8a').text(COMPANY.signatoryName, L + 8, y + 26); } }
    else { pdf.font('Helvetica-Oblique').fontSize(20).fillColor('#1d3a8a').text(COMPANY.signatoryName, L + 8, y + 26); }
    pdf.font('Helvetica');
  }
  cell(L, y + sigH - 26, halfW, COMPANY.signatoryName, { font: 'Helvetica-Bold', size: 8.5 });
  cell(L, y + sigH - 15, halfW, COMPANY.signatoryDesignation, { size: 8.5 });
  cell(L + halfW, y + 4, halfW, isWO ? 'For Vendor' : 'For Supplier', { font: 'Helvetica-Bold', size: 8.5 });
  cell(L + halfW, y + 22, halfW, 'Name:', { size: 8 });
  cell(L + halfW, y + 36, halfW, 'Designation:', { size: 8 });
  cell(L + halfW, y + 50, halfW, 'Date:', { size: 8 });
  cell(L + halfW, y + 64, halfW, 'Sign and Stamp:', { size: 8 });

  pdf.end();
}

// ── GRN PDF (kept simple, bordered header + table) ──
interface GRNForPdf {
  grnNumber: string; grnDate: Date; docNumber: string; vendorName?: string | null; siteAddress?: string | null;
  vehicleNumber?: string | null; driverName?: string | null; deliveryChallanNumber?: string | null;
  invoiceNumber?: string | null; invoiceDate?: Date | null; invoiceValue?: number | null; ewayBillNumber?: string | null;
  lineItems: { srNo: number; description: string; uom?: string | null; poQty: number; previouslyReceivedQty: number; receiptQty: number; defectQty: number; acceptedQty: number; remarks?: string | null }[];
}
export function renderGRNPdf(grn: GRNForPdf, stream: NodeJS.WritableStream) {
  const pdf = new PDFDocument({ size: 'A4', margin: 28 });
  pdf.pipe(stream);
  const W = pdf.page.width, L = 28, R = W - 28, tableW = R - L;
  const logo = logoPath();
  if (logo) { try { pdf.image(logo, R - 70, 28, { fit: [60, 36] }); } catch { /* ignore */ } }
  pdf.fillColor(HEAD_BG).font('Helvetica-Bold').fontSize(14).text(COMPANY.name, L, 30, { width: W - 130 });
  pdf.font('Helvetica').fontSize(8).fillColor('#334155').text(COMPANY.address, { width: W - 130 });
  pdf.moveDown(0.6);
  pdf.font('Helvetica-Bold').fontSize(13).fillColor(HEAD_BG).text('Good Receipt Note (GRN)', { width: tableW, align: 'center' });
  pdf.font('Helvetica').fontSize(8).fillColor('#334155').text(`GRN No.: ${grn.grnNumber}    Date: ${grn.grnDate.toLocaleDateString('en-GB')}    Against: ${grn.docNumber}`, { width: tableW, align: 'center' });
  pdf.moveDown(0.8);
  pdf.fontSize(8).fillColor('#111');
  pdf.text(`Vendor / Contractor: ${grn.vendorName || '-'}`);
  pdf.text(`Site Address: ${grn.siteAddress || '-'}`, { width: tableW });
  pdf.text(`Vehicle: ${grn.vehicleNumber || '-'}    Driver: ${grn.driverName || '-'}    DC No.: ${grn.deliveryChallanNumber || '-'}`);
  pdf.moveDown(0.5);
  const cols = [{ t: 'Sr', w: 22 }, { t: 'Description', w: 198 }, { t: 'UOM', w: 38 }, { t: 'PO Qty', w: 46 }, { t: 'Prev', w: 44 }, { t: 'Receipt', w: 48 }, { t: 'Defect', w: 44 }, { t: 'Accepted', w: 55 }];
  let yy = pdf.y;
  pdf.rect(L, yy, tableW, 15).fillAndStroke(HEAD_BG, BORDER); pdf.font('Helvetica-Bold').fontSize(7.5).fillColor('white');
  let x = L; for (const c of cols) { pdf.text(c.t, x + 2, yy + 4, { width: c.w - 4 }); x += c.w; }
  pdf.y = yy + 15; pdf.fillColor('#111').font('Helvetica').fontSize(7.5);
  for (const it of grn.lineItems) {
    const yr = pdf.y + 2; x = L;
    const vals = [String(it.srNo), it.description, it.uom || '', String(it.poQty), String(it.previouslyReceivedQty), String(it.receiptQty), String(it.defectQty), String(it.acceptedQty)];
    const dH = pdf.heightOfString(it.description, { width: cols[1].w - 4 });
    cols.forEach((c, i) => { pdf.text(vals[i], x + 2, yr, { width: c.w - 4, align: i <= 1 ? 'left' : 'right' }); x += c.w; });
    pdf.y = yr + Math.max(dH + 3, 13);
    pdf.lineWidth(0.5).moveTo(L, pdf.y).lineTo(R, pdf.y).stroke('#cbd5e1');
  }
  pdf.moveDown(0.6);
  pdf.font('Helvetica-Bold').fontSize(9).fillColor(HEAD_BG).text('Invoice Details');
  pdf.font('Helvetica').fontSize(8).fillColor('#111').text(`Invoice No.: ${grn.invoiceNumber || '-'}    Date: ${grn.invoiceDate ? grn.invoiceDate.toLocaleDateString('en-GB') : '-'}    Value: ${INR(grn.invoiceValue)}    E-Way Bill: ${grn.ewayBillNumber || '-'}`, { width: tableW });
  pdf.moveDown(2.5);
  pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(HEAD_BG).text(COMPANY.name, L);
  pdf.font('Helvetica').fontSize(8).fillColor('#111').text('Authorized Signatory', L, pdf.y + 16);
  pdf.end();
}
