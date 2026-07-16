// ── API key anomaly detection (leak / abuse forensics) ───────────────────────
// Cheap signals computed over the ApiKeyCall audit log, surfaced on the key row
// and used to alert on likely compromise. Two entry points:
//   • computeFlags(calls, key)  — pure; for the admin UI (display).
//   • noteCallForAlert(...)     — in-memory, debounced; fires email alerts.

import { sendEmail, isEmailEnabled } from '../services/email';
import { SUPERADMIN_EMAIL } from '../middleware/authMiddleware';

export interface CallLite { status: number; ip: string; at: Date }
export interface KeyLite { id: string; name: string; rateLimitPerMin: number; ipAllowlist: string[] }

export type Flag =
  | { code: 'error_spike'; severity: 'high'; detail: string }
  | { code: 'ip_scatter'; severity: 'medium'; detail: string }
  | { code: 'new_ip'; severity: 'high'; detail: string }
  | { code: 'rate_hug'; severity: 'medium'; detail: string }
  | { code: 'dormant_active'; severity: 'medium'; detail: string };

// Compute display flags from the last-24h call window for one key.
export function computeFlags(calls: CallLite[], key: KeyLite): Flag[] {
  const flags: Flag[] = [];
  if (!calls.length) return flags;

  const total = calls.length;
  const errors = calls.filter((c) => c.status >= 400).length;
  if (total >= 20 && errors / total > 0.3) {
    flags.push({ code: 'error_spike', severity: 'high', detail: `${Math.round((errors / total) * 100)}% of ${total} recent calls errored — possible probing/leak.` });
  }

  const ips = new Set(calls.map((c) => c.ip));
  if (ips.size >= 5) flags.push({ code: 'ip_scatter', severity: 'medium', detail: `${ips.size} distinct IPs in 24h.` });

  // For an allowlisted key, any recent IP outside the allowlist is suspicious
  // (the request was blocked, but the attempt matters).
  if (key.ipAllowlist.length) {
    const outside = [...ips].filter((ip) => !key.ipAllowlist.includes(ip.replace(/^::ffff:/, '')));
    if (outside.length) flags.push({ code: 'new_ip', severity: 'high', detail: `Used from ${outside.length} IP(s) outside the allowlist.` });
  }

  // Rate-ceiling hugging: any single minute at ≥80% of the limit.
  const byMin = new Map<number, number>();
  for (const c of calls) { const m = Math.floor(c.at.getTime() / 60000); byMin.set(m, (byMin.get(m) || 0) + 1); }
  const peak = Math.max(0, ...byMin.values());
  if (peak >= key.rateLimitPerMin * 0.8) flags.push({ code: 'rate_hug', severity: 'medium', detail: `Peaked at ${peak}/min vs ${key.rateLimitPerMin} limit.` });

  return flags;
}

// ── Live alerting (in-memory, debounced) ──────────────────────────────────────
const seenIps = new Map<string, Set<string>>();        // keyId → IPs seen this process
const errWindow = new Map<string, { start: number; total: number; errors: number }>();
const lastAlert = new Map<string, number>();            // dedupe key → ts (1h debounce)

function debounced(k: string): boolean {
  const now = Date.now();
  const prev = lastAlert.get(k);
  if (prev && now - prev < 3_600_000) return false;
  lastAlert.set(k, now);
  return true;
}

async function alert(key: KeyLite, subject: string, body: string) {
  if (!isEmailEnabled()) { console.warn(`[api-key-alert] ${key.name}: ${subject}`); return; }
  // Never include the raw key. Notify the super-admin (the key owner surface).
  await sendEmail({ to: SUPERADMIN_EMAIL, subject: `[API key] ${subject}`, html: `<p>${body}</p><p>Key: <b>${key.name}</b> (${key.id})</p>`, text: `${body}\nKey: ${key.name} (${key.id})` }).catch(() => {});
}

// Called fire-and-forget from the request finish handler.
export function noteCallForAlert(key: KeyLite, ip: string, status: number): void {
  const cleanIp = ip.replace(/^::ffff:/, '');

  // New-IP on an allowlisted key → high severity.
  let ips = seenIps.get(key.id);
  if (!ips) { ips = new Set(); seenIps.set(key.id, ips); }
  const known = ips.has(cleanIp);
  ips.add(cleanIp);
  if (!known && key.ipAllowlist.length && !key.ipAllowlist.includes(cleanIp) && debounced(`newip:${key.id}:${cleanIp}`)) {
    void alert(key, `unexpected IP ${cleanIp}`, `Key "${key.name}" was used from ${cleanIp}, which is not on its IP allowlist.`);
  }

  // Sustained error rate → high severity.
  const now = Date.now();
  let w = errWindow.get(key.id);
  if (!w || now - w.start >= 300_000) { w = { start: now, total: 0, errors: 0 }; errWindow.set(key.id, w); }
  w.total += 1; if (status >= 400) w.errors += 1;
  if (w.total >= 20 && w.errors / w.total > 0.5 && debounced(`errspike:${key.id}`)) {
    void alert(key, `error spike (${w.errors}/${w.total})`, `Key "${key.name}" is returning a high error rate — it may be leaked or being probed.`);
  }
}
