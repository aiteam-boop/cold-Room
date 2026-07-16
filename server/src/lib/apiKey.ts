// ── API keys (Integration Kit) ───────────────────────────────────────────────
// A key is `crmk_live_<random>` (or `crmk_test_<random>`). Only its SHA-256 hash
// is stored, so the DB never holds a usable secret. The raw key is shown to the
// admin ONCE at creation (or rotation).

import crypto from 'crypto';

const PREFIX = 'crmk_';

export type KeyMode = 'live' | 'test';

/** Mint a new key for the given mode. Returns the raw key (show once) + what to persist. */
export function generateApiKey(mode: KeyMode = 'live'): { raw: string; keyHash: string; prefix: string } {
  const raw = `${PREFIX}${mode}_${crypto.randomBytes(24).toString('base64url')}`;
  // A recognisable, non-secret display stub, e.g. "crmk_live_9fA2b…".
  return { raw, keyHash: hashApiKey(raw), prefix: raw.slice(0, PREFIX.length + mode.length + 1 + 5) + '…' };
}

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw.trim()).digest('hex');
}

// Cheap shape check so bogus input never reaches the DB. Our keys are
// `crmk_<mode>_<base64url>` — the mode plus a high-entropy random tail.
export const KEY_SHAPE = /^crmk_(live|test)_[A-Za-z0-9_-]{20,}$/;
export function isValidKeyShape(raw: string): boolean {
  return KEY_SHAPE.test(raw.trim());
}

// Constant-time comparison of two hex-encoded SHA-256 digests. Length is not
// secret (both are 32-byte SHA-256), so a length mismatch may short-circuit;
// the byte comparison itself is timing-safe. Belt-and-braces over the exact
// keyHash lookup — guards against any future fuzzy match.
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Pull the key off a request — `X-API-Key: crmk_…` or `Authorization: Bearer crmk_…`. */
export function readApiKey(req: { header(name: string): string | undefined }): string | null {
  const x = req.header('x-api-key');
  if (x && x.startsWith(PREFIX)) return x.trim();
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ') && auth.slice(7).startsWith(PREFIX)) return auth.slice(7).trim();
  return null;
}
