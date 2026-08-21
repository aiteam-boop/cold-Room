import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';

// Fixed approval chain per document type — configure once, applies to every
// future document automatically (no per-submit approver picking).
//
// A chain is a list of STEPS, in order. A step usually has ONE approver, but it
// can hold several — then everyone on that step is notified at once and ANY ONE
// approving passes it to the next step ("either can approve"). The approver
// dropdown is the same candidate list the value matrix uses
// (/approval-rules/candidates): only registered approvers for that doc type.
const DOC_TYPES = [
  { key: 'PO', label: 'PO' },
  { key: 'WO', label: 'WO' },
  { key: 'GRN', label: 'GRN' },
  { key: 'PAYMENT', label: 'Vendor Payments' },
] as const;

interface Candidate { id: string; name: string; email: string; approvalRole: string | null; level: number }
type Row = { approverId: string; approverName: string; approverRole?: string | null; isActive: boolean; order: number };

export default function ApprovalChainConfig() {
  const qc = useQueryClient();
  const [docType, setDocType] = useState<string>('PO');
  const [rows, setRows] = useState<Row[]>([]);
  // Adding an approver: to an existing step (its order) or as a brand-new step.
  const [adding, setAdding] = useState<{ order: number | 'new'; approverId: string } | null>(null);
  const [msg, setMsg] = useState('');

  const candQ = useQuery({
    queryKey: ['approval-candidates', docType],
    queryFn: async () => (await api.get(`/approval-rules/candidates?docType=${docType}`)).data.candidates as Candidate[],
  });
  const chainQ = useQuery({
    queryKey: ['approval-chain', docType],
    queryFn: async () => (await api.get(`/approval-chains?docType=${docType}`)).data as { chain: Row[] },
  });

  useEffect(() => {
    if (chainQ.data) setRows(chainQ.data.chain.map((c) => ({ approverId: c.approverId, approverName: c.approverName, approverRole: c.approverRole, isActive: c.isActive, order: c.order })));
  }, [chainQ.data]);

  const save = useMutation({
    mutationFn: (next: Row[]) => api.put('/approval-chains', { docType, approvers: next.map((r) => ({ approverId: r.approverId, order: r.order, isActive: r.isActive })) }),
    onSuccess: () => { setMsg(`Saved — every future ${docType} routes through this chain automatically.`); qc.invalidateQueries({ queryKey: ['approval-chain', docType] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  const candidates = candQ.data ?? [];
  const available = candidates.filter((c) => !rows.some((r) => r.approverId === c.id));
  const commit = (next: Row[]) => { setRows(next); save.mutate(next); };

  // Steps = rows grouped by order (renumbered contiguous 1..n for display).
  const steps = useMemo(() => {
    const orders = [...new Set(rows.map((r) => r.order))].sort((a, b) => a - b);
    return orders.map((o, i) => ({ order: o, index: i + 1, items: rows.filter((r) => r.order === o) }));
  }, [rows]);
  const maxOrder = steps.length ? Math.max(...steps.map((s) => s.order)) : 0;

  const addApprover = () => {
    const c = candidates.find((x) => x.id === adding?.approverId);
    if (!c || !adding) return;
    const order = adding.order === 'new' ? maxOrder + 1 : adding.order;
    commit([...rows, { approverId: c.id, approverName: c.name, approverRole: c.approvalRole, isActive: true, order }]);
    setAdding(null);
  };
  const removeApprover = (approverId: string) => commit(rows.filter((r) => r.approverId !== approverId));
  const toggleActive = (approverId: string, on: boolean) => commit(rows.map((r) => (r.approverId === approverId ? { ...r, isActive: on } : r)));
  const moveStep = (order: number, dir: -1 | 1) => {
    const ords = steps.map((s) => s.order);
    const pos = ords.indexOf(order);
    const swap = pos + dir;
    if (swap < 0 || swap >= ords.length) return;
    const a = ords[pos], b = ords[swap];
    commit(rows.map((r) => (r.order === a ? { ...r, order: b } : r.order === b ? { ...r, order: a } : r)));
  };

  const activeSummary = steps
    .map((s) => s.items.filter((r) => r.isActive))
    .filter((g) => g.length)
    .map((g) => (g.length > 1 ? `(${g.map((r) => r.approverName).join(' or ')})` : g[0].approverName))
    .join(' → ');

  return (
    <div className="card mt-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-navy">Approval Chain — who signs, in order</h2>
          <p className="text-sm text-slate-500">
            Set the chain <strong>once</strong>. Every future document routes through it automatically. A step can hold
            more than one approver — then <strong>either can approve</strong> and it moves to the next step.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {DOC_TYPES.map((t) => (
            <button key={t.key} onClick={() => { setDocType(t.key); setAdding(null); setMsg(''); }}
              className={`rounded-md px-3 py-1 font-medium ${docType === t.key ? 'bg-navy text-white' : 'text-slate-500 hover:text-slate-700'}`}>{t.label}</button>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {steps.length === 0 && adding?.order !== 'new' && (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-400">
            No chain for {docType}. Until one exists, the value matrix above decides the approvers.
          </div>
        )}

        {steps.map((s) => (
          <div key={s.order} className="rounded-lg border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-3 py-1.5">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Step {s.index}
                {s.items.length > 1 && <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold normal-case text-blue-700">any one approves</span>}
              </div>
              <div className="flex items-center gap-1 text-slate-400">
                <button className="px-1 hover:text-navy disabled:opacity-30" disabled={s.index === 1} onClick={() => moveStep(s.order, -1)}>↑</button>
                <button className="px-1 hover:text-navy disabled:opacity-30" disabled={s.index === steps.length} onClick={() => moveStep(s.order, 1)}>↓</button>
              </div>
            </div>
            <ul>
              {s.items.map((r) => (
                <li key={r.approverId} className={`flex items-center justify-between px-3 py-2 text-sm ${r.isActive ? '' : 'opacity-50'}`}>
                  <span>{r.approverName}{r.approverRole && <span className="ml-1 text-xs text-slate-400">· {r.approverRole}</span>}</span>
                  <span className="flex items-center gap-3">
                    <label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={r.isActive} onChange={(e) => toggleActive(r.approverId, e.target.checked)} /> Active</label>
                    <button className="text-xs text-red-500 hover:underline" onClick={() => confirm(`Remove ${r.approverName} from the ${docType} chain?`) && removeApprover(r.approverId)}>Remove</button>
                  </span>
                </li>
              ))}
            </ul>
            {/* Add another approver to THIS step (either can approve). */}
            {adding?.order === s.order ? (
              <AddRow available={available} value={adding.approverId} docType={docType}
                onChange={(id) => setAdding({ order: s.order, approverId: id })}
                onSave={addApprover} onCancel={() => setAdding(null)} busy={save.isPending} />
            ) : (
              <div className="px-3 py-2">
                <button className="text-xs font-medium text-navy hover:underline" onClick={() => setAdding({ order: s.order, approverId: '' })}>+ Add approver (either can approve)</button>
              </div>
            )}
          </div>
        ))}

        {/* New step */}
        {adding?.order === 'new' ? (
          <div className="rounded-lg border border-slate-200">
            <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Step {steps.length + 1}</div>
            <AddRow available={available} value={adding.approverId} docType={docType}
              onChange={(id) => setAdding({ order: 'new', approverId: id })}
              onSave={addApprover} onCancel={() => setAdding(null)} busy={save.isPending} />
          </div>
        ) : (
          <button className="btn-outline text-sm" onClick={() => setAdding({ order: 'new', approverId: '' })}>+ Add step</button>
        )}
      </div>

      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
        {activeSummary ? (
          <>A {docType} would be approved by: <span className="font-medium text-navy">{activeSummary}</span></>
        ) : (
          <span className="text-slate-500">No active approvers — the value matrix above will be used instead.</span>
        )}
      </div>
      {msg && <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}
    </div>
  );
}

function AddRow({ available, value, docType, onChange, onSave, onCancel, busy }: {
  available: Candidate[]; value: string; docType: string;
  onChange: (id: string) => void; onSave: () => void; onCancel: () => void; busy: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <select className="input py-1 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select approver…</option>
        {available.map((c) => <option key={c.id} value={c.id}>{c.name}{c.approvalRole ? ` (${c.approvalRole})` : ''}</option>)}
      </select>
      <button className="btn-primary px-2 py-1 text-xs" disabled={!value || busy} onClick={onSave}>Save</button>
      <button className="text-xs text-slate-500 hover:underline" onClick={onCancel}>Cancel</button>
      {available.length === 0 && <span className="text-[11px] text-amber-700">Nobody else is registered as a {docType} approver — set that on their user record above.</span>}
    </div>
  );
}
