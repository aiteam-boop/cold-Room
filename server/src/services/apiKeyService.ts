// ── API key verification service (the crypto gate) ───────────────────────────
// verifyApiKey is the ONLY place a raw key is turned into a key document. It
// fails closed and reason-lessly: every rejection returns null, and the caller
// maps null to a single generic invalid_key 401 — never leaking WHY it failed
// (bad shape, unknown, revoked, expired, inactive all look identical).
//
// A genuine DB error is NOT caught here: it propagates so the middleware can
// answer server_error 500 instead of invalid_key (don't send an operator
// chasing a rotation during an outage).

import { prisma } from '../lib/prisma';
import { hashApiKey, isValidKeyShape, timingSafeHexEqual } from '../lib/apiKey';

export interface VerifiedKey {
  id: string; name: string; realms: string[]; scopes: string[];
  ipAllowlist: string[]; rateLimitPerMin: number;
}

export async function verifyApiKey(raw: string): Promise<VerifiedKey | null> {
  // 1. Cheap shape check — bogus input never hits the DB.
  if (!isValidKeyShape(raw)) return null;

  // 2. Exact lookup by hash (a DB error here throws → middleware returns 500).
  const computed = hashApiKey(raw);
  const key = await prisma.apiKey.findUnique({
    where: { keyHash: computed },
    select: { id: true, name: true, keyHash: true, realms: true, scopes: true, ipAllowlist: true, rateLimitPerMin: true, active: true, revokedAt: true, expiresAt: true },
  });
  if (!key) return null;

  // 3. Constant-time re-compare (belt-and-braces over the exact lookup).
  if (!timingSafeHexEqual(key.keyHash, computed)) return null;

  // 4. Status gates — fail closed on any of these.
  if (key.active !== true) return null;
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return null;

  // 5. Success — hand back only what the request path needs.
  return { id: key.id, name: key.name, realms: key.realms, scopes: key.scopes, ipAllowlist: key.ipAllowlist, rateLimitPerMin: key.rateLimitPerMin };
}
