import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { COMPANY, strikeOffFootnote } from './procurement';
import type { TermsSection } from './procurement';

// Collect a PDF renderer's streamed output into a single Buffer — used to attach
// the generated PO/WO/GRN PDF to an approval email.
export function renderToBuffer(render: (stream: NodeJS.WritableStream) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const s = new PassThrough();
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
    try { render(s); } catch (e) { reject(e); }
  });
}

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
  promisedDeliveryDate?: Date | null;
  basicAmount: number; gstEnabled: boolean; gstPct: number; gstAmount: number; finalAmount: number;
  esignApplied: boolean;
  lineItems: { srNo: number; description: string; uom?: string | null; qty: number; unitPrice: number; totalPrice: number; isLeadTime: boolean; gstExempt?: boolean; gstExemptRemark?: string | null; gstPct?: number | null; leadTimeText?: string | null; customValues?: string | Record<string, string> | null; boqHead?: string | null; boqItemName?: string | null }[];
  customColumns?: string | { key: string; label: string }[] | null;
  termsSections: TermsSection[];
  // Approval trail printed under the signature once the document is e-signed:
  // who approved, when, and their remark. In chain order (final approver last).
  approvals?: { name: string; role?: string | null; at?: Date | string | null; remarks?: string | null }[];
}

const asJson = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

const BORDER = '#000000';
const HEAD_BG = '#0f2942';

// Renders a PO/WO into the exact Quatre Agro bordered grid format.
// `opts.internal` prints the INTERNAL copy: each line also shows its BOQ head +
// linked BOQ item (under the description). The vendor copy (default) is unchanged.
// `opts.internalMarker` (default true) prints the red "INTERNAL COPY" banner — the
// approver-review copy sets it false (internal content, but no vendor-warning
// marker, since it's a review not a distribution).
export function renderProcurementPdf(doc: DocForPdf, stream: NodeJS.WritableStream, opts: { internal?: boolean; internalMarker?: boolean } = {}) {
  const isWO = doc.type === 'WO';
  // Document title/label by type (Transport Order reuses the PO layout).
  const longLabel = doc.type === 'WO' ? 'Work Order' : doc.type === 'TO' ? 'Transport Order' : 'Purchase Order';
  const shortLabel = doc.type === 'WO' ? 'WO' : doc.type === 'TO' ? 'TO' : 'PO';
  const internal = !!opts.internal;
  const internalMarker = internal && opts.internalMarker !== false;
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
  pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(HEAD_BG).text(longLabel, L, y + 4, { width: W, align: 'center' });
  // Internal DOWNLOAD copy gets a clear red marker so it can never be mistaken for
  // the vendor copy. The approver-review copy skips it (internalMarker=false).
  if (internalMarker) pdf.font('Helvetica-Bold').fontSize(7).fillColor('#b91c1c').text('INTERNAL COPY — NOT FOR VENDOR', R - 168, y + 5.5, { width: 160, align: 'right' });
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
  cell(L + leftW, y + cH + cH / 2 - 5, rightW, `${shortLabel} No.: ${doc.docNumber}`, { size: 8, align: 'center', font: 'Helvetica-Bold' });
  // The delivery commitment travels on the document itself — it is the date the
  // vendor is held to, and the one "delivered on time?" is measured against.
  const deliveryLine = doc.promisedDeliveryDate
    ? `\nDelivery Date: ${doc.promisedDeliveryDate.toLocaleDateString('en-GB')}`
    : '';
  cell(L + leftW, y + 2 * cH + 3, rightW, `Against Quotation:\n${doc.againstQuotation || ''}${deliveryLine}`, { size: 7.5, align: 'center', font: 'Helvetica-Bold' });
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

  // ── Line items table (with UOM + any user-added columns) ──
  const customCols = asJson<{ key: string; label: string }[]>(doc.customColumns, []);
  const cW = 58; // width of each user-added column
  const cols = [
    { k: 'sr', t: 'Sr No.', w: 28, align: 'center' as const },
    { k: 'desc', t: 'Description', w: W - 28 - 42 - 38 - 66 - 78 - customCols.length * cW, align: 'left' as const },
    ...customCols.map((c) => ({ k: `cv:${c.key}`, t: c.label || '', w: cW, align: 'center' as const })),
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

  // Per-line GST: if every taxable line is at the same rate, the GST row shows
  // that single "GST 18%" (as before). If rates differ, the row just says "GST"
  // and each line prints its own "(GST 5%)" so the mix is legible.
  const taxLines = doc.lineItems.filter((l) => !l.isLeadTime && !l.gstExempt);
  const rateSet = new Set(taxLines.map((l) => (l.gstPct != null ? l.gstPct : doc.gstPct)));
  const uniformRate = rateSet.size === 1 ? [...rateSet][0] : null;

  for (const it of doc.lineItems) {
    if (it.isLeadTime) {
      const h = 14;
      if (y + h > PAGE_BOTTOM) { pdf.addPage(); y = L; drawHead(); }
      rect(L, y, W, h);
      cell(colX(1), y, W - cols[0].w, `Lead Time: ${it.leadTimeText || ''}`, { size: 7.5, color: '#6d28d9', font: 'Helvetica-Oblique' });
      y += h; continue;
    }
    // Full description text: base + GST suffix + (internal copy only) the BOQ
    // head/item mapping on its own line, so row height auto-grows to fit it.
    let descText = it.description;
    if (it.gstExempt) descText = `${it.description}  (No GST${it.gstExemptRemark ? ` — ${it.gstExemptRemark}` : ''})`;
    else if (uniformRate == null && doc.gstEnabled) descText = `${it.description}  (GST ${it.gstPct != null ? it.gstPct : doc.gstPct}%)`;
    if (internal) {
      // Head and BOQ Item each on their OWN line (not joined on one line).
      const metaLines = [`Head: ${it.boqHead || '—'}`, it.boqItemName ? `BOQ Item: ${it.boqItemName}` : null].filter(Boolean) as string[];
      for (const m of metaLines) descText += `\n▸ ${m}`;
    }
    const descH = textH(descText, cols[1].w, 7.5);
    const rowH = Math.max(descH + 6, 18);
    if (y + rowH > PAGE_BOTTOM) { pdf.addPage(); y = L; drawHead(); }
    rect(L, y, W, rowH);
    let vx = L; for (const c of cols) { vx += c.w; if (vx < R) line(vx, y, vx, y + rowH); }
    const cv = asJson<Record<string, string>>(it.customValues, {});
    cols.forEach((c, i) => {
      let v = '';
      if (c.k === 'sr') v = String(it.srNo);
      else if (c.k === 'desc') v = descText;
      else if (c.k === 'uom') v = it.uom || '';
      else if (c.k === 'qty') v = it.qty ? it.qty.toLocaleString('en-IN') : '';
      else if (c.k === 'rate') v = it.unitPrice ? INR(it.unitPrice) : '';
      else if (c.k === 'amt') v = it.totalPrice ? INR(it.totalPrice) : '';
      else if (c.k.startsWith('cv:')) v = cv[c.k.slice(3)] ?? '';
      cell(colX(i), y, c.w, v, { size: 7.5, align: c.align });
    });
    y += rowH;
  }

  // ── Totals (right-aligned bordered rows) — anchored to the last two columns ──
  const rateIdx = cols.length - 2;
  const totLabelX = colX(rateIdx), totLabelW = cols[rateIdx].w, totValW = cols[rateIdx + 1].w;
  const totRow = (label: string, val: string, bold = false) => {
    const h = 15;
    if (y + h > PAGE_BOTTOM) { pdf.addPage(); y = L; }
    rect(totLabelX, y, totLabelW, h); rect(totLabelX + totLabelW, y, totValW, h);
    cell(totLabelX, y + 3, totLabelW, label, { font: 'Helvetica-Bold', size: 8, align: 'right', color: HEAD_BG });
    cell(totLabelX + totLabelW, y + 3, totValW, val, { font: 'Helvetica-Bold', size: 8, align: 'right', color: HEAD_BG });
    y += h;
  };
  // GST and the grand total are shown as whole rupees ("Rs. 14,028", not
  // "Rs. 14,027.84"). Rounded here at render time so even documents saved before
  // this rule still print clean totals — no re-save required. Basic (taxable
  // value) keeps its precision.
  totRow('Basic Amount', INR(doc.basicAmount));
  if (doc.gstEnabled) totRow(uniformRate != null ? `GST ${uniformRate}%` : 'GST', INR(Math.round(doc.gstAmount)));
  totRow('Final Amount', INR(Math.round(doc.finalAmount)));
  y += 6;

  // ── Terms & Conditions — always start on their own page (annexure) ──
  // The Purchase Order sits alone on page 1; the Terms & Conditions (and the
  // signature that follows them) begin on a fresh page. So: "PO on one page,
  // T&C on another".
  //
  // A bordered box that can itself run onto further pages: it closes at the
  // bottom of each page and reopens at the top of the next so no clause is
  // clipped. A struck-off clause stays in the document — grey, lined through —
  // plus a footnote recording the mutual agreement (PRD §8.3). The PO number is
  // repeated under the heading so a detached T&C page is still identifiable.
  pdf.addPage(); y = L;
  const PAD = 8;
  const innerL = L + PAD, innerW = W - PAD * 2;
  let boxTop = 0;
  const openBox = () => { boxTop = y; y += PAD; };
  const ensureRoom = (need: number) => {
    if (y + need + PAD > PAGE_BOTTOM) {
      rect(L, boxTop, W, (y + PAD) - boxTop);
      pdf.addPage(); y = L; openBox();
    }
  };

  openBox();
  pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(HEAD_BG).text('TERMS & CONDITIONS', innerL, y, { width: innerW, align: 'center' });
  y = pdf.y + 2;
  pdf.font('Helvetica').fontSize(7.5).fillColor('#64748b').text(`${longLabel} No.: ${doc.docNumber}`, innerL, y, { width: innerW, align: 'center' });
  y = pdf.y + 6;

  for (const s of doc.termsSections) {
    const struck = s.isStruckOff === true;
    const titleHt = textH(s.title, innerW, 8.5);
    const bodyHt = textH(s.text, innerW, 8);
    ensureRoom(titleHt + bodyHt + 6);
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(struck ? '#888' : '#111')
      .text(struck ? `${s.title} *` : s.title, innerL, y, { width: innerW, strike: struck });
    y = pdf.y;
    pdf.font('Helvetica').fontSize(8).fillColor(struck ? '#999' : '#333')
      .text(s.text, innerL, y, { width: innerW, strike: struck });
    y = pdf.y + 6;
  }

  const footnote = strikeOffFootnote(doc.termsSections);
  if (footnote) {
    const ht = textH(footnote, innerW, 7.5);
    ensureRoom(ht + 2);
    pdf.font('Helvetica-Oblique').fontSize(7.5).fillColor('#666').text(footnote, innerL, y, { width: innerW });
    y = pdf.y;
    pdf.font('Helvetica');
  }

  // Close the box around all the T&C content.
  rect(L, boxTop, W, (y + PAD) - boxTop);
  y = y + PAD;

  // ── Signature block — follows the Terms & Conditions ──
  // Sits directly beneath the T&C box; if the terms filled the page it moves to
  // the next one so the sign-off is never split.
  const sigH = 86;
  if (y + sigH + 6 > PAGE_BOTTOM) { pdf.addPage(); y = L; }
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
  y += sigH;

  // ── Final-approval stamp — printed under the signature once approved ──
  // Shows each approver, the exact date & time they approved, and their remark,
  // so the signed PO carries an auditable record of who authorised it and when.
  const approvals = (doc.approvals || []).filter((a) => a.at);
  if (doc.esignApplied && approvals.length) {
    const fmtDT = (v: Date | string) => {
      const d = v instanceof Date ? v : new Date(v);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
    };
    // Measure exact heights (remarks can wrap to several lines) so nothing
    // overlaps and the box is sized to fit. Indent is done via x, NOT pad.
    const LH = 12;
    const remarkH = (r: string) => { pdf.font('Helvetica').fontSize(8); return pdf.heightOfString(`Remark: ${r}`, { width: W - 16 }); };
    let need = 20; // heading
    for (const a of approvals) { need += LH; if (a.remarks) need += remarkH(a.remarks as string) + 4; }
    need += 6;
    if (y + need + 6 > PAGE_BOTTOM) { pdf.addPage(); y = L; }
    y += 6;
    rect(L, y, W, need);
    cell(L, y + 4, W, 'FINAL APPROVAL (e-signed)', { font: 'Helvetica-Bold', size: 8.5 });
    let ly = y + 20;
    approvals.forEach((a, i) => {
      const who = `${i + 1}. ${a.name}${a.role ? ` (${a.role})` : ''}`;
      cell(L, ly, W * 0.62, who, { font: 'Helvetica-Bold', size: 8 });
      cell(L + W * 0.62, ly, W * 0.38 - 6, `Approved: ${fmtDT(a.at as Date | string)}`, { size: 8, align: 'right' });
      ly += LH;
      if (a.remarks) { pdf.font('Helvetica').fontSize(8).fillColor('#334155').text(`Remark: ${a.remarks}`, L + 10, ly, { width: W - 20 }); ly += remarkH(a.remarks as string) + 4; }
    });
    y += need;
  }

  pdf.end();
}

// ── GRN PDF (kept simple, bordered header + table) ──
interface GRNForPdf {
  grnNumber: string; grnDate: Date; docNumber: string; vendorName?: string | null; siteAddress?: string | null;
  vehicleNumber?: string | null; driverName?: string | null; deliveryChallanNumber?: string | null;
  invoiceNumber?: string | null; invoiceDate?: Date | null; invoiceValue?: number | null; ewayBillNumber?: string | null;
  // Payment side (GRN/Payment PRD v3): the PI drives the payment and arrives
  // BEFORE the tax invoice, so the approver must see it on the document.
  milestoneName?: string | null;
  piNumber?: string | null; piDate?: Date | null; piValue?: number | null;
  amountToPay?: number | null;
  paymentStatus?: string | null; utrNumber?: string | null; paidAt?: Date | null;
  lineItems: { srNo: number; description: string; uom?: string | null; poQty: number; previouslyReceivedQty: number; receiptQty: number; defectQty: number; acceptedQty: number; remarks?: string | null }[];
  // Approval trail printed under the signatory once the GRN is approved.
  approvals?: { name: string; role?: string | null; at?: Date | string | null; remarks?: string | null }[];
}
export function renderGRNPdf(grn: GRNForPdf, stream: NodeJS.WritableStream) {
  const pdf = new PDFDocument({ size: 'A4', margin: 28 });
  pdf.pipe(stream);
  const W = pdf.page.width, L = 28, R = W - 28, tableW = R - L;
  const logo = logoPath();
  if (logo) { try { pdf.image(logo, R - 70, 28, { fit: [60, 36] }); } catch { /* ignore */ } }
  pdf.fillColor(HEAD_BG).font('Helvetica-Bold').fontSize(14).text(COMPANY.name, L, 30, { width: W - 130 });
  pdf.font('Helvetica').fontSize(8).fillColor('#334155').text(COMPANY.address, { width: W - 130 });
  // This document carries a payment when it has a PI / milestone / amount — the
  // old "GRN" record is surfaced as Payment, so title and number label follow suit.
  // A pure goods receipt (no payment) keeps the classic GRN heading.
  const isPayment = !!(grn.piNumber || grn.piValue != null || grn.milestoneName || grn.amountToPay != null);
  pdf.moveDown(0.6);
  pdf.font('Helvetica-Bold').fontSize(13).fillColor(HEAD_BG).text(isPayment ? 'Payment Advice' : 'Good Receipt Note (GRN)', { width: tableW, align: 'center' });
  pdf.font('Helvetica').fontSize(8).fillColor('#334155').text(`${isPayment ? 'Payment No.' : 'GRN No.'}: ${grn.grnNumber}    Date: ${grn.grnDate.toLocaleDateString('en-GB')}    Against: ${grn.docNumber}`, { width: tableW, align: 'center' });
  pdf.moveDown(0.8);
  pdf.fontSize(8).fillColor('#111');
  pdf.text(`Vendor / Contractor: ${grn.vendorName || '-'}`);
  pdf.text(`Site Address: ${grn.siteAddress || '-'}`, { width: tableW });
  pdf.text(`Vehicle: ${grn.vehicleNumber || '-'}    Driver: ${grn.driverName || '-'}    DC No.: ${grn.deliveryChallanNumber || '-'}`);
  pdf.moveDown(0.5);
  // Short = ordered − delivered (never arrived) — kept DISTINCT from Defect
  // (arrived but damaged). Amisha/Akash B2: "Defect aur short dono alag-alag."
  const cols = [{ t: 'Sr', w: 22 }, { t: 'Description', w: 210 }, { t: 'UOM', w: 36 }, { t: 'PO Qty', w: 44 }, { t: 'Prev', w: 40 }, { t: 'Receipt', w: 46 }, { t: 'Defect', w: 42 }, { t: 'Accepted', w: 52 }, { t: 'Short', w: 47 }];
  let yy = pdf.y;
  // Quantity columns are centre-aligned — AA sir asked for this explicitly
  // (Sprint PRD §7.3). Sr / Description stay left, everything numeric centres.
  const align = (i: number): 'left' | 'center' => (i <= 1 ? 'left' : 'center');
  pdf.rect(L, yy, tableW, 15).fillAndStroke(HEAD_BG, BORDER); pdf.font('Helvetica-Bold').fontSize(7.5).fillColor('white');
  let x = L; cols.forEach((c, i) => { pdf.text(c.t, x + 2, yy + 4, { width: c.w - 4, align: align(i) }); x += c.w; });
  pdf.y = yy + 15; pdf.fillColor('#111').font('Helvetica').fontSize(7.5);
  for (const it of grn.lineItems) {
    // Keep the row on the page — the GRN table used to run off the bottom.
    if (pdf.y + 20 > pdf.page.height - 40) { pdf.addPage(); pdf.y = 40; }
    const yr = pdf.y + 2; x = L;
    const short = Math.max(0, (Number(it.poQty) || 0) - (Number(it.previouslyReceivedQty) || 0) - (Number(it.receiptQty) || 0));
    const vals = [String(it.srNo), it.description, it.uom || '', String(it.poQty), String(it.previouslyReceivedQty), String(it.receiptQty), String(it.defectQty), String(it.acceptedQty), String(short)];
    const dH = pdf.heightOfString(it.description, { width: cols[1].w - 4 });
    cols.forEach((c, i) => { pdf.text(vals[i], x + 2, yr, { width: c.w - 4, align: align(i) }); x += c.w; });
    pdf.y = yr + Math.max(dH + 3, 13);
    pdf.lineWidth(0.5).moveTo(L, pdf.y).lineTo(R, pdf.y).stroke('#cbd5e1');
  }
  pdf.moveDown(0.6);
  // The row loop leaves PDFKit's x-cursor on the LAST column, so every text that
  // follows must state x = L explicitly or it starts at the right edge and runs
  // off the page. Keep the closing block on the page too.
  if (pdf.y + 70 > pdf.page.height - 40) { pdf.addPage(); pdf.y = 40; }

  // ── PI + Tax Invoice boxes, side by side ───────────────────────────────────
  // Payment is made against the Proforma Invoice, which arrives BEFORE the tax
  // invoice, so the two sit next to each other: what we paid on (left) and what
  // finally closes the GRN (right). The PI box only appears when the GRN actually
  // carries a payment — a pure goods receipt keeps the plain invoice line.
  const hasPi = isPayment;
  const hasTaxInvoice = !!(grn.invoiceNumber || grn.invoiceValue != null);

  const PAD_X = 8, PAD_Y = 6, LINE_H = 12, TITLE_H = 14, KEY_W = 78;
  // One bordered box: title, then key/value rows. `note` replaces the rows when
  // there is nothing to show yet (e.g. the tax invoice hasn't arrived).
  const drawBox = (bx: number, bw: number, top: number, bh: number, title: string, rows: [string, string][], note?: string) => {
    pdf.lineWidth(0.7).rect(bx, top, bw, bh).fillAndStroke('#f8fafc', HEAD_BG);
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(HEAD_BG).text(title, bx + PAD_X, top + PAD_Y, { width: bw - PAD_X * 2 });
    let ry = top + PAD_Y + TITLE_H;
    if (note) {
      pdf.font('Helvetica').fontSize(8).fillColor('#64748b').text(note, bx + PAD_X, ry, { width: bw - PAD_X * 2 });
      return;
    }
    for (const [k, v] of rows) {
      pdf.font('Helvetica').fontSize(8).fillColor('#64748b').text(k, bx + PAD_X, ry, { width: KEY_W });
      pdf.font('Helvetica-Bold').fontSize(8).fillColor('#111').text(v, bx + PAD_X + KEY_W + 5, ry, { width: bw - PAD_X * 2 - KEY_W - 5 });
      ry += LINE_H;
    }
  };

  const taxRows: [string, string][] = [
    ['Invoice No.', grn.invoiceNumber || '-'],
    ['Invoice Date', grn.invoiceDate ? grn.invoiceDate.toLocaleDateString('en-GB') : '-'],
    ['Invoice Value', INR(grn.invoiceValue)],
    ['E-Way Bill', grn.ewayBillNumber || '-'],
  ];

  if (hasPi) {
    const piRows: [string, string][] = [
      ['Payment Term', grn.milestoneName || '-'],
      ['PI No.', grn.piNumber || '-'],
      ['PI Date', grn.piDate ? grn.piDate.toLocaleDateString('en-GB') : '-'],
      ['PI Value', INR(grn.piValue)],
      ['Amount to Pay', INR(grn.amountToPay)],
    ];
    if (grn.paymentStatus) {
      piRows.push(['Payment Status', grn.paymentStatus === 'CLOSED' ? 'Closed' : grn.paymentStatus === 'PAID' ? 'Paid (invoice pending)' : 'Triggered']);
      if (grn.utrNumber) piRows.push(['UTR / Ref', `${grn.utrNumber}${grn.paidAt ? ` (${grn.paidAt.toLocaleDateString('en-GB')})` : ''}`]);
    }
    // The tax invoice arrives only after payment, so say so rather than printing
    // a row of dashes the approver has to interpret.
    const taxNote = hasTaxInvoice ? undefined : 'Awaited — arrives after payment and closes this entry.';

    const gap = 10, bw = (tableW - gap) / 2;
    // Both boxes share the taller box's height so they line up.
    const bodyLines = Math.max(piRows.length, hasTaxInvoice ? taxRows.length : 2);
    const boxH = TITLE_H + bodyLines * LINE_H + PAD_Y * 2;
    if (pdf.y + boxH + 70 > pdf.page.height - 40) { pdf.addPage(); pdf.y = 40; }
    const top = pdf.y;
    drawBox(L, bw, top, boxH, 'Payment / PI Details', piRows);
    drawBox(L + bw + gap, bw, top, boxH, 'Tax Invoice Details', taxRows, taxNote);
    pdf.y = top + boxH + 10;
  } else {
    // Pure goods receipt — no payment on it, so keep the original invoice line.
    pdf.font('Helvetica-Bold').fontSize(9).fillColor(HEAD_BG).text('Invoice Details', L, pdf.y, { width: tableW });
    pdf.font('Helvetica').fontSize(8).fillColor('#111').text(
      `Invoice No.: ${grn.invoiceNumber || '-'}    Date: ${grn.invoiceDate ? grn.invoiceDate.toLocaleDateString('en-GB') : '-'}    Value: ${INR(grn.invoiceValue)}    E-Way Bill: ${grn.ewayBillNumber || '-'}`,
      L, pdf.y, { width: tableW });
    pdf.moveDown(2.5);
  }

  pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(HEAD_BG).text(COMPANY.name, L, pdf.y, { width: tableW });
  pdf.font('Helvetica').fontSize(8).fillColor('#111').text('Authorized Signatory', L, pdf.y + 16);

  // ── Final-approval stamp — who approved this GRN, when, with what remark ──
  const gApprovals = (grn.approvals || []).filter((a) => a.at);
  if (gApprovals.length) {
    const fmtDT = (v: Date | string) => {
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
    };
    const gRemarkH = (r: string) => { pdf.font('Helvetica').fontSize(8); return pdf.heightOfString(`Remark: ${r}`, { width: tableW - 20 }); };
    let need = 22;
    for (const a of gApprovals) { need += 12; if (a.remarks) need += gRemarkH(a.remarks as string) + 4; }
    if (pdf.y + need + 24 > pdf.page.height - 30) { pdf.addPage(); pdf.y = 40; }
    const top = pdf.y + 14;
    pdf.lineWidth(0.7).rect(L, top, tableW, need).stroke(BORDER);
    pdf.font('Helvetica-Bold').fontSize(8.5).fillColor(HEAD_BG).text('FINAL APPROVAL (e-signed)', L + 6, top + 5, { width: tableW - 12 });
    let ry = top + 20;
    gApprovals.forEach((a, i) => {
      pdf.font('Helvetica-Bold').fontSize(8).fillColor('#111').text(`${i + 1}. ${a.name}${a.role ? ` (${a.role})` : ''}`, L + 6, ry, { width: tableW * 0.62 });
      pdf.font('Helvetica').fontSize(8).fillColor('#111').text(`Approved: ${fmtDT(a.at as Date | string)}`, L + tableW * 0.62, ry, { width: tableW * 0.38 - 8, align: 'right' });
      ry += 12;
      if (a.remarks) { pdf.font('Helvetica').fontSize(8).fillColor('#334155').text(`Remark: ${a.remarks}`, L + 14, ry, { width: tableW - 20 }); ry += gRemarkH(a.remarks as string) + 4; }
    });
  }
  pdf.end();
}

// ── Packing List PDF — "MANIFEST CUM FINAL PACKING LIST" (Amisha 63/64, Phase 3) ─
// Mirrors the on-screen PackingListPaper and the Rinac sample: a bordered info
// grid (customer / PO / vehicle / dates / e-way) over a configurable-column item
// table (S.No + Description + Amisha's custom columns + Qty), with a RECEIVED BY
// footer. Works for a CUSTOM packing list; a DIRECT GRN simply has no custom cols.
interface PackingListForPdf {
  grnNumber: string;
  packingListNo?: number | null;
  status?: string | null;
  customerName?: string | null;
  customerAddress?: string | null;
  clientPoNumber?: string | null;
  // The internal PO/WO this GRN is raised against (e.g. PO-IN833 / WO-QAS-007).
  againstNumber?: string | null;
  againstType?: string | null;
  invoiceNumber?: string | null;
  dispatchDate?: Date | null;
  deliveryDate?: Date | null;
  vehicleNumber?: string | null;
  vehicleSize?: string | null;
  ewayBillNumber?: string | null;
  siteSupervisor?: string | null;
  customColumns?: { key: string; label: string }[] | null;
  lineItems: { srNo: number; description: string; receiptQty: number; defectQty?: number; customValues?: Record<string, string> | null }[];
}
export function renderPackingListPdf(pl: PackingListForPdf, stream: NodeJS.WritableStream) {
  const pdf = new PDFDocument({ size: 'A4', margin: 28 });
  pdf.pipe(stream);
  const W = pdf.page.width, L = 28, R = W - 28, TW = R - L;
  const dt = (v?: Date | null) => (v ? new Date(v).toLocaleDateString('en-GB') : '');
  const cols = pl.customColumns || [];

  const line = (x1: number, y1: number, x2: number, y2: number) => pdf.lineWidth(0.7).moveTo(x1, y1).lineTo(x2, y2).stroke(BORDER);
  const box = (x: number, y: number, w: number, h: number, fill?: string) => { if (fill) pdf.lineWidth(0.7).rect(x, y, w, h).fillAndStroke(fill, BORDER); else pdf.lineWidth(0.7).rect(x, y, w, h).stroke(BORDER); };
  const put = (x: number, y: number, w: number, text: string, o: { font?: string; size?: number; align?: 'left' | 'center' | 'right'; color?: string } = {}) => {
    pdf.font(o.font || 'Helvetica').fontSize(o.size || 8).fillColor(o.color || '#111');
    pdf.text(text || '', x + 4, y + 3, { width: w - 8, align: o.align || 'left' });
  };
  const measure = (text: string, w: number, size = 8) => { pdf.fontSize(size); return pdf.heightOfString(text || ' ', { width: w - 8 }); };

  // ── Header: logo + company ──
  const logo = logoPath();
  if (logo) { try { pdf.image(logo, R - 66, 26, { fit: [58, 34] }); } catch { /* ignore */ } }
  pdf.fillColor(HEAD_BG).font('Helvetica-Bold').fontSize(13).text(COMPANY.name, L, 28, { width: TW - 80 });
  pdf.font('Helvetica').fontSize(7.5).fillColor('#334155').text(COMPANY.address, { width: TW - 80 });
  let y = Math.max(pdf.y, 66) + 6;

  // ── Title bar ──
  box(L, y, TW, 20, HEAD_BG);
  put(L, y + 5, TW, 'FINAL PACKING LIST', { font: 'Helvetica-Bold', size: 11, align: 'center', color: '#ffffff' });
  y += 20;

  // ── Info grid — two label/value pairs per row, height auto-sized to content ──
  const labelW = 96;
  const half = TW / 2;
  const valW = half - labelW;
  const customerBlock = [pl.customerName, pl.customerAddress].filter(Boolean).join('\n') || '—';
  const drawRow = (cells: { label: string; value: string; span?: boolean; center?: boolean }[]) => {
    let rowH = 16;
    for (const c of cells) { const w = c.span ? TW - labelW : valW; rowH = Math.max(rowH, measure(c.value, w) + 6, measure(c.label, labelW) + 6); }
    let x = L;
    cells.forEach((c) => {
      const vW = c.span ? TW - labelW : valW;
      box(x, y, labelW, rowH, '#eef2f7'); put(x, y + 2, labelW, c.label, { font: 'Helvetica-Bold', size: 7.5, color: HEAD_BG });
      box(x + labelW, y, vW, rowH); put(x + labelW, y + 2, vW, c.value, { size: 8.5, align: c.center ? 'center' : 'left' });
      x += labelW + vW;
    });
    y += rowH;
  };
  drawRow([{ label: 'Customer Name & Address', value: customerBlock, span: true }]);
  drawRow([{ label: 'PO No.', value: pl.clientPoNumber || '—' }, { label: `${pl.againstType === 'WO' ? 'WO' : 'PO'} No.`, value: pl.againstNumber || '—' }]);
  drawRow([{ label: 'Vehicle No.', value: pl.vehicleNumber || '—' }, { label: 'Vehicle Size', value: pl.vehicleSize || '—' }]);
  drawRow([{ label: 'Date of Invoice / Dispatch', value: dt(pl.dispatchDate) || '—' }, { label: 'Date of Delivery', value: dt(pl.deliveryDate) || '—' }]);

  // ── Item table — S.No | Description | [custom cols…] | Qty (Nos) | Damage ──
  // Damage (defect) shown alongside received so "20 received, 1 damage" is explicit.
  const snoW = 30, qtyW = 46, dmgW = 46;
  const restW = TW - snoW - qtyW - dmgW;
  const descW = cols.length ? Math.max(restW * 0.34, 120) : restW;
  const colW = cols.length ? (restW - descW) / cols.length : 0;
  const heads = ['S.No.', 'Description', ...cols.map((c) => c.label), 'Qty (Nos)', 'Damage'];
  const widths = [snoW, descW, ...cols.map(() => colW), qtyW, dmgW];
  const aligns: ('left' | 'center')[] = ['center', 'left', ...cols.map(() => 'center' as const), 'center', 'center'];

  const headH = 18;
  box(L, y, TW, headH, HEAD_BG);
  { let x = L; heads.forEach((h, i) => { put(x, y + 4, widths[i], h, { font: 'Helvetica-Bold', size: 7.5, align: aligns[i] === 'center' ? 'center' : 'left', color: '#ffffff' }); x += widths[i]; }); }
  { let x = L; for (let i = 0; i < widths.length - 1; i++) { x += widths[i]; line(x, y, x, y + headH); } }
  y += headH;

  let total = 0, totalDmg = 0;
  for (const it of pl.lineItems) {
    const vals = [String(it.srNo), it.description || '', ...cols.map((c) => it.customValues?.[c.key] ?? ''), String(it.receiptQty ?? ''), String(it.defectQty ?? 0)];
    const rowH = Math.max(16, ...widths.map((w, i) => measure(vals[i], w) + 6));
    if (y + rowH > pdf.page.height - 70) { pdf.addPage(); y = 40; }
    box(L, y, TW, rowH);
    let x = L;
    vals.forEach((v, i) => { put(x, y + 2, widths[i], v, { size: 8, align: aligns[i] === 'center' ? 'center' : 'left' }); x += widths[i]; });
    x = L; for (let i = 0; i < widths.length - 1; i++) { x += widths[i]; line(x, y, x, y + rowH); }
    total += Number(it.receiptQty) || 0;
    totalDmg += Number(it.defectQty) || 0;
    y += rowH;
  }
  if (!pl.lineItems.length) { const rh = 20; box(L, y, TW, rh); put(L, y + 4, TW, 'No items.', { size: 8, align: 'center', color: '#94a3b8' }); y += rh; }

  // Total row — totals for both the received qty and the damage columns.
  const totH = 18;
  box(L, y, TW, totH);
  put(L, y + 4, TW - qtyW - dmgW, 'TOTAL', { font: 'Helvetica-Bold', size: 8, align: 'right' });
  put(L + TW - qtyW - dmgW, y + 4, qtyW, String(total), { font: 'Helvetica-Bold', size: 8, align: 'center' });
  put(L + TW - dmgW, y + 4, dmgW, String(totalDmg), { font: 'Helvetica-Bold', size: 8, align: 'center' });
  line(L + TW - qtyW - dmgW, y, L + TW - qtyW - dmgW, y + totH);
  line(L + TW - dmgW, y, L + TW - dmgW, y + totH);
  y += totH;

  // ── Signature blocks — Crystal Corporate team + Client team (2–3 names each,
  //    received-by name & sign). Amisha/Akash B3: two signature columns. ──
  y += 16;
  const blockH = 90;   // tall enough that the Name / Sign / Date lines all sit inside the box
  if (y + blockH + 40 > pdf.page.height - 30) { pdf.addPage(); y = 40; }
  const gap2 = 12, halfSig = (TW - gap2) / 2;
  const sigBlock = (bx: number, title: string) => {
    box(bx, y, halfSig, blockH);
    box(bx, y, halfSig, 16, '#eef2f7');
    put(bx, y + 4, halfSig, title, { font: 'Helvetica-Bold', size: 8, align: 'center', color: HEAD_BG });
    let ry = y + 26;
    for (const label of ['Name', 'Sign', 'Date']) {   // one line each
      line(bx + 8, ry + 10, bx + halfSig - 8, ry + 10);
      put(bx + 8, ry + 11, halfSig - 16, label, { size: 6, color: '#94a3b8' });
      ry += 17;
    }
  };
  sigBlock(L, 'CRYSTAL CORPORATE TEAM');
  sigBlock(L + halfSig + gap2, 'CLIENT TEAM (Received By)');
  y += blockH;

  // ── Site supervisor + system-generated timestamp footer ──
  y += 8;
  put(L, y, TW, `Site Supervisor: ${pl.siteSupervisor || '__________________________'}     Packing List: ${pl.grnNumber}`, { size: 7.5, color: '#475569' });
  y += 13;
  const genAt = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  put(L, y, TW, `System-generated on ${genAt} (IST) — computer-generated copy.`, { size: 6.5, color: '#94a3b8' });

  pdf.end();
}
