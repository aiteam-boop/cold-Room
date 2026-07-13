import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';

// Fixed approval chain per document type — configure once, applies to every
// future document automatically (no per-submit approver picking).
//
// The approver dropdown is the SAME candidate list the value matrix uses
// (/approval-rules/candidates): only users who are registered approvers for
// that document type appear. Give someone approval rights on their user record
// above and they show up here.
const DOC_TYPES = [
  { key: 'PO', label: 'PO' },
  { key: 'WO', label: 'WO' },
  { key: 'GRN', label: 'GRN' },
  { key: 'PAYMENT', label: 'Vendor Payments' },
] as const;

interface Candidate { id: string; name: string; email: string; approvalRole: string | null; level: number }
type Row = { approverId: string; approverName: string; approverRole?: string | null; isActive: boolean };

export default function ApprovalChainConfig() {
  const qc = useQueryClient();
  const [docType, setDocType] = useState<string>('PO');
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<string | null>(null); // approverId being added
  const [msg, setMsg] = useState('');

  const candQ = useQuery({
    queryKey: ['approval-candidates', docType],
    queryFn: async () => (await api.get(`/approval-rules/candidates?docType=${docType}`)).data.candidates as Candidate[],
  });
  const chainQ = useQuery({
    queryKey: ['approval-chain', docType],
    queryFn: async () => (await api.get(`/approval-chains?docType=${docType}`)).data as { chain: Row[] },
  });

  useEffect(() => { if (chainQ.data) setRows(chainQ.data.chain.map((c) => ({ approverId: c.approverId, approverName: c.approverName, approverRole: c.approverRole, isActive: c.isActive }))); }, [chainQ.data]);

  const save = useMutation({
    mutationFn: (next: Row[]) => api.put('/approval-chains', { docType, approvers: next.map((r, i) => ({ approverId: r.approverId, order: i + 1, isActive: r.isActive })) }),
    onSuccess: () => { setMsg(`Saved — every future ${docType} routes through this chain automatically.`); qc.invalidateQueries({ queryKey: ['approval-chain', docType] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  const candidates = candQ.data ?? [];
  const available = candidates.filter((c) => !rows.some((r) => r.approverId === c.id));
  const commit = (next: Row[]) => { setRows(next); save.mutate(next); };
  const move = (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= rows.length) return;
    const next = [...rows]; [next[i], next[j]] = [next[j], next[i]]; commit(next);
  };
  const addDraft = () => {
    const c = candidates.find((x) => x.id === draft);
    if (!c) return;
    commit([...rows, { approverId: c.id, approverName: c.name, approverRole: c.approvalRole, isActive: true }]);
    setDraft(null);
  };

  const active = rows.filter((r) => r.isActive);

  return (
    <div className="card mt-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-navy">Approval Chain — who signs, in order</h2>
          <p className="text-sm text-slate-500">
            Set the chain <strong>once</strong>. Every future document of this type routes through it automatically —
            approvers are notified <strong>one at a time, in order</strong>, and the creator is never asked to pick anyone.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {DOC_TYPES.map((t) => (
            <button key={t.key} onClick={() => { setDocType(t.key); setDraft(null); setMsg(''); }}
              className={`rounded-md px-3 py-1 font-medium ${docType === t.key ? 'bg-navy text-white' : 'text-slate-500 hover:text-slate-700'}`}>{t.label}</button>
          ))}
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr><th className="w-16 px-3 py-2">Order</th><th>Approver</th><th className="w-20">Active</th><th className="w-24">Reorder</th><th className="w-20"></th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && !draft && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-400">
                No chain for {docType}. Until one exists, the value matrix above decides the approvers.
              </td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.approverId} className={`border-t border-slate-100 ${r.isActive ? '' : 'opacity-50'}`}>
                <td className="px-3 py-2 font-semibold text-navy">{i + 1}</td>
                <td>
                  {r.approverName}
                  {r.approverRole && <span className="ml-1 text-xs text-slate-400">· {r.approverRole}</span>}
                </td>
                <td><input type="checkbox" checked={r.isActive} onChange={(e) => commit(rows.map((x, idx) => idx === i ? { ...x, isActive: e.target.checked } : x))} /></td>
                <td>
                  <button className="px-1 text-slate-400 hover:text-navy disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button className="px-1 text-slate-400 hover:text-navy disabled:opacity-30" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                </td>
                <td className="text-right">
                  <button className="pr-3 text-xs text-red-500 hover:underline"
                    onClick={() => confirm(`Remove ${r.approverName} from the ${docType} chain?`) && commit(rows.filter((_, idx) => idx !== i))}>Remove</button>
                </td>
              </tr>
            ))}

            {/* Draft row — same pattern as the value matrix */}
            {draft !== null && (
              <tr className="border-t border-slate-100 bg-slate-50/60">
                <td className="px-3 py-2 font-semibold text-navy">{rows.length + 1}</td>
                <td className="py-2">
                  <select className="input py-1 text-sm" value={draft} onChange={(e) => setDraft(e.target.value)}>
                    <option value="">Select approver…</option>
                    {available.map((c) => <option key={c.id} value={c.id}>{c.name}{c.approvalRole ? ` (${c.approvalRole})` : ''}</option>)}
                  </select>
                  {available.length === 0 && (
                    <div className="mt-1 text-[11px] text-amber-700">Nobody is registered as a {docType} approver yet — set that on their user record above.</div>
                  )}
                </td>
                <td colSpan={2}></td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn-primary mr-2 px-2 py-1 text-xs" disabled={!draft || save.isPending} onClick={addDraft}>Save</button>
                  <button className="pr-3 text-xs text-slate-500 hover:underline" onClick={() => setDraft(null)}>Cancel</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {draft === null && (
        <button className="btn-outline mt-3 text-sm" onClick={() => setDraft('')}>+ Add rule</button>
      )}

      <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
        {active.length > 0 ? (
          <>A {docType} would be approved by: <span className="font-medium text-navy">{active.map((r) => r.approverName).join(' → ')}</span></>
        ) : (
          <span className="text-slate-500">No active approvers — the value matrix above will be used instead.</span>
        )}
      </div>
      {msg && <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}
    </div>
  );
}
