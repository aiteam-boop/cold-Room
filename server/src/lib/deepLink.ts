// ── Deep links (Integration Kit) ─────────────────────────────────────────────
// Every entity the public API returns carries a `deepLink`: a URL that, when
// clicked, opens THAT item directly in the CRMCTS dashboard. The link points at a
// resolver route (/go/:entity/:id) that signs the user in if needed, then lands
// them on the right project tab with the item open.

import { appClientUrl } from '../services/email';

export type DeepEntity = 'project' | 'po' | 'wo' | 'grn' | 'payment' | 'vendor' | 'task' | 'boq';

/** Build the deep link for an entity. `projectId` is needed for project-scoped ones. */
export function deepLink(entity: DeepEntity, id: string, projectId?: string): string {
  const base = appClientUrl().replace(/\/$/, '');
  const q = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
  return `${base}/go/${entity}/${encodeURIComponent(id)}${q}`;
}
