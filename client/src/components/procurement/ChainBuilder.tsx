// Decides the ordered approval chain when a PO/WO/GRN/payment is submitted.
//
// It asks the server what chain this document would travel (/approval-chains/
// resolve) and then behaves in one of three ways:
//
//   fixed  — an admin configured a chain for this doc type in Users → Approval
//            Chain. NO POPUP: the document is submitted straight through and the
//            server routes it through that chain. This is the normal path.
//   matrix — no fixed chain, but a value-threshold matrix applies. The mandatory
//            approvers are pre-filled, ordered and locked; the creator may add
//            extra reviewers but never drop a mandatory one. That is what stops
//            a ₹2,00,000 PO being routed around Finance.
//   none   — nothing configured. The original free-form picker, so projects that
//            have set neither up keep working exactly as before.

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Modal, Spinner } from '../ui';
import { inr } from '../../lib/format';

interface Approver { id: string; name: string; email: string; approvalRole?: string | null; level?: number; types: string[]; isAdmin?: boolean }

interface MatrixStep {
  approverId: string; approverName: string; approverRole: string | null; order: number;
  band: { minAmount: number; maxAmount: number | null };
}
interface MatrixPreview {
  steps: MatrixStep[];
  configured: boolean;
  scope: 'project' | 'global' | 'none';
  amount: number;
}

const bandLabel = (min: number, max: number | null) =>
  min <= 0 && max != null ? `up to ${inr(max)}` : max == null ? `${inr(min)} and above` : `${inr(min)} – ${inr(max)}`;

interface Resolved {
  steps: { approverId: string; approverName: string; approverRole: string | null }[];
  source: 'fixed' | 'matrix' | 'none';
  scope: 'project' | 'global' | 'none';
}

export default function ChainBuilder({ docType, projectId, amount, onConfirm, onClose, busy }: {
  docType: 'PO' | 'WO' | 'TO' | 'GRN' | 'PAYMENT' | 'TRAVEL' | 'TRAVEL_EXPENSE';
  projectId: string;
  /** The document's value — what the matrix bands are compared against. */
  amount: number;
  onConfirm: (chain: string[]) => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const [chain, setChain] = useState<string[]>([]);

  // Does an admin-configured chain exist for this doc type? If so we never ask.
  const { data: auto, isLoading: autoLoading } = useQuery({
    queryKey: ['approval-resolve', docType, projectId, amount],
    queryFn: async () =>
      (await api.get(`/approval-chains/resolve?docType=${docType}&projectId=${projectId}&amount=${amount}`)).data as Resolved,
  });
  const autoRouted = auto?.source === 'fixed';

  // Submit straight through. The server resolves the same chain server-side, so
  // an empty selection is correct here — it is not a "no approvers" submit.
  const fired = useRef(false);
  useEffect(() => {
    if (autoRouted && !fired.current) { fired.current = true; onConfirm([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRouted]);

  const { data, isLoading } = useQuery({
    queryKey: ['approvers'],
    queryFn: async () => (await api.get('/approvals/approvers')).data.approvers as Approver[],
    enabled: auto != null && !autoRouted,
  });

  const { data: matrix, isLoading: matrixLoading } = useQuery({
    queryKey: ['approval-preview', docType, projectId, amount],
    queryFn: async () =>
      (await api.get(`/approval-rules/preview?docType=${docType}&projectId=${projectId}&amount=${amount}`)).data as MatrixPreview,
    enabled: auto != null && !autoRouted,
  });

  const required = matrix?.configured ? matrix.steps : [];
  const requiredIds = new Set(required.map((s) => s.approverId));

  // Seed the chain with the mandatory approvers, in matrix order.
  useEffect(() => {
    if (!required.length) return;
    setChain((c) => {
      const extras = c.filter((id) => !requiredIds.has(id));
      return [...required.map((s) => s.approverId), ...extras];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrix]);

  // A vendor PAYMENT is approved by users whose approver type is VENDOR_PAYMENT.
  const approvalType = docType === 'PAYMENT' ? 'VENDOR_PAYMENT' : docType;
  const eligible = (data ?? []).filter((a) => a.types.includes('ALL') || a.types.includes(approvalType));
  const byId = new Map(eligible.map((a) => [a.id, a]));
  const bandOf = new Map(required.map((s) => [s.approverId, s.band]));
  const available = eligible.filter((a) => !chain.includes(a.id));

  const add = (id: string) => setChain((c) => [...c, id]);
  const remove = (id: string) => { if (!requiredIds.has(id)) setChain((c) => c.filter((x) => x !== id)); };
  const move = (i: number, dir: -1 | 1) => setChain((c) => {
    const j = i + dir; if (j < 0 || j >= c.length) return c;
    // A mandatory approver's position is set by the matrix, not by the creator.
    if (requiredIds.has(c[i]) || requiredIds.has(c[j])) return c;
    const next = [...c]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });

  // Auto-routed: no chain to choose. Show what it is routing through while the
  // submit request is in flight, rather than a picker the creator can't change.
  if (autoLoading || autoRouted) {
    return (
      <Modal title="Submitting for approval" onClose={onClose}>
        {autoLoading ? <Spinner label="Resolving approval chain…" /> : (
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              This {docType} routes through the {auto!.scope === 'project' ? 'project’s' : 'company'} approval chain,
              set by an administrator in <strong>Users → Approval Chain</strong>. Approvers are notified{' '}
              <strong>one at a time, in order</strong>.
            </p>
            <ol className="space-y-1">
              {auto!.steps.map((s, i) => (
                <li key={s.approverId} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700">
                  {i + 1}. {s.approverName}
                  {s.approverRole && <span className="text-xs text-slate-400"> · {s.approverRole}</span>}
                </li>
              ))}
            </ol>
            <Spinner label="Submitting…" />
          </div>
        )}
      </Modal>
    );
  }

  const loading = isLoading || matrixLoading;

  return (
    <Modal title="Choose approval chain" onClose={onClose} wide>
      {loading ? <Spinner label="Loading approvers…" /> : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Approvers are notified <strong>one at a time, in order</strong>. Only the first is notified now; each subsequent approver is notified once the previous approves.</p>

          {matrix?.configured ? (
            <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">
              This {docType} is worth <strong>{inr(amount)}</strong>. The{' '}
              {matrix.scope === 'project' ? 'project’s' : 'company'} approval matrix requires{' '}
              <strong>{required.length} approver{required.length === 1 ? '' : 's'}</strong> at this value. They are locked into the chain below.
            </div>
          ) : (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
              No approval matrix is configured for {docType}, so you may pick any chain. An admin can set value thresholds in{' '}
              <strong>Users → Approval Matrix</strong>.
            </div>
          )}

          {eligible.length === 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              No approvers are configured for {docType}. Set them up in Settings · Users → Approval Permissions.
            </div>
          )}

          {/* Ordered chain */}
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Chain ({chain.length})</div>
            {chain.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-sm text-slate-400">Add approvers below to build the chain.</div>
            ) : (
              <ol className="space-y-1">
                {chain.map((id, i) => {
                  const a = byId.get(id);
                  const mandatory = requiredIds.has(id);
                  const band = bandOf.get(id);
                  return (
                    <li key={id} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${mandatory ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200'}`}>
                      <span className="text-sm text-slate-700">
                        {i + 1}. {a?.name ?? required.find((s) => s.approverId === id)?.approverName}
                        {a?.approvalRole && <span className="text-xs text-slate-400"> · {a.approvalRole}</span>}
                        {mandatory && band && (
                          <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-700" title="Required by the approval matrix">
                            {bandLabel(band.minAmount, band.maxAmount)}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1">
                        <button className="px-1 text-slate-400 hover:text-navy disabled:opacity-30" disabled={i === 0 || mandatory} onClick={() => move(i, -1)}>↑</button>
                        <button className="px-1 text-slate-400 hover:text-navy disabled:opacity-30" disabled={i === chain.length - 1 || mandatory} onClick={() => move(i, 1)}>↓</button>
                        <button className="px-1 text-slate-300 hover:text-red-500 disabled:opacity-20" disabled={mandatory} title={mandatory ? 'Required by the approval matrix' : 'Remove'} onClick={() => remove(id)}>✕</button>
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {/* Available approvers */}
          {available.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Add another reviewer</div>
              <div className="flex flex-wrap gap-2">
                {available.map((a) => (
                  <button key={a.id} className="btn-outline text-xs" onClick={() => add(a.id)}>
                    + {a.name}{a.approvalRole ? ` (${a.approvalRole})` : ''}
                    {a.isAdmin && <span className="ml-1 rounded bg-purple-100 px-1 py-0.5 text-[10px] font-semibold text-purple-700">Admin</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button className="btn-outline" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={chain.length === 0 || busy} onClick={() => onConfirm(chain)}>{busy ? 'Submitting…' : 'Submit for Approval'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
