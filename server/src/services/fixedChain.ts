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
  /** 'fixed' = admin chain, 'matrix' = derived from value bands, 'none' = nothing configured. */
  source: 'fixed' | 'matrix' | 'none';
  scope: 'project' | 'global' | 'none';
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
    // Never let the fixed chain bypass a value-mandated approver.
    const present = new Set(steps.map((s) => s.approverId));
    for (const m of matrix.steps) {
      if (!present.has(m.approverId)) steps.push({ approverId: m.approverId, approverName: m.approverName, approverRole: m.approverRole });
    }
    return { approverIds: steps.map((s) => s.approverId), steps, source: 'fixed', scope };
  }

  if (matrix.configured && matrix.steps.length) {
    const steps = matrix.steps.map((s) => ({ approverId: s.approverId, approverName: s.approverName, approverRole: s.approverRole }));
    return { approverIds: steps.map((s) => s.approverId), steps, source: 'matrix', scope: matrix.scope === 'none' ? 'none' : matrix.scope };
  }

  return { approverIds: [], steps: [], source: 'none', scope: 'none' };
}
