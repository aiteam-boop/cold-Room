// ── API key management (super-admin only) ─────────────────────────────────────
// Mounted at /api/api-keys. Restricted to the ONE super-admin (requireSuperAdmin),
// because key management is a security surface. Create/rotate return the raw key
// exactly once; list shows only the prefix + metadata + anomaly flags. Every
// action writes the app audit trail with a redacted before/after.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, notFound } from '../lib/errors';
import { requireAuth, requireSuperAdmin } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { generateApiKey } from '../lib/apiKey';
import { REALMS, SCOPES, REALM_KEYS, SCOPE_KEYS } from '../lib/apiScopes';
import { computeFlags, type CallLite } from '../lib/apiKeyAnomaly';

const router = Router();
router.use(requireAuth);
router.use(requireSuperAdmin);

const statusOf = (k: { active: boolean; expiresAt: Date | null }) =>
  !k.active ? 'revoked' : k.expiresAt && k.expiresAt.getTime() < Date.now() ? 'expired' : 'active';

// A key's non-secret shape, for audit before/after (never includes keyHash).
const redact = (k: { name: string; realms: string[]; scopes: string[]; ipAllowlist: string[]; rateLimitPerMin: number; expiresAt: Date | null; active: boolean }) =>
  ({ name: k.name, realms: k.realms, scopes: k.scopes, ipAllowlist: k.ipAllowlist, rateLimitPerMin: k.rateLimitPerMin, expiresAt: k.expiresAt, active: k.active });

// GET /meta — realm & scope definitions for the create form.
router.get('/meta', asyncHandler(async (_req, res) => {
  res.json({ realms: REALMS, scopes: SCOPES });
}));

// GET / — list keys (never the secret) + summary + per-key anomaly flags.
router.get('/', asyncHandler(async (_req, res) => {
  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, prefix: true, mode: true, realms: true, scopes: true, rateLimitPerMin: true,
      ipAllowlist: true, expiresAt: true, active: true, revokedAt: true, revokedByName: true, rotatedAt: true,
      callCount: true, createdAt: true, createdByName: true, lastUsedAt: true,
    },
  });
  // One 24h window of calls for all keys → flags computed in JS (bounded read).
  const since = new Date(Date.now() - 24 * 3600_000);
  const recent = await prisma.apiKeyCall.findMany({ where: { at: { gte: since } }, select: { keyId: true, status: true, ip: true, at: true }, take: 20000 });
  const byKey = new Map<string, CallLite[]>();
  for (const c of recent) { const a = byKey.get(c.keyId) ?? []; a.push(c); byKey.set(c.keyId, a); }

  const rows = keys.map((k) => ({
    ...k,
    status: statusOf(k),
    flags: computeFlags(byKey.get(k.id) ?? [], { id: k.id, name: k.name, rateLimitPerMin: k.rateLimitPerMin, ipAllowlist: k.ipAllowlist }),
  }));
  const summary = {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    revoked: rows.filter((r) => r.status !== 'active').length,
    callsServed: rows.reduce((s, r) => s + r.callCount, 0),
    flagged: rows.filter((r) => r.flags.length > 0).length,
  };
  res.json({ keys: rows, summary });
}));

const configSchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name.').max(80),
  mode: z.enum(['live', 'test']).default('live'),
  realms: z.array(z.enum(REALM_KEYS as [string, ...string[]])).min(1, 'Grant at least one realm.'),
  scopes: z.array(z.enum(SCOPE_KEYS as [string, ...string[]])).default([]),
  rateLimitPerMin: z.coerce.number().int().min(1).max(100_000).default(600),
  expiresAt: z.string().datetime().optional().nullable(),
  ipAllowlist: z.array(z.string().trim()).default([]),
});

function resolveConfig(input: z.infer<typeof configSchema>) {
  const scopes = Array.from(new Set(['read:core', ...input.scopes]));
  for (const realm of input.realms) {
    const def = REALMS.find((r) => r.key === realm);
    if (def?.requiresScope && !scopes.includes(def.requiresScope)) {
      throw badRequest(`The "${def.label}" realm needs the ${def.requiresScope} scope — add it or drop the realm.`);
    }
  }
  const ipAllowlist = input.ipAllowlist.map((s) => s.trim()).filter(Boolean);
  return { mode: input.mode, realms: input.realms, scopes, rateLimitPerMin: input.rateLimitPerMin, ipAllowlist, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null };
}

// POST / — create. Returns the raw key ONCE.
router.post('/', asyncHandler(async (req, res) => {
  const input = configSchema.parse(req.body);
  const cfg = resolveConfig(input);
  const { raw, keyHash, prefix } = generateApiKey(cfg.mode);
  const key = await prisma.apiKey.create({ data: { name: input.name, keyHash, prefix, createdById: req.user!.sub, createdByName: req.user!.name, ...cfg } });
  await audit({ userId: req.user!.sub, action: 'API_KEY_CREATE', entity: 'ApiKey', entityId: key.id, details: { after: redact(key) } });
  res.status(201).json({ id: key.id, name: key.name, prefix: key.prefix, key: raw }); // shown once
}));

// PATCH /:id — edit config (name/realms/scopes/ip/rate/expiry). Audited before/after.
router.patch('/:id', asyncHandler(async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
  if (!key) throw notFound('API key not found');
  const input = configSchema.parse({ name: req.body.name ?? key.name, mode: key.mode, realms: req.body.realms ?? key.realms, scopes: req.body.scopes ?? key.scopes.filter((s) => s !== 'read:core'), rateLimitPerMin: req.body.rateLimitPerMin ?? key.rateLimitPerMin, expiresAt: req.body.expiresAt ?? (key.expiresAt ? key.expiresAt.toISOString() : null), ipAllowlist: req.body.ipAllowlist ?? key.ipAllowlist });
  const cfg = resolveConfig(input);
  const before = redact(key);
  const updated = await prisma.apiKey.update({ where: { id: key.id }, data: { name: input.name, realms: cfg.realms, scopes: cfg.scopes, rateLimitPerMin: cfg.rateLimitPerMin, expiresAt: cfg.expiresAt, ipAllowlist: cfg.ipAllowlist } });
  await audit({ userId: req.user!.sub, action: 'API_KEY_EDIT', entity: 'ApiKey', entityId: key.id, details: { before, after: redact(updated) } });
  res.json({ ok: true });
}));

// POST /:id/rotate — new secret, same config + usage log. Returns raw ONCE.
router.post('/:id/rotate', asyncHandler(async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
  if (!key) throw notFound('API key not found');
  const { raw, keyHash, prefix } = generateApiKey(key.mode as 'live' | 'test');
  await prisma.apiKey.update({ where: { id: key.id }, data: { keyHash, prefix, active: true, revokedAt: null, revokedByName: null, rotatedAt: new Date() } });
  await audit({ userId: req.user!.sub, action: 'API_KEY_ROTATE', entity: 'ApiKey', entityId: key.id, details: { name: key.name } });
  res.json({ id: key.id, name: key.name, prefix, key: raw }); // shown once
}));

// GET /:id/usage — the audit log + forensics (success/error split, top routes, sparkline).
router.get('/:id/usage', asyncHandler(async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, callCount: true, lastUsedAt: true, rateLimitPerMin: true, ipAllowlist: true } });
  if (!key) throw notFound('API key not found');
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const calls = await prisma.apiKeyCall.findMany({ where: { keyId: key.id }, orderBy: { at: 'desc' }, take: limit, select: { at: true, method: true, route: true, status: true, ms: true, ip: true } });

  const ok = calls.filter((c) => c.status < 400).length;
  const routes = new Map<string, number>();
  for (const c of calls) routes.set(c.route, (routes.get(c.route) || 0) + 1);
  const topRoutes = [...routes.entries()].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count).slice(0, 8);
  // requests/min sparkline over the window that the log covers.
  const spark = new Map<number, number>();
  for (const c of calls) { const m = Math.floor(c.at.getTime() / 60000); spark.set(m, (spark.get(m) || 0) + 1); }
  const sparkline = [...spark.entries()].sort((a, b) => a[0] - b[0]).map(([, count]) => count).slice(-60);

  const flags = computeFlags(calls.filter((c) => c.at.getTime() > Date.now() - 24 * 3600_000) as CallLite[], { id: key.id, name: key.name, rateLimitPerMin: key.rateLimitPerMin, ipAllowlist: key.ipAllowlist });
  res.json({ id: key.id, name: key.name, totalCalls: key.callCount, lastUsedAt: key.lastUsedAt, rateLimitPerMin: key.rateLimitPerMin, stats: { shown: calls.length, ok, errors: calls.length - ok }, topRoutes, sparkline, flags, calls });
}));

// POST /:id/revoke — disable immediately (fails closed on the next request).
router.post('/:id/revoke', asyncHandler(async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
  if (!key) throw notFound('API key not found');
  if (!key.active) throw badRequest('This key is already revoked.');
  await prisma.apiKey.update({ where: { id: key.id }, data: { active: false, revokedAt: new Date(), revokedByName: req.user!.name } });
  await audit({ userId: req.user!.sub, action: 'API_KEY_REVOKE', entity: 'ApiKey', entityId: key.id, details: { name: key.name } });
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
  if (!key) throw notFound('API key not found');
  await prisma.apiKey.delete({ where: { id: key.id } });
  await prisma.apiKeyUsage.deleteMany({ where: { keyId: key.id } });
  await prisma.apiIdempotencyRecord.deleteMany({ where: { keyId: key.id } });
  // ApiKeyCall is a capped collection (its size cap IS retention) — rows there
  // are not deleted per-key; they age out.
  await audit({ userId: req.user!.sub, action: 'API_KEY_DELETE', entity: 'ApiKey', entityId: key.id, details: { name: key.name } });
  res.json({ ok: true });
}));

export default router;
