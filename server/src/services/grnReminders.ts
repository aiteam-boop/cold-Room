import { prisma } from '../lib/prisma';
import { sendEmail, appClientUrl, isEmailEnabled } from './email';

// ── Daily "signed packing list still pending" reminder (Amisha rec 64, Phase 4) ─
// After a site engineer submits a goods receipt, they must print the packing
// list, get it signed/stamped, and upload the signed PDF. Until at least one
// signed copy is uploaded (and while billing hasn't closed the GRN), nudge them
// once a day. Mirrors the 24-hour approval-reminder job.
export const SIGNED_TYPE = 'PACKING_LIST_SIGNED';
const REMIND_HOURS = Number(process.env.GRN_REMINDER_HOURS) || 24;

const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c));
const num = (n: unknown) => { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100); };

// The "signed packing list pending" reminder email — now includes the Received
// Items so the engineer sees exactly what this GRN covers, right in the mail.
export function packingListReminderHtml(g: { grnNumber: string; doc?: { docNumber?: string | null } | null; lineItems?: any[] }, link: string): string {
  const items = g.lineItems ?? [];
  const rows = items.map((l) => `
        <tr>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${esc(l.description)}${l.uom ? ` <span style="color:#94a3b8">(${esc(l.uom)})</span>` : ''}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:12px">${num(l.poQty)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:12px">${num(l.receiptQty)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:12px">${num(l.acceptedQty)}</td>
        </tr>`).join('');
  const itemsTable = items.length ? `
      <p style="margin:18px 0 6px;font-weight:600">Received Items (${items.length})</p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0">
        <thead><tr style="background:#052379;color:#fff">
          <th style="padding:6px 8px;text-align:left;font-size:11px">Description</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;white-space:nowrap">PO Qty</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;white-space:nowrap">Received</th>
          <th style="padding:6px 8px;text-align:right;font-size:11px;white-space:nowrap">Accepted</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '';
  return `<div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;color:#0f172a">
          <p>Hi,</p>
          <p>The goods receipt <strong>${esc(g.grnNumber)}</strong>${g.doc?.docNumber ? ` (against ${esc(g.doc.docNumber)})` : ''} has been submitted, but the <strong>signed packing list is still pending upload</strong>.</p>
          <p>Please open the link below, download the packing list PDF, get it signed &amp; stamped, and upload the signed PDF.</p>
          ${itemsTable}
          <p style="margin:22px 0"><a href="${link}" style="background:#052379;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open Goods Receipt</a></p>
          <p style="font-size:12px;color:#64748b">Or paste this link in your browser:<br>${link}</p>
        </div>`;
}

export async function sendDuePackingListReminders(opts: { now?: Date; dryRun?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const cutoffMs = REMIND_HOURS * 3600_000;
  // Filter status in the query; the nullable checks are done in JS because the
  // Prisma MongoDB connector does NOT match newly-added, still-missing fields with
  // `{ field: null }` — so `billingConfirmedAt: null` would silently match nothing.
  const grns = await prisma.goodsReceipt.findMany({
    where: { status: 'RECEIVED' },
    include: { doc: { select: { docNumber: true } }, lineItems: { orderBy: { srNo: 'asc' } } },
  });
  let due = 0, sent = 0;
  for (const g of grns) {
    if (g.billingConfirmedAt) continue;        // already closed by billing
    if (!g.submittedAt) continue;              // never submitted → no clock yet
    if (!g.siteEngineerEmail) continue;        // no one to remind
    // Stop reminding as soon as any one signed PDF is uploaded.
    const signed = await prisma.procurementDocument.count({ where: { type: SIGNED_TYPE, linkedDocNumber: g.grnNumber, archived: false } });
    if (signed > 0) continue;
    const ref = g.lastReminderAt ?? g.submittedAt!;
    if (now.getTime() - new Date(ref).getTime() < cutoffMs) continue;
    due++;
    if (opts.dryRun) continue;
    if (!isEmailEnabled() || !g.siteEngineerEmail || !g.linkToken) continue;
    const link = `${appClientUrl()}/grn/${g.linkToken}`;
    try {
      await sendEmail({
        to: g.siteEngineerEmail,
        subject: `Reminder: signed packing list pending — ${g.grnNumber}`,
        html: packingListReminderHtml(g, link),
      });
    } catch { /* best-effort — retried on the next daily poll */ }
    await prisma.goodsReceipt.update({ where: { id: g.id }, data: { lastReminderAt: now } });
    sent++;
  }
  return { due, sent };
}

// Background poll. Disabled when GRN_REMINDERS=off (local dev, so it never emails
// real engineers). First run 90s after boot, then hourly; the 24-hour per-GRN
// gate above keeps the real cadence to once a day.
export function startPackingListReminderPoll() {
  if (process.env.GRN_REMINDERS === 'off') { console.log('GRN packing-list reminders: disabled (GRN_REMINDERS=off)'); return; }
  const interval = Number(process.env.GRN_REMINDER_POLL_MS) || 3600_000;
  const tick = () => sendDuePackingListReminders()
    .then((r) => { if (r.sent) console.log(`GRN reminders: sent ${r.sent} of ${r.due} due`); })
    .catch((e) => console.error('[grn-reminder]', e));
  setTimeout(tick, 90_000);
  setInterval(tick, interval);
}
