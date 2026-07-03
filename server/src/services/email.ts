// Email delivery via SMTP (nodemailer). Configuration is optional: when SMTP_*
// env vars are not set the service is a graceful no-op that just logs — so the
// app (and in-app notifications) keep working locally with no mail server.

import nodemailer, { Transporter } from 'nodemailer';

let cached: Transporter | null | undefined; // undefined = not yet built

function transporter(): Transporter | null {
  if (cached !== undefined) return cached;
  const host = process.env.SMTP_HOST;
  if (!host) {
    cached = null;
    return null;
  }
  cached = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return cached;
}

export function isEmailEnabled(): boolean {
  return !!process.env.SMTP_HOST;
}

export interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// Send an email. Never throws — logs and resolves false on failure / no-config
// so callers can fire-and-forget alongside in-app notifications.
export async function sendEmail({ to, subject, html, text }: EmailInput): Promise<boolean> {
  const t = transporter();
  if (!t) {
    console.log(`[email] (disabled — no SMTP) would send to ${to}: ${subject}`);
    return false;
  }
  if (!to) return false;
  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'CRMCTS <no-reply@crmcts.local>';
    await t.sendMail({ from, to, subject, html, text: text ?? html.replace(/<[^>]+>/g, ' ') });
    return true;
  } catch (e) {
    console.error('[email] send failed:', e);
    return false;
  }
}

// Base URL used to build links inside emails (points at the app; /api is proxied
// there in production). Falls back to the client origin, then localhost.
export function appBaseUrl(): string {
  const raw = process.env.APP_URL || (process.env.CLIENT_ORIGIN || '').split(',')[0] || 'http://localhost:5180';
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
