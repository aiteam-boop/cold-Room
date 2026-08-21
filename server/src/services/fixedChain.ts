// Fixed approval chain (admin-configured, per document type).
//
// Before this, a creator hand-picked approvers in a popup on every submit. Now
// an admin configures the chain ONCE (Users → Approval Chain) and every future
// PO / WO / GRN / Vendor Payment routes through it automatically.
//
// How it composes with the existing value-band matrix (ApprovalRule):
//   • The matrix still governs *value* — who is MANDATORY for a given amount.
//   • The fixed chain governs *order* — who signs, in what sequence.
//   • When a fixed chain exists it is used as-is; any approver the matrix makes
//     mandatory for this amount but who is missing from the fixed chain is
//     APPENDED, so a large PO can still never be routed around Finance.
//   • When no fixed chain exists, behaviour is exactly as before (matrix chain,
//     else the legacy hand-picked chain). Nothing regresses.

import { prisma } from '../lib/prisma';
import { chainForAmount, type MatrixDocType } from './approvalMatrix';

export type ChainDocType = MatrixDocType; // PO | WO | GRN | PAYMENT

export interface ChainStep { approverId: string; approverName: string; approverRole: string | null }

export interface ResolvedChain {
  approverIds: string[];
  steps: ChainStep[];
  /**
   * The chain grouped into ordered STEPS. Each inner array is one step: when it
   * holds 2+ approvers they are all notified at once and ANY ONE approving passes
   * the step (Approval Chain · same "order"). A single-approver step is just a
   * one-element group, so a plain sequential chain is `[[a],[b],[c]]`.
   */
  groups: string[][];
  /** 'fixed' = admin chain, 'matrix' = derived from value bands, 'none' = nothing configured. */
  source: 'fixed' | 'matrix' | 'none';
  scope: 'project' | 'global' | 'none';
}

/** Group ordered rows into step-buckets, preserving order and de-duplicating ids. */
export function groupByOrder(rows: { approverId: string; order: number }[]): string[][] {
  const seen = new Set<string>();
  const byOrder = new Map<number, string[]>();
  for (const r of [...rows].sort((a, b) => a.order - b.order)) {
    if (seen.has(r.approverId)) continue;
    seen.add(r.approverId);
    const bucket = byOrder.get(r.order) ?? [];
    bucket.push(r.approverId);
    byOrder.set(r.order, bucket);
  }
  return [...byOrder.keys()].sort((a, b) => a - b).map((o) => byOrder.get(o)!);
}

/** The admin-configured chain for a doc type. Project rules override globals. */
export async function fixedChainFor(docType: ChainDocType, projectId?: string | null) {
  const rows = await prisma.approvalChainConfig.findMany({
    where: { docType, isActive: true, OR: [{ projectId: projectId ?? undefined }, { projectId: null }] },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });
  if (!rows.length) return { rows: [], scope: 'none' as const };

  const projectRows = rows.filter((r) => projectId && r.projectId === projectId);
  const effective = projectRows.length ? projectRows : rows.filter((r) => r.projectId == null);
  const scope = projectRows.length ? ('project' as const) : ('global' as const);

  // One signature per person, at their earliest position.
  const seen = new Set<string>();
  const out = effective.filter((r) => (seen.has(r.approverId) ? false : (seen.add(r.approverId), true)));
  return { rows: out, scope };
}

/**
 * The chain a document should travel — resolved automatically, no user input.
 * Callers submit with no chain; this decides it.
 */
export async function resolveAutoChain(docType: ChainDocType, projectId: string, amount: number): Promise<ResolvedChain> {
  const [{ rows: fixed, scope }, matrix] = await Promise.all([
    fixedChainFor(docType, projectId),
    chainForAmount(docType, projectId, amount),
  ]);

  if (fixed.length) {
    const steps: ChainStep[] = fixed.map((r) => ({ approverId: r.approverId, approverName: r.approverName, approverRole: r.approverRole }));
    // Preserve the admin's step grouping (approvers sharing an `order` = one
    // any-one-approves step).
    const groups = groupByOrder(fixed.map((r) => ({ approverId: r.approverId, order: r.order })));
    // Never let the fixed chain bypass a value-mandated approver — append each
    // missing mandatory approver as its own trailing (single-person) step.
    const present = new Set(steps.map((s) => s.approverId));
    for (const m of matrix.steps) {
      if (!present.has(m.approverId)) {
        steps.push({ approverId: m.approverId, approverName: m.approverName, approverRole: m.approverRole });
        groups.push([m.approverId]);
        present.add(m.approverId);
      }
    }
    return { approverIds: steps.map((s) => s.approverId), steps, groups, source: 'fixed', scope };
  }

  if (matrix.configured && matrix.steps.length) {
    const steps = matrix.steps.map((s) => ({ approverId: s.approverId, approverName: s.approverName, approverRole: s.approverRole }));
    // The value matrix is one approver per band → one per step.
    return { approverIds: steps.map((s) => s.approverId), steps, groups: steps.map((s) => [s.approverId]), source: 'matrix', scope: matrix.scope === 'none' ? 'none' : matrix.scope };
  }

  return { approverIds: [], steps: [], groups: [], source: 'none', scope: 'none' };
}
