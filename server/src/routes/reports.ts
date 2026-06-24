import { Router } from 'express';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage } from '../middleware/authMiddleware';
import { loadProjectProgress } from '../services/projectProgress';
import { audit } from '../lib/audit';

const router = Router({ mergeParams: true });
router.use(requireAuth);

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toISOString().slice(0, 10);
}

// GET .../reports/excel — full progress workbook (FR-DB-03/04).
router.get(
  '/excel',
  requireProjectMember,
  requirePage('dashboard'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const [project, prog] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId } }),
      loadProjectProgress(projectId),
    ]);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CRMCTS';

    // Summary sheet
    const s = wb.addWorksheet('Summary');
    s.columns = [{ width: 32 }, { width: 40 }];
    s.addRows([
      ['Project', project?.name ?? ''],
      ['Client', project?.clientName ?? ''],
      ['Site Location', project?.siteLocation ?? ''],
      ['Status', project?.status ?? ''],
      ['Start Date', fmtDate(project?.startDate)],
      ['Target Completion', fmtDate(project?.targetCompletionDate)],
      ['Overall Completion %', prog.overall.completionPct],
      ['Estimated Completion', fmtDate(prog.overall.estimatedCompletionDate)],
      ['Delay Risk', `${prog.risk.level} — ${prog.risk.message}`],
      ['Items Completed', prog.overall.itemsCompleted],
      ['Items In Progress', prog.overall.itemsInProgress],
      ['Items Not Started', prog.overall.itemsNotStarted],
    ]);
    s.getColumn(1).font = { bold: true };

    // Activity sheet
    const a = wb.addWorksheet('Activities');
    a.columns = [
      { header: 'Sr No', key: 'sr', width: 10 },
      { header: 'Category', key: 'cat', width: 24 },
      { header: 'Description', key: 'desc', width: 48 },
      { header: 'Room/Zone', key: 'zone', width: 22 },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: 'Planned', key: 'planned', width: 12 },
      { header: 'Installed', key: 'installed', width: 12 },
      { header: 'Remaining', key: 'remaining', width: 12 },
      { header: 'Completion %', key: 'pct', width: 14 },
      { header: 'Est. Completion', key: 'est', width: 16 },
    ];
    a.getRow(1).font = { bold: true };
    const boqItems = await prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, orderBy: { sortOrder: 'asc' } });
    for (const it of boqItems) {
      const p = prog.itemsById.get(it.id);
      a.addRow({
        sr: it.srNo, cat: it.category, desc: it.description, zone: it.roomZone, unit: it.unit,
        planned: it.plannedQty, installed: p?.installedQty ?? 0, remaining: p?.remainingQty ?? it.plannedQty,
        pct: p?.completionPct ?? 0, est: fmtDate(p?.estimatedCompletionDate),
      });
    }

    // Material consumption sheet (FR-DB-04)
    const m = wb.addWorksheet('Material Consumption');
    m.columns = [
      { header: 'Category', key: 'cat', width: 30 },
      { header: 'Planned', key: 'planned', width: 14 },
      { header: 'Installed', key: 'installed', width: 14 },
      { header: 'Remaining', key: 'remaining', width: 14 },
      { header: 'Completion %', key: 'pct', width: 14 },
    ];
    m.getRow(1).font = { bold: true };
    for (const c of prog.categories) m.addRow({ cat: c.category, planned: c.plannedQty, installed: c.installedQty, remaining: c.remainingQty, pct: c.completionPct });

    await audit({ userId: req.user!.sub, projectId, action: 'REPORT_EXPORT_EXCEL', entity: 'Project' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="CRMCTS_${(project?.name ?? 'project').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  })
);

// GET .../reports/pdf?type=client|full — branded PDF (FR-DB-07).
router.get(
  '/pdf',
  requireProjectMember,
  requirePage('dashboard'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const type = req.query.type === 'full' ? 'full' : 'client';
    const [project, prog] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId } }),
      loadProjectProgress(projectId),
    ]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CRMCTS_${type}_${(project?.name ?? 'project').replace(/[^a-z0-9]/gi, '_')}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    const NAVY = '#0f2942';
    const GREEN = '#16a34a';
    const YELLOW = '#d97706';
    const RED = '#dc2626';
    const colorHex = (c: string) => (c === 'GREEN' ? GREEN : c === 'YELLOW' ? YELLOW : RED);

    // Header band
    doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
    doc.fillColor('white').fontSize(20).text('Cold Room Construction', 50, 28);
    doc.fontSize(11).fillColor('#cbd5e1').text('Progress Report — CRMCTS', 50, 56);
    doc.fillColor('black').moveDown(4);

    doc.fontSize(16).fillColor(NAVY).text(project?.name ?? 'Project', 50, 110);
    doc.fontSize(10).fillColor('#475569');
    doc.text(`Client: ${project?.clientName ?? '—'}    Site: ${project?.siteLocation ?? '—'}`);
    doc.text(`Status: ${project?.status ?? '—'}    Target: ${fmtDate(project?.targetCompletionDate)}    Report date: ${fmtDate(new Date())}`);
    doc.moveDown(1);

    // Big completion number + progress bar
    const pct = prog.overall.completionPct;
    doc.fontSize(13).fillColor(NAVY).text('Overall Completion', 50, doc.y);
    doc.fontSize(34).fillColor(colorHex(pct >= 80 ? 'GREEN' : pct >= 20 ? 'YELLOW' : 'RED')).text(`${pct}%`, 50, doc.y);
    const barY = doc.y + 4;
    const barW = doc.page.width - 100;
    doc.roundedRect(50, barY, barW, 14, 4).fill('#e2e8f0');
    doc.roundedRect(50, barY, Math.max(barW * (pct / 100), 2), 14, 4).fill(colorHex(pct >= 80 ? 'GREEN' : pct >= 20 ? 'YELLOW' : 'RED'));
    doc.y = barY + 30;
    doc.fillColor('black');

    // Risk box
    const riskColor = prog.risk.level === 'ON_TRACK' ? GREEN : prog.risk.level === 'AT_RISK' ? YELLOW : prog.risk.level === 'DELAYED' ? RED : '#64748b';
    doc.roundedRect(50, doc.y, doc.page.width - 100, 46, 6).fillAndStroke('#f8fafc', '#e2e8f0');
    const ry = doc.y + 8;
    doc.fillColor(riskColor).fontSize(12).text(`Delay Risk: ${prog.risk.level.replace('_', ' ')}`, 60, ry);
    doc.fillColor('#475569').fontSize(9).text(prog.risk.message, 60, ry + 18, { width: doc.page.width - 120 });
    doc.fillColor('black');
    doc.y = ry + 50;

    // Category breakdown
    doc.moveDown(0.5).fontSize(13).fillColor(NAVY).text('Category Breakdown');
    doc.moveDown(0.3);
    for (const c of prog.categories) {
      const y = doc.y;
      doc.fontSize(9).fillColor('black').text(c.category, 50, y, { width: 200 });
      const cbW = 220;
      doc.roundedRect(260, y, cbW, 10, 2).fill('#e2e8f0');
      doc.roundedRect(260, y, Math.max(cbW * (c.completionPct / 100), 1), 10, 2).fill(colorHex(c.colorStatus));
      doc.fillColor('#334155').fontSize(9).text(`${c.completionPct}%`, 490, y);
      doc.y = y + 16;
      if (doc.y > doc.page.height - 80) doc.addPage();
    }

    if (type === 'full') {
      doc.addPage();
      doc.fontSize(13).fillColor(NAVY).text('Activity Detail', 50, 50);
      doc.moveDown(0.5);
      const boqItems = await prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, orderBy: { sortOrder: 'asc' } });
      doc.fontSize(8).fillColor('#475569');
      doc.text('Description', 50, doc.y, { continued: true, width: 250 });
      doc.text('Plan', 300, doc.y, { continued: true, width: 50 });
      doc.text('Done', 350, doc.y, { continued: true, width: 50 });
      doc.text('%', 420, doc.y);
      doc.moveDown(0.3);
      doc.fillColor('black');
      for (const it of boqItems) {
        const p = prog.itemsById.get(it.id);
        const y = doc.y;
        doc.fontSize(8).text(it.description.slice(0, 60), 50, y, { width: 250 });
        doc.text(String(it.plannedQty), 300, y, { width: 50 });
        doc.text(String(p?.installedQty ?? 0), 350, y, { width: 50 });
        doc.fillColor(colorHex(p?.colorStatus ?? 'RED')).text(`${p?.completionPct ?? 0}%`, 420, y);
        doc.fillColor('black');
        doc.y = Math.max(doc.y, y) + 4;
        if (doc.y > doc.page.height - 60) doc.addPage();
      }
    }

    doc.fontSize(8).fillColor('#94a3b8').text('Confidential — Generated by CRMCTS', 50, doc.page.height - 40, { align: 'center', width: doc.page.width - 100 });
    doc.end();
    await audit({ userId: req.user!.sub, projectId, action: 'REPORT_EXPORT_PDF', entity: 'Project', details: { type } });
  })
);

export default router;
