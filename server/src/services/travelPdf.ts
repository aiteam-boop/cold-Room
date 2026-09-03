// Travel expense approval PDF — the downloadable record the employee gets once the
// expense is fully approved: trip summary, every expense line, and the approval
// trail (who approved, when, and any comments). pdfkit; "Rs." for the rupee sign
// (the built-in Helvetica lacks the ₹ glyph).
import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';

const NAVY = '#052379';
const SLATE = '#334155';
const GREY = '#64748b';
const LINE = '#e2e8f0';

const rs = (n: number) => 'Rs. ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const dt = (d: Date | string | null | undefined) => {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const day = (d: Date | string | null | undefined) => {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '—' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export interface TravelPdfPlan {
  planNumber: string; employeeName: string; mLevel: string | null; isNonCrystal: boolean;
  destination: string | null; origin: string | null; purpose: string | null;
  fromDate: Date; toDate: Date; days: number;
}
export interface TravelPdfExpenseItem { date: string | null; details: string; paymentMode: string; amount: number; hasSupport: boolean }
export interface TravelPdfExpense { expenseNumber: string; totalAmount: number; items: TravelPdfExpenseItem[]; submittedByName: string | null; submittedAt: Date | null }
export interface TravelPdfStep { order: number; name: string; role: string | null; status: string; actedAt: Date | null; remarks: string | null }

export function buildTravelExpensePdf(plan: TravelPdfPlan, expense: TravelPdfExpense, steps: TravelPdfStep[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44 });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    doc.pipe(stream);

    const left = 44;
    const right = doc.page.width - 44;
    const width = right - left;

    // Header
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(18).text('Travel Expense — Approved', left, 44);
    doc.fillColor(GREY).font('Helvetica').fontSize(10).text('Crystal Group · CRMCTS', left, 68);
    doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(11).text(expense.expenseNumber, left, 68, { width, align: 'right' });
    doc.moveTo(left, 90).lineTo(right, 90).strokeColor(LINE).lineWidth(1).stroke();

    // Trip summary (two columns of key/value)
    let y = 104;
    const rowH = 16;
    const facts: [string, string][] = [
      ['Traveller', plan.employeeName + (plan.isNonCrystal ? '  (Non-Crystal)' : '')],
      ['M-Level', plan.mLevel || '—'],
      ['Trip', plan.planNumber],
      ['Route', [plan.origin, plan.destination].filter(Boolean).join('  →  ') || '—'],
      ['Dates', `${day(plan.fromDate)}  →  ${day(plan.toDate)}   (${plan.days} day${plan.days === 1 ? '' : 's'})`],
      ['Purpose', plan.purpose || '—'],
    ];
    doc.fontSize(9.5);
    for (const [k, v] of facts) {
      doc.fillColor(GREY).font('Helvetica').text(k.toUpperCase(), left, y, { width: 90 });
      doc.fillColor(SLATE).font('Helvetica-Bold').text(v, left + 96, y, { width: width - 96 });
      y += rowH;
    }
    y += 6;

    // Expense line items table
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('Expense details', left, y);
    y += 20;
    const cols = { date: left, details: left + 78, mode: left + 300, support: left + 380, amount: right - 90 };
    doc.fontSize(8.5).fillColor(GREY).font('Helvetica-Bold');
    doc.text('DATE', cols.date, y); doc.text('DETAILS', cols.details, y); doc.text('MODE', cols.mode, y);
    doc.text('SUPPORT', cols.support, y); doc.text('AMOUNT', cols.amount, y, { width: 90, align: 'right' });
    y += 14;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 6;
    doc.font('Helvetica').fontSize(9).fillColor(SLATE);
    for (const it of expense.items) {
      if (y > doc.page.height - 120) { doc.addPage(); y = 60; }
      const detailsH = doc.heightOfString(it.details || '—', { width: cols.mode - cols.details - 8 });
      doc.fillColor(SLATE).text(day(it.date), cols.date, y, { width: 74 });
      doc.text(it.details || '—', cols.details, y, { width: cols.mode - cols.details - 8 });
      doc.text(it.paymentMode || '—', cols.mode, y, { width: 74 });
      doc.text(it.hasSupport ? 'Yes' : (it.paymentMode === 'Cash' ? '— (cash)' : 'No'), cols.support, y, { width: 74 });
      doc.font('Helvetica-Bold').text(rs(it.amount), cols.amount, y, { width: 90, align: 'right' });
      doc.font('Helvetica');
      y += Math.max(detailsH, 12) + 6;
    }
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11);
    doc.text('Total', cols.mode, y);
    doc.text(rs(expense.totalAmount), cols.amount, y, { width: 90, align: 'right' });
    y += 26;

    // Approval trail
    if (y > doc.page.height - 160) { doc.addPage(); y = 60; }
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 8;
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(11).text('Approval trail', left, y);
    y += 20;
    doc.fillColor(GREY).font('Helvetica').fontSize(9.5).text('Submitted by ' + (expense.submittedByName || '—') + ' on ' + dt(expense.submittedAt), left, y, { width });
    y += 18;
    for (const s of steps) {
      if (y > doc.page.height - 80) { doc.addPage(); y = 60; }
      const ok = s.status === 'APPROVED' || s.status === 'SKIPPED';
      doc.fillColor(ok ? '#16a34a' : s.status === 'ON_HOLD' ? '#d97706' : GREY).font('Helvetica-Bold').fontSize(10);
      doc.text(`${s.order}. ${s.name}${s.role ? ' · ' + s.role : ''}`, left, y, { width: width - 150, continued: false });
      doc.fillColor(ok ? '#16a34a' : SLATE).font('Helvetica').fontSize(9.5);
      doc.text(`${s.status}${s.actedAt ? ' · ' + dt(s.actedAt) : ''}`, left + width - 150, y, { width: 150, align: 'right' });
      y += 15;
      if (s.remarks) { doc.fillColor(GREY).font('Helvetica-Oblique').fontSize(9).text('“' + s.remarks + '”', left + 14, y, { width: width - 28 }); y += 15; }
      y += 3;
    }

    // Footer
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text('Generated by CRMCTS on ' + dt(new Date()), left, doc.page.height - 56, { width, align: 'center' });
    doc.end();
  });
}
