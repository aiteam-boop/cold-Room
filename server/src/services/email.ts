// Email delivery. Two backends, chosen at runtime:
//   1. Mailgun HTTP API  — used when MAILGUN_API_KEY is set (our production path).
//   2. SMTP (nodemailer) — fallback when only SMTP_* is configured.
// If neither is configured the service is a graceful no-op that just logs, so
// the app (and in-app notifications) keep working locally with no mail server.

import nodemailer, { Transporter } from 'nodemailer';

// ── Backend selection ────────────────────────────────────────────────────────
function mailgunEnabled(): boolean {
  return !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
}
function smtpEnabled(): boolean {
  return !!process.env.SMTP_HOST;
}
export function isEmailEnabled(): boolean {
  return mailgunEnabled() || smtpEnabled();
}

// The From address, shared by both backends. Prefer MAIL_FROM, then SMTP_FROM.
function fromAddress(): string {
  return process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || 'CRMCTS <no-reply@crmcts.local>';
}

// ── SMTP transport (lazy, cached) ────────────────────────────────────────────
let cached: Transporter | null | undefined; // undefined = not yet built
function transporter(): Transporter | null {
  if (cached !== undefined) return cached;
  const host = process.env.SMTP_HOST;
  if (!host) { cached = null; return null; }
  cached = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return cached;
}

export interface EmailAttachment { filename: string; content: Buffer; contentType?: string }
export interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

// ── Mailgun HTTP API ─────────────────────────────────────────────────────────
// US region → api.mailgun.net, EU → api.eu.mailgun.net. Uses global fetch +
// FormData (Node 18+). Auth is HTTP Basic with username "api" and the API key.
// FormData (multipart) is used so file attachments — e.g. the PO/WO/GRN PDF —
// ride along; do NOT set Content-Type, fetch adds the multipart boundary.
async function sendViaMailgun({ to, subject, html, text, attachments }: EmailInput): Promise<boolean> {
  const key = process.env.MAILGUN_API_KEY!;
  const domain = process.env.MAILGUN_DOMAIN!;
  const base = (process.env.MAILGUN_REGION || 'US').toUpperCase() === 'EU'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net';

  const form = new FormData();
  form.set('from', fromAddress());
  form.set('to', to);
  form.set('subject', subject);
  form.set('html', html);
  form.set('text', text ?? html.replace(/<[^>]+>/g, ' '));
  for (const a of attachments ?? []) {
    form.append('attachment', new Blob([a.content], { type: a.contentType || 'application/octet-stream' }), a.filename);
  }

  const res = await fetch(`${base}/v3/${encodeURIComponent(domain)}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`api:${key}`).toString('base64') },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[email] Mailgun send failed (${res.status}): ${detail.slice(0, 300)}`);
    return false;
  }
  return true;
}

// Send an email. Never throws — logs and resolves false on failure / no-config
// so callers can fire-and-forget alongside in-app notifications.
export async function sendEmail({ to, subject, html, text, attachments }: EmailInput): Promise<boolean> {
  if (!to) return false;
  try {
    if (mailgunEnabled()) return await sendViaMailgun({ to, subject, html, text, attachments });
    const t = transporter();
    if (!t) {
      console.log(`[email] (disabled — no Mailgun / SMTP) would send to ${to}: ${subject}`);
      return false;
    }
    await t.sendMail({ from: fromAddress(), to, subject, html, text: text ?? html.replace(/<[^>]+>/g, ' '), attachments });
    return true;
  } catch (e) {
    console.error('[email] send failed:', e);
    return false;
  }
}

// Base URL of the SERVER (signs + verifies approval tokens; /api lives here).
export function appBaseUrl(): string {
  const raw = process.env.APP_URL || (process.env.CLIENT_ORIGIN || '').split(',')[0] || 'http://localhost:5180';
  return raw.replace(/\/$/, '');
}

// Base URL of the CLIENT app (the React UI with the login page). Used for the
// "Open in App" link so the approver signs in and sees full context. Falls back
// to CLIENT_ORIGIN, then the server URL.
export function appClientUrl(): string {
  const raw = process.env.CLIENT_URL || (process.env.CLIENT_ORIGIN || '').split(',')[0] || process.env.APP_URL || 'http://localhost:5180';
  return raw.replace(/\/$/, '');
}

// A minimal branded HTML wrapper for approval emails.
export function approvalEmailHtml(opts: { heading: string; lines: string[]; actionUrl?: string; actionLabel?: string }): string {
  const body = opts.lines.map((l) => `<p style="margin:6px 0;color:#334155;font-size:14px">${l}</p>`).join('');
  const btn = opts.actionUrl
    ? `<p style="margin:20px 0"><a href="${opts.actionUrl}" style="background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;display:inline-block">${opts.actionLabel ?? 'Open'}</a></p>`
    : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
    <div style="font-weight:700;color:#0f172a;font-size:18px;margin-bottom:4px">CRMCTS</div>
    <h2 style="color:#0f172a;font-size:16px;margin:12px 0 8px">${opts.heading}</h2>
    ${body}${btn}
    <p style="margin-top:20px;color:#94a3b8;font-size:12px">Cold Room Management &amp; Construction Tracking System</p>
  </div>`;
}

// ── Rich approval email (document summary + line items + action buttons) ─────
export function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return '&#8377; ' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export interface ApprovalDocEmail {
  label: string;          // short: PO / WO / GRN
  docLabelLong: string;   // Purchase Order / Work Order / Goods Receipt Note
  number: string;
  vendorName: string | null;
  projectName: string | null;
  stage: string | null;   // e.g. "Director · step 2 of 3"
  totalLabel: string;     // "Final Amount" / "Invoice Value"
  totalAmount: number | null;
  rows: { description: string; qty: number | null; unitPrice: number | null; total: number | null }[];
  approverName: string;
  // The secure review page: it embeds the full document PDF and carries the
  // Approve / On Hold buttons, so the email itself never decides anything.
  viewUrl: string;
  // The app itself — opens CRMCTS, where the approver signs in for full context.
  reviewUrl: string;
  reminder?: boolean;
  // Post-approval amendments (oldest → newest). Non-empty means the document was
  // changed after a previous approval and is coming back for RE-approval, so the
  // approver is shown that fact plus the reason the raiser gave.
  amendments?: { remark: string; byName: string; at: string }[];
}

/** The amber "resubmitted after amendment" block — the reason it needs re-approval. */
function amendmentBanner(amendments: { remark: string; byName: string; at: string }[] | undefined): string {
  if (!amendments?.length) return '';
  const latest = amendments[amendments.length - 1];
  const earlier = amendments.slice(0, -1).reverse();
  const when = latest.at ? new Date(latest.at).toLocaleString('en-GB') : '';
  const earlierHtml = earlier.length
    ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #fde68a">
         <div style="font-size:11px;color:#b45309;text-transform:uppercase;letter-spacing:.3px">Earlier amendments (${earlier.length})</div>
         ${earlier.map((a) => `<div style="font-size:12px;color:#78350f;margin-top:4px">&bull; ${escapeHtml(a.remark)}<span style="color:#b45309"> — ${escapeHtml(a.byName)}${a.at ? ` · ${escapeHtml(new Date(a.at).toLocaleString('en-GB'))}` : ''}</span></div>`).join('')}
       </div>`
    : '';
  return `<div style="margin-top:14px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 14px">
      <div style="font-size:13px;font-weight:700;color:#92400e">&#9888; Resubmitted after amendment — re-approval needed</div>
      <div style="font-size:11px;color:#b45309;text-transform:uppercase;letter-spacing:.3px;margin-top:8px">Reason for the amendment</div>
      <div style="font-size:14px;color:#78350f;margin-top:2px">${escapeHtml(latest.remark)}</div>
      <div style="font-size:12px;color:#b45309;margin-top:4px">&mdash; ${escapeHtml(latest.byName)}${when ? ` · ${escapeHtml(when)}` : ''}</div>
      ${earlierHtml}
    </div>`;
}

// Mirrors the reference layout: header band, summary box, key fields, an items
// table, and Approve / Reject / Open-document buttons. The buttons open a secure
// page (the /act route) that shows the FULL PDF and confirms the decision —
// they don't approve on click, so an email-scanner prefetch can't auto-approve.
export function approvalDocEmailHtml(m: ApprovalDocEmail): string {
  const rowsHtml = m.rows.slice(0, 12).map((r, i) => `
    <tr>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px">${i + 1}</td>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px;color:#0f172a">${escapeHtml((r.description || '—').split('\n')[0])}</td>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:center;font-size:12px">${r.qty ?? ''}</td>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:12px">${r.unitPrice != null ? money(r.unitPrice) : ''}</td>
      <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:12px">${r.total != null ? money(r.total) : ''}</td>
    </tr>`).join('');
  const more = m.rows.length > 12
    ? `<tr><td colspan="5" style="padding:6px 8px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px">+ ${m.rows.length - 12} more line item(s) — see the full document</td></tr>`
    : '';
  const btn = (url: string, bg: string, label: string) =>
    `<td style="padding:0 5px"><a href="${url}" style="background:${bg};color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600;display:inline-block">${label}</a></td>`;

  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;background:#fff">
    <div style="background:#0f2942;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">
      <div style="font-size:12px;letter-spacing:.5px;opacity:.85">CRMCTS &middot; CRYSTAL COLD CHAIN</div>
      <div style="font-size:20px;font-weight:700;margin-top:2px">${m.reminder ? 'Approval Reminder' : (m.amendments?.length ? 'Re-approval Needed' : 'Approval Needed')}</div>
      <div style="font-size:13px;opacity:.85;margin-top:4px">${m.amendments?.length ? 'This document was <b>amended after approval</b> and resubmitted' : 'Awaiting your approval'}${m.stage ? ` at <b>${escapeHtml(m.stage)}</b>` : ''}.</div>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;padding:20px 22px">
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
        <tr>
          <td style="padding:12px 14px">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase">${escapeHtml(m.docLabelLong)}</div>
            <div style="font-size:18px;font-weight:700;color:#0f172a">${escapeHtml(m.number)}</div>
          </td>
          <td style="padding:12px 14px;text-align:right">
            <div style="font-size:11px;color:#64748b;text-transform:uppercase">${escapeHtml(m.totalLabel)}</div>
            <div style="font-size:18px;font-weight:700;color:#0f172a">${money(m.totalAmount)}</div>
          </td>
        </tr>
      </table>

      <table style="width:100%;margin-top:14px;font-size:13px;color:#334155">
        <tr><td style="padding:2px 0;width:110px;color:#64748b">Vendor</td><td style="padding:2px 0;font-weight:600">${escapeHtml(m.vendorName || '—')}</td></tr>
        <tr><td style="padding:2px 0;color:#64748b">Project</td><td style="padding:2px 0">${escapeHtml(m.projectName || '—')}</td></tr>
        <tr><td style="padding:2px 0;color:#64748b">Approver</td><td style="padding:2px 0">${escapeHtml(m.approverName)}</td></tr>
      </table>

      ${amendmentBanner(m.amendments)}

      ${m.rows.length ? `<table style="width:100%;border-collapse:collapse;margin-top:14px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <tr style="background:#0f2942;color:#fff;font-size:11px;text-transform:uppercase">
          <td style="padding:6px 8px">#</td><td style="padding:6px 8px">Description</td>
          <td style="padding:6px 8px;text-align:center">Qty</td><td style="padding:6px 8px;text-align:right">Unit</td><td style="padding:6px 8px;text-align:right">Total</td>
        </tr>${rowsHtml}${more}
      </table>` : ''}

      <div style="margin-top:20px;text-align:center;color:#475569;font-size:13px">Click <b>View ${escapeHtml(m.label)}</b> to read the full document and record your decision there — <b>Approve</b>, or put it <b>On Hold</b> with a note on what needs correcting.</div>
      ${/* The decision buttons live on the review page, so say so on the button
             itself — the approver should not have to guess where to act. */ ''}
      <table style="margin:14px auto 6px"><tr>${btn(m.viewUrl, '#0f2942', `&#128196; View ${escapeHtml(m.label)} (Approve / On Hold)`)}${btn(m.reviewUrl, '#475569', 'Open Dashboard &rarr;')}</tr></table>
      <div style="text-align:center;color:#94a3b8;font-size:11px;margin-top:8px"><b>View ${escapeHtml(m.label)}</b> opens a secure review page showing the whole document with the Approve / On Hold buttons (no login needed, valid 14 days). On Hold sends it back to the raiser to correct and resubmit — nothing is rejected. <b>Open Dashboard</b> opens CRMCTS — sign in to see full context.</div>
    </div>
  </div>`;
}
