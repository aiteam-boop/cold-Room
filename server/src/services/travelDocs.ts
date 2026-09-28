// Combined "all documents" PDF for a travel trip — advances, technician bills,
// ticket, payment proof collated into one PDF. Shared by the authed Accounts
// route and the public (token) link put on the Travel Account FMS sheet.
import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import { prisma } from '../lib/prisma';
import { readFromDb } from '../lib/fileStore';
import { UPLOADS_PATH } from '../middleware/upload';

function parseJson<T>(s: string | null | undefined, fb: T): T { try { return s ? (JSON.parse(s) as T) : fb; } catch { return fb; } }

export async function buildTravelDocsPdf(planId: string): Promise<{ buffer: Buffer; planNumber: string } | null> {
  const plan = await prisma.travelPlan.findUnique({ where: { id: planId } });
  if (!plan) return null;
  const advances = parseJson<any[]>(plan.advances, []);
  const atts = parseJson<any[]>(plan.techAttachments, []);
  const docs: { label: string; url: string }[] = [];
  advances.forEach((a, i) => { if (a?.fileUrl) docs.push({ label: `Advance ${i + 1}${a.amount ? ` — Rs. ${a.amount}` : ''}`, url: a.fileUrl }); });
  atts.forEach((a) => { if (a?.fileUrl) docs.push({ label: `${a.category || 'Bill'}${a.day ? ` · Day ${a.day}` : ''}`, url: a.fileUrl }); });
  if (plan.ticketFileUrl) docs.push({ label: 'Ticket', url: plan.ticketFileUrl });
  if (plan.paymentProofUrl) docs.push({ label: 'Payment proof', url: plan.paymentProofUrl });

  const getBuf = async (url: string): Promise<{ fn: string; buf: Buffer | null }> => {
    const fn = path.basename(String(url).split('?')[0]);
    let buf = await readFromDb(fn).catch(() => null);
    if (!buf) { try { buf = fs.readFileSync(path.join(UPLOADS_PATH, fn)); } catch { buf = null; } }
    return { fn, buf };
  };

  const doc = new PDFDocument({ autoFirstPage: false, margin: 36 });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c as Buffer));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.addPage();
  doc.fontSize(16).fillColor('#0a1a4f').text(`Travel documents — ${plan.planNumber}`);
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#333').text(`Traveller: ${plan.employeeName || '-'}`);
  doc.text(`Trip: ${plan.origin || '-'} to ${plan.destination || '-'}`);
  doc.text(`${docs.length} document(s) attached`);

  for (const d of docs) {
    const { fn, buf } = await getBuf(d.url);
    doc.addPage();
    doc.fontSize(11).fillColor('#0a1a4f').text(d.label);
    doc.moveDown(0.3);
    if (buf && /\.(jpe?g|png)$/i.test(fn)) {
      try { doc.image(buf, { fit: [520, 680] }); }
      catch { doc.fontSize(9).fillColor('#b00000').text('(could not render this image)'); }
    } else if (/\.pdf$/i.test(fn)) {
      doc.fontSize(9).fillColor('#666').text(`PDF attachment "${fn}" — open it from the trip's documents (a PDF cannot be inlined here).`);
    } else {
      doc.fontSize(9).fillColor('#666').text(buf ? `File: ${fn} (format not previewable).` : `File not found: ${fn}.`);
    }
  }
  if (docs.length === 0) { doc.addPage(); doc.fontSize(11).fillColor('#666').text('No documents were uploaded against this trip.'); }
  doc.end();
  return { buffer: await done, planNumber: plan.planNumber };
}
