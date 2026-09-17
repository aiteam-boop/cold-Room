import { prisma } from '../lib/prisma';
import { sendEmail, appClientUrl, isEmailEnabled } from './email';

// ── Weekly "pending deposit recovery" reminder ───────────────────────────────
// Every PO/WO line marked "💰 Deposit" that hasn't been recovered yet (its
// DepositRecovery is still HELD) is a deposit the SITE SUPERVISOR of that project
// is responsible for getting back. Once a week we email each site supervisor a
// consolidated list of their projects' still-pending deposits so nothing slips.
//
// The site supervisor is picked from a dropdown on the project form; the picked
// user's id (Project.siteSupervisorId) is what lets us reach them here. Projects
// whose supervisor is a legacy free-text name (no linked user) are skipped — the
// admin just re-selects them from the dropdown to switch the mail on.

const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c));
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const descKey = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);

interface PendingDeposit {
  projectName: string; docNumber: string; type: string;
  vendorName: string | null; description: string; pending: number;
}

// Build { supervisorId → { name, email, deposits[] } } for every still-pending
// deposit whose project has a linked site supervisor.
async function collectPendingBySupervisor() {
  const lines = await prisma.procurementLineItem.findMany({
    where: { isDeposit: true },
    include: { doc: { select: { docNumber: true, type: true, vendorName: true, project: { select: { name: true, siteSupervisorId: true } } } } },
  });
  const recs = await prisma.depositRecovery.findMany({});
  const recBy = new Map(recs.map((r) => [`${r.docId}::${r.descKey}`, r]));

  // Group pending lines by the project's linked site-supervisor user id.
  const bySup = new Map<string, PendingDeposit[]>();
  for (const l of lines) {
    if (!l.doc?.project?.siteSupervisorId) continue;               // no one to email
    const rec = recBy.get(`${l.docId}::${descKey(l.description)}`) || null;
    if (rec && rec.status !== 'HELD') continue;                    // already recovered
    const required = Number(l.totalPrice) || 0;
    const received = rec ? Number(rec.amountReceived) || 0 : 0;
    const pending = Math.round((required - received) * 100) / 100;
    if (pending <= 0) continue;
    const sid = l.doc.project.siteSupervisorId;
    const arr = bySup.get(sid) ?? [];
    arr.push({
      projectName: l.doc.project.name, docNumber: l.doc.docNumber, type: l.doc.type,
      vendorName: l.doc.vendorName ?? null, description: l.description, pending,
    });
    bySup.set(sid, arr);
  }
  if (bySup.size === 0) return [];

  // Resolve the supervisors' names/emails in one query.
  const users = await prisma.user.findMany({ where: { id: { in: [...bySup.keys()] }, active: true }, select: { id: true, name: true, email: true } });
  return users
    .filter((u) => u.email)
    .map((u) => ({ id: u.id, name: u.name, email: u.email!, deposits: bySup.get(u.id) ?? [] }))
    .filter((s) => s.deposits.length);
}

function reminderHtml(name: string, deposits: PendingDeposit[], link: string): string {
  const total = deposits.reduce((a, d) => a + d.pending, 0);
  const rows = deposits.map((d) => `
        <tr>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${esc(d.projectName)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px;white-space:nowrap">${esc(d.docNumber)} <span style="color:#94a3b8">${esc(d.type)}</span></td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${esc(d.vendorName || '—')}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${esc(d.description)}</td>
          <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:12px;white-space:nowrap;color:#b45309;font-weight:600">${inr(d.pending)}</td>
        </tr>`).join('');
  return `<div style="font-family:system-ui,sans-serif;max-width:680px;margin:0 auto;color:#0f172a">
          <p>Hi ${esc(name)},</p>
          <p>You are the site supervisor for the project(s) below. These <strong>vendor deposits are still pending recovery</strong> — please follow up so we get them back / adjusted.</p>
          <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;margin-top:8px">
            <thead><tr style="background:#052379;color:#fff">
              <th style="padding:6px 8px;text-align:left;font-size:11px">Project</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px">PO/WO</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px">Vendor</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px">Item</th>
              <th style="padding:6px 8px;text-align:right;font-size:11px;white-space:nowrap">Pending</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr style="background:#f8fafc">
              <td colspan="4" style="padding:6px 8px;border-top:2px solid #cbd5e1;font-size:12px;font-weight:600;text-align:right">Total pending</td>
              <td style="padding:6px 8px;border-top:2px solid #cbd5e1;font-size:12px;font-weight:700;text-align:right;color:#b45309;white-space:nowrap">${inr(total)}</td>
            </tr></tfoot>
          </table>
          <p style="margin:22px 0"><a href="${link}" style="background:#052379;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Open Deposit Tracking</a></p>
          <p style="font-size:12px;color:#64748b">Or paste this link in your browser:<br>${link}</p>
        </div>`;
}

// Send one consolidated reminder per site supervisor. `dryRun` returns the plan
// without emailing (used by the test harness).
export async function sendPendingDepositReminders(opts: { dryRun?: boolean } = {}) {
  const groups = await collectPendingBySupervisor();
  let sent = 0;
  const link = `${appClientUrl()}/deposits`;
  for (const g of groups) {
    if (opts.dryRun) { sent++; continue; }
    if (!isEmailEnabled()) continue;
    try {
      await sendEmail({
        to: g.email,
        subject: `Pending deposit recovery — ${g.deposits.length} item(s)`,
        html: reminderHtml(g.name, g.deposits, link),
      });
      sent++;
    } catch { /* best-effort — retried on the next weekly slot */ }
  }
  return { supervisors: groups.length, sent, groups };
}

// Background poll. Disabled when DEPOSIT_REMINDERS=off (local dev, so it never
// emails real supervisors). Fires once a week — on the configured weekday/hour
// (default Monday 09:00 server-time) — guarded so a given ISO week sends at most
// once per process. Polls hourly to catch the target hour.
let sentWeekKey = '';
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${week}`;
}
export function startPendingDepositReminderPoll() {
  if (process.env.DEPOSIT_REMINDERS === 'off') { console.log('Deposit reminders: disabled (DEPOSIT_REMINDERS=off)'); return; }
  const targetDay = Number(process.env.DEPOSIT_REMINDER_DAY ?? 1);   // 0=Sun … 1=Mon
  const targetHour = Number(process.env.DEPOSIT_REMINDER_HOUR ?? 9);
  const tick = () => {
    const now = new Date();
    if (now.getDay() !== targetDay || now.getHours() < targetHour) return;
    const wk = isoWeekKey(now);
    if (wk === sentWeekKey) return;                                  // already sent this week
    sentWeekKey = wk;
    sendPendingDepositReminders()
      .then((r) => { if (r.sent) console.log(`Deposit reminders: emailed ${r.sent} of ${r.supervisors} site supervisor(s)`); })
      .catch((e) => console.error('[deposit-reminder]', e));
  };
  setTimeout(tick, 120_000);
  setInterval(tick, 3600_000);
}
