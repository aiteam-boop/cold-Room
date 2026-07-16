// ── API-key authentication & enforcement (public v1 API) ──────────────────────
// Runs before every /api/v1 route (mounted ahead of the session-auth routers, so
// the KEY path — not the cookie path — gates v1). Order is deliberate:
//   1 read key   2 verify (fail closed, one generic reason)   3 IP allowlist
//   4 rate limit (+ X-RateLimit-* on every response)   5 attach req.apiKey
//   6 touch telemetry (fire-and-forget)   7 audit-log the request on finish.
// Telemetry and the audit write are never awaited and can never fail the request.

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { readApiKey } from '../lib/apiKey';
import { verifyApiKey } from '../services/apiKeyService';
import { apiError } from '../lib/apiEnvelope';
import { REALMS, type RealmKey } from '../lib/apiScopes';
import { noteCallForAlert } from '../lib/apiKeyAnomaly';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: { id: string; name: string; realms: string[]; scopes: string[] };
    }
  }
}

// ── In-memory fixed-window rate limiter, keyed by KEY id (not IP) ──────────────
// So one integration can never starve another. Resets on process restart.
const windows = new Map<string, { start: number; count: number }>();
function rateHit(keyId: string, limit: number): { limited: boolean; remaining: number; resetSec: number } {
  const now = Date.now();
  let w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) { w = { start: now, count: 0 }; windows.set(keyId, w); }
  w.count += 1;
  const remaining = Math.max(limit - w.count, 0);
  const resetSec = Math.ceil((w.start + 60_000) / 1000);
  return { limited: w.count > limit, remaining, resetSec };
}

// ── IP allowlist (plain IPv4 + CIDR) ──────────────────────────────────────────
function ipToLong(ip: string): number | null {
  const p = ip.trim().split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) { const o = Number(part); if (!Number.isInteger(o) || o < 0 || o > 255) return null; n = n * 256 + o; }
  return n >>> 0;
}
function ipAllowed(clientIp: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const ip = clientIp.replace(/^::ffff:/, ''); // unwrap IPv4-mapped IPv6
  const ipL = ipToLong(ip);
  for (const entry of allowlist) {
    const e = entry.trim();
    if (!e) continue;
    if (e.includes('/')) {
      const [base, bitsStr] = e.split('/');
      const baseL = ipToLong(base); const bits = Number(bitsStr);
      if (baseL == null || ipL == null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((ipL & mask) === (baseL & mask)) return true;
    } else if (e === ip) return true;
  }
  return false;
}

export function clientIp(req: Request): string {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return (fwd || req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  // 1. Read the raw key.
  const raw = readApiKey(req);
  if (!raw) return apiError(res, 401, 'missing_key', 'Send your key as "X-API-Key: crmk_…" or "Authorization: Bearer crmk_…".');

  // 2. Verify. A DB fault → server_error 500 (not invalid_key). Any other
  //    failure → null → one generic invalid_key 401 (never say why).
  let key;
  try {
    key = await verifyApiKey(raw);
  } catch {
    return apiError(res, 500, 'server_error', 'Could not verify the key right now. Try again shortly.');
  }
  if (!key) return apiError(res, 401, 'invalid_key', 'Invalid or revoked API key.');

  const ip = clientIp(req);
  const route = req.originalUrl.split('?')[0];

  // Audit + telemetry: attached now so it captures the FINAL status even if a
  // later gate (realm/scope) rejects. Fire-and-forget on finish.
  const startedAt = Date.now();
  res.on('finish', () => {
    const status = res.statusCode;
    // ApiKeyCall is a CAPPED collection, and MongoDB forbids writes in a
    // transaction on capped collections — Prisma's create() wraps writes in one,
    // so insert via a raw (non-transactional) command instead. Extended JSON for
    // the Date per $runCommandRaw's contract. Fire-and-forget.
    prisma.$runCommandRaw({ insert: 'ApiKeyCall', documents: [{ _id: crypto.randomBytes(12).toString('hex'), keyId: key!.id, method: req.method, route, status, ms: Date.now() - startedAt, ip, at: { $date: new Date().toISOString() } }] }).catch(() => {});
    try { noteCallForAlert({ id: key!.id, name: key!.name, rateLimitPerMin: key!.rateLimitPerMin, ipAllowlist: key!.ipAllowlist }, ip, status); } catch { /* never fail a request on telemetry */ }
    if (status >= 200 && status < 400) {
      const day = new Date().toISOString().slice(0, 10);
      prisma.apiKey.update({ where: { id: key!.id }, data: { lastUsedAt: new Date(), callCount: { increment: 1 } } }).catch(() => {});
      prisma.apiKeyUsage.upsert({ where: { keyId_day: { keyId: key!.id, day } }, create: { keyId: key!.id, day, count: 1 }, update: { count: { increment: 1 } } }).catch(() => {});
    }
  });

  // 3. IP allowlist.
  if (!ipAllowed(ip, key.ipAllowlist)) {
    return apiError(res, 403, 'ip_not_allowed', 'Your IP is not on this key’s allowlist.');
  }

  // 4. Rate limit — headers on EVERY response (success and 429).
  const rl = rateHit(key.id, key.rateLimitPerMin);
  res.setHeader('X-RateLimit-Limit', String(key.rateLimitPerMin));
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  res.setHeader('X-RateLimit-Reset', String(rl.resetSec));
  if (rl.limited) {
    res.setHeader('Retry-After', String(Math.max(rl.resetSec - Math.ceil(Date.now() / 1000), 1)));
    return apiError(res, 429, 'rate_limited', `Rate limit of ${key.rateLimitPerMin}/min exceeded.`);
  }

  // 5. Attach identity — nothing else sets this.
  req.apiKey = { id: key.id, name: key.name, realms: key.realms, scopes: key.scopes };
  next();
}

/** Gate a route by realm. Missing realm → 403 forbidden_realm. For a realm that
 *  requiresScope (Finance/Vendors), the missing scope → 403 forbidden_scope: the
 *  whole domain is that sensitive. */
export function requireRealm(realm: RealmKey) {
  const def = REALMS.find((r) => r.key === realm);
  return (req: Request, res: Response, next: NextFunction) => {
    const k = req.apiKey!;
    if (!k.realms.includes(realm)) return apiError(res, 403, 'forbidden_realm', `This key can’t reach the "${realm}" realm.`);
    if (def?.requiresScope && !k.scopes.includes(def.requiresScope)) {
      return apiError(res, 403, 'forbidden_scope', `The ${realm} realm requires the ${def.requiresScope} scope.`);
    }
    next();
  };
}

/** Gate a mutation by write scope. Missing scope → 403 forbidden_scope. */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.apiKey!.scopes.includes(scope)) return apiError(res, 403, 'forbidden_scope', `This action requires the ${scope} scope.`);
    next();
  };
}
