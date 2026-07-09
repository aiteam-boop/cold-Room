import crypto from 'crypto';

// Shareable, capability-style links for server-rendered files (e.g. the PO/WO/GRN
// PDF URLs we export into Google Sheets). A link clicked out of an external app
// (Sheets, email) cannot send an "Authorization: Bearer" header, so instead we
// bind a short HMAC signature to the exact URL path and append it as ?sig=...
// The signature grants read access to that ONE path and nothing else.
//
// Reuses JWT_SECRET so no new env var is needed — same fallback as lib/auth.
const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

/** HMAC signature for a URL path (query string excluded). */
export function signPath(pathname: string): string {
  return crypto.createHmac('sha256', SECRET).update(pathname).digest('hex').slice(0, 32);
}

/** Turn a stored API path into a signed, browser-openable path: "/api/..?sig=..". */
export function signApiPath(pathname: string): string {
  return `${pathname}?sig=${signPath(pathname)}`;
}

/** Constant-time check that `sig` is a valid signature for `pathname`. */
export function verifyPathSignature(pathname: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = signPath(pathname);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
