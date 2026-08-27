import PDFDocument from 'pdfkit';

// A landscape petty-cash ledger PDF: header + KPI strip + a paginated table.
// PDF fonts render ₹ poorly, so amounts are prefixed "Rs.".
const rs = (n: number | null | undefined) => 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN');
const dmy = (d: any) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const statusText = (s: string) => (s === 'CONFIRMED' ? 'Confirmed' : s === 'SUBMITTED' ? 'Pending' : s === 'REJECTED' ? 'Rejected' : s === 'VOID' ? 'Voided' : 'Recorded');

export function renderPettyCashPdf(data: { entries: any[]; summary: any; custodian?: string | null; generatedAt: string }, stream: NodeJS.WritableStream) {
  const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
  pdf.pipe(stream);
  const L = 28, R = pdf.page.width - 28;

  pdf.font('Helvetica-Bold').fontSize(16).fillColor('#052379').text('Petty Cash Ledger', L, 28);
  pdf.font('Helvetica').fontSize(9).fillColor('#64748b');
  if (data.custodian) pdf.text(`Custodian: ${data.custodian}`, L, pdf.y + 2);
  const s = data.summary || {};
  pdf.text(`Cash on hand: ${rs(s.cashOnHand)}    Expenses: ${rs(s.expensesTotal)}    Confirmed: ${rs(s.confirmedTotal)}    Pending: ${rs(s.pendingTotal)}    Top-ups: ${rs(s.topupsTotal)}`, L, pdf.y + 2);
  pdf.text(`Generated ${data.generatedAt}`, L, pdf.y + 2);

  // Columns
  const cols = [
    { key: 'entryNumber', label: 'Petty #', w: 72 },
    { key: 'date', label: 'Date', w: 74 },
    { key: 'category', label: 'Category', w: 150 },
    { key: 'detail', label: 'Detail', w: 210 },
    { key: 'amount', label: 'Amount', w: 78, right: true },
    { key: 'status', label: 'Status', w: 90 },
  ];
  let y = pdf.y + 10;
  const rowH = 18;

  const drawHeader = () => {
    pdf.rect(L, y, R - L, rowH).fill('#052379');
    pdf.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
    let x = L + 4;
    for (const c of cols) { pdf.text(c.label, x, y + 5, { width: c.w - 6, align: c.right ? 'right' : 'left' }); x += c.w; }
    y += rowH;
  };
  drawHeader();

  pdf.font('Helvetica').fontSize(8);
  for (const e of data.entries) {
    if (y + rowH > pdf.page.height - 28) { pdf.addPage({ size: 'A4', layout: 'landscape', margin: 28 }); y = 28; drawHeader(); pdf.font('Helvetica').fontSize(8); }
    const detail = e.type === 'TOPUP' ? (e.utrNumber ? `UTR ${e.utrNumber}` : 'Float top-up') : [e.technician, e.paidTo, e.description].filter(Boolean).join(' · ');
    const cells: Record<string, string> = {
      entryNumber: e.entryNumber || '',
      date: dmy(e.date),
      category: e.type === 'TOPUP' ? `Top-up (${e.reason || 'Float'})` : (e.category || ''),
      detail,
      amount: (e.type === 'TOPUP' ? '+' : '-') + rs(e.amount).replace('Rs. ', ''),
      status: statusText(e.status),
    };
    pdf.fillColor('#0f172a');
    let x = L + 4;
    for (const c of cols) { pdf.text(cells[c.key] ?? '', x, y + 5, { width: c.w - 6, align: c.right ? 'right' : 'left', ellipsis: true, lineBreak: false }); x += c.w; }
    pdf.moveTo(L, y + rowH).lineTo(R, y + rowH).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    y += rowH;
  }
  if (data.entries.length === 0) { pdf.fillColor('#94a3b8').text('No entries.', L, y + 5); }
  pdf.end();
}
