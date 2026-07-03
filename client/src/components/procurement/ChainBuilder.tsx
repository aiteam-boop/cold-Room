// Modal to pick the ordered approval chain before submitting a PO/WO/GRN.
// Approvers come from the registry (GET /api/approvals/approvers); only those
// whose allowed types include this document type (or 'ALL') are selectable.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Modal, Spinner } from '../ui';

interface Approver { id: string; name: string; email: string; approvalRole?: string | null; level?: number; types: string[] }

export default function ChainBuilder({ docType, onConfirm, onClose, busy }: {
  docType: 'PO' | 'WO' | 'GRN'; onConfirm: (chain: string[]) => void; onClose: () => void; busy?: boolean;
}) {
  const [chain, setChain] = useState<string[]>([]);
  const { data, isLoading } = useQuery({
    queryKey: ['approvers'],
    queryFn: async () => (await api.get('/approvals/approvers')).data.approvers as Approver[],
  });

  const eligible = (data ?? []).filter((a) => a.types.includes('ALL') || a.types.includes(docType));
  const byId = new Map(eligible.map((a) => [a.id, a]));
  const available = eligible.filter((a) => !chain.includes(a.id));

  const add = (id: string) => setChain((c) => [...c, id]);
  const remove = (id: string) => setChain((c) => c.filter((x) => x !== id));
  const move = (i: number, dir: -1 | 1) => setChain((c) => {
    const j = i + dir; if (j < 0 || j >= c.length) return c;
    const next = [...c]; [next[i], next[j]] = [next[j], next[i]]; return next;
  });

  return (
    <Modal title="Choose approval chain" onClose={onClose} wide>
      {isLoading ? <Spinner label="Loading approvers…" /> : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">Approvers are notified <strong>one at a time, in order</strong>. Only the first is notified now; each subsequent approver is notified once the previous approves.</p>

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
                  return (
                    <li key={id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                      <span className="text-sm text-slate-700">{i + 1}. {a?.name} {a?.approvalRole && <span className="text-xs text-slate-400">· {a.approvalRole}</span>}</span>
                      <span className="flex items-center gap-1">
                        <button className="px-1 text-slate-400 hover:text-navy disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                        <button className="px-1 text-slate-400 hover:text-navy disabled:opacity-30" disabled={i === chain.length - 1} onClick={() => move(i, 1)}>↓</button>
                        <button className="px-1 text-slate-300 hover:text-red-500" onClick={() => remove(id)}>✕</button>
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
              <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Add approver</div>
              <div className="flex flex-wrap gap-2">
                {available.map((a) => (
                  <button key={a.id} className="btn-outline text-xs" onClick={() => add(a.id)}>+ {a.name}{a.approvalRole ? ` (${a.approvalRole})` : ''}</button>
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
