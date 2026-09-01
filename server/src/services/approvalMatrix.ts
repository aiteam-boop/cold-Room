// Value-threshold approval matrix. (DPR PRD §3.2 G6 / transcript R13.)
//
// AA sir: "Kitne ka PO kaun approve karega? Abhi main bolun Amit Shah 10,000 ka
//  approve karegi. Manisha utna to karegi. Manish utna karega. Phir finance
//  involve hoyega."
//
// Before this, ApproverProfile carried only { canApprove, approvalRole, level,
// types[] } — there was no way to say "Gitanjali up to ₹50,000". Whoever raised
// the PO hand-picked its approvers, so a ₹2,00,000 PO could legally be approved
// by one site engineer.
//
// Now the chain is DERIVED from the document's value:
//
//   chain(V) = every ACTIVE rule of this docType whose band contains V,
//              ordered by `order`, de-duplicated by approver.
//
// A band is [minAmount, maxAmount]; `maxAmount = null` means unbounded — the
// final approver, the one who must always sign. The rules are additive on
// purpose: a ₹2,00,000 PO collects the site rule AND the department rule AND the
// finance rule, so seniority accumulates with value.
//
// Project-specific rules, when any exist for a docType, REPLACE the org-wide
// defaults for that project rather than merging with them — a project either
// follows the company matrix or defines its own, never a confusing blend.

import { prisma } from '../lib/prisma';

export type MatrixDocType = 'PO' | 'WO' | 'TO' | 'GRN' | 'PAYMENT';

export interface MatrixStep {
  approverId: string;
  approverName: string;
  approverRole: string | null;
  order: number;
  /** The band that pulled this approver in — shown in the UI so the chain explains itself. */
  band: { minAmount: number; maxAmount: number | null };
}

export interface MatrixResult {
  /** Empty when no matrix is configured for this docType. */
  steps: MatrixStep[];
  /** True when at least one rule exists — i.e. the matrix governs this docType. */
  configured: boolean;
  /** Where the rules came from. */
  scope: 'project' | 'global' | 'none';
  amount: number;
}

export const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

/** Human label for a band: "up to ₹10,000", "₹10,001 – ₹50,000", "above ₹2,00,000". */
export function bandLabel(min: number, max: number | null): string {
  if (min <= 0 && max != null) return `up to ${inr(max)}`;
  if (max == null) return `${inr(min)} and above`;
  return `${inr(min)} – ${inr(max)}`;
}

const bandContains = (r: { minAmount: number; maxAmount: number | null }, v: number) =>
  v >= r.minAmount && (r.maxAmount == null || v <= r.maxAmount);

/**
 * The approval chain a document of `amount` must travel, per the matrix.
 * Returns `configured: false` when nobody has set the matrix up — callers then
 * fall back to the legacy hand-picked chain rather than blocking the submit.
 */
export async function chainForAmount(docType: MatrixDocType, projectId: string, amount: number): Promise<MatrixResult> {
  const rules = await prisma.approvalRule.findMany({
    where: { docType, isActive: true, OR: [{ projectId }, { projectId: null }] },
    orderBy: [{ order: 'asc' }, { minAmount: 'asc' }],
  });
  if (rules.length === 0) return { steps: [], configured: false, scope: 'none', amount };

  // A project that defines its own rules opts out of the org defaults entirely.
  const projectRules = rules.filter((r) => r.projectId === projectId);
  const effective = projectRules.length > 0 ? projectRules : rules.filter((r) => r.projectId == null);
  const scope: MatrixResult['scope'] = projectRules.length > 0 ? 'project' : 'global';

  const seen = new Set<string>();
  const steps: MatrixStep[] = [];
  for (const r of effective) {
    if (!bandContains(r, amount)) continue;
    if (seen.has(r.approverId)) continue; // one signature per person, at their earliest order
    seen.add(r.approverId);
    steps.push({
      approverId: r.approverId,
      approverName: r.approverName,
      approverRole: r.approverRole,
      order: r.order,
      band: { minAmount: r.minAmount, maxAmount: r.maxAmount },
    });
  }
  steps.sort((a, b) => a.order - b.order);
  return { steps, configured: true, scope, amount };
}

/**
 * Does a hand-picked chain satisfy the matrix for this amount?
 *
 * We do not demand an exact match — a creator may add extra reviewers — but every
 * approver the matrix requires must be present. This is what stops a ₹2 lakh PO
 * from being routed around Finance.
 */
export async function validateChain(
  docType: MatrixDocType,
  projectId: string,
  amount: number,
  chosenApproverIds: string[],
): Promise<{ ok: true } | { ok: false; missing: MatrixStep[]; message: string }> {
  const { steps, configured } = await chainForAmount(docType, projectId, amount);
  if (!configured || steps.length === 0) return { ok: true };

  const chosen = new Set(chosenApproverIds);
  const missing = steps.filter((s) => !chosen.has(s.approverId));
  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    missing,
    message:
      `A ${docType} of ${inr(amount)} requires ${missing.map((m) => `${m.approverName} (${bandLabel(m.band.minAmount, m.band.maxAmount)})`).join(', ')} ` +
      `in the approval chain.`,
  };
}
