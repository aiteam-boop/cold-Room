// ── Public API response envelope + error vocabulary ──────────────────────────
// Every /api/v1 response goes through these helpers so the contract is uniform:
//   list  → { data: [...], page: { limit, offset, total, hasMore } }
//   item  → { data: {...} }
//   error → { error: { code, message, ...detail } }
// The `code` vocabulary is fixed; middleware and routes only ever build errors
// through apiError so a stray shape can never ship.

import type { Response, Request } from 'express';

export type ApiErrorCode =
  | 'missing_key' | 'invalid_key' | 'forbidden_realm' | 'forbidden_scope'
  | 'ip_not_allowed' | 'rate_limited' | 'not_found' | 'validation_error' | 'server_error';

export function apiError(res: Response, status: number, code: ApiErrorCode, message: string, detail?: Record<string, unknown>) {
  return res.status(status).json({ error: { code, message, ...(detail || {}) } });
}

export function apiItem(res: Response, data: unknown, meta?: Record<string, unknown>) {
  return res.json({ data, ...(meta ? { _meta: meta } : {}) });
}

export function apiList(res: Response, data: unknown[], page: { limit: number; offset: number; total: number }, meta?: Record<string, unknown>) {
  return res.json({
    data,
    page: { limit: page.limit, offset: page.offset, total: page.total, hasMore: page.offset + data.length < page.total },
    ...(meta ? { _meta: meta } : {}),
  });
}

// Bounded, non-negative pagination params. limit defaults 50, capped at 200.
export function parseListParams(req: Request): { limit: number; offset: number } {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0;
  return { limit, offset };
}
