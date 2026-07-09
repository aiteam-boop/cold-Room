// Settings · Users → Approval Matrix.
//
// AA sir (transcript P21/P22): "Kitne ka PO kaun approve karega? Abhi main bolun
//  Amit Shah 10,000 ka approve karegi. Manisha utna to karegi. Manish utna karega.
//  Phir finance involve hoyega… site mein bhi aadmi kharcha karega, usko kitna
//  power hai? ₹1000 chai paani labour."
//
// Each row is "this person signs documents of this value". Rows are additive:
// a ₹2,00,000 PO collects every rule whose band contains ₹2,00,000, in `order`.
// The row with no upper limit is the final signature — usually Finance.
//
// Approvers must first be marked as approvers of that document type on their user
// record (the panel above); this screen only decides at what value they sign.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { inr } from '../lib/format';
import { Spinner } from './ui';

type DocType = 'PO' | 'WO' | 'GRN';
const DOC_TYPES: DocType[] = ['PO', 'WO', 'GRN'];

interface Rule {
  id: string; projectId: string | null; docType: DocType;
  minAmount: number; maxAmount: number | null;
  approverId: string; approverName: string; approverRole: string | null;
  order: number; isActive: boolean; bandLabel: string;
}
interface Candidate { id: string; name: string; email: string; approvalRole: string | null; level: number }

const blank = (docType: DocType, order: number) => ({
  docType, minAmount: 0, maxAmount: null as number | null, approverId: '', order, isActive: true,
});

export default function ApprovalMatrix() {
  const qc = useQueryClient();
  const [docType, setDocType] = useState<DocType>('PO');
  const [draft, setDraft] = useState<ReturnType<typeof blank> | null>(null);
  const [err, setErr] = useState('');
  const [probe, setProbe] = useState('200000');

  const rulesQ = useQuery({
    queryKey: ['approval-rules', docType],
    queryFn: async () => (await api.get(`/approval-rules?docType=${docType}`)).data.rules as Rule[],
  });
  const candQ = useQuery({
    queryKey: ['approval-candidates', docType],
    queryFn: async () => (await api.get(`/approval-rules/candidates?docType=${docType}`)).data.candidates as Candidate[],
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['approval-rules'] });
  const fail = (e: unknown) => setErr(errMsg(e));

  const create = useMutation({ mutationFn: (b: any) => api.post('/approval-rules', b), onSuccess: () => { setDraft(null); setErr(''); invalidate(); }, onError: fail });
  const patch = useMutation({ mutationFn: ({ id, b }: { id: string; b: any }) => api.patch(`/approval-rules/${id}`, b), onSuccess: () => { setErr(''); invalidate(); }, onError: fail });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/approval-rules/${id}`), onSuccess: invalidate, onError: fail });

  const rules = rulesQ.data ?? [];
  const candidates = candQ.data ?? [];

  // Live "who signs a document of this value?" — the same computation the server
  // runs on submit, done client-side against the rules on screen.
  const amount = Number(probe) || 0;
  const wouldSign = useMemo(
    () => rules
      .filter((r) => r.isActive && amount >= r.minAmount && (r.maxAmount == null || amount <= r.maxAmount))
      .sort((a, b) => a.order - b.order),
    [rules, amount],
  );

  // A value above every band's ceiling has no final approver — the chain would be
  // empty and the document would sail through. Worth saying out loud.
  const hasUnbounded = rules.some((r) => r.isActive && r.maxAmount == null);

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Approval Matrix — who signs at what value</h2>
          <p className="text-xs text-slate-500">
            Rules are additive: a document collects every approver whose band contains its value, in order.
            The rule with <strong>no upper limit</strong> is the final signature.
          </p>
        </div>
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {DOC_TYPES.map((t) => (
            <button key={t} onClick={() => { setDocType(t); setDraft(null); setErr(''); }}
              className={`px-3 py-1.5 text-xs font-semibold ${docType === t ? 'bg-navy text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}

      {!hasUnbounded && rules.length > 0 && (
        <div className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
          No rule has an open upper limit. A {docType} worth more than the highest band would need <strong>no approval at all</strong>.
          Add a final approver with the upper limit left blank.
        </div>
      )}

      {rulesQ.isLoading || candQ.isLoading ? <Spinner /> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-2 py-2 w-16">Order</th>
                  <th className="px-2">Approver</th>
                  <th className="px-2 text-right">From (₹)</th>
                  <th className="px-2 text-right">Up to (₹)</th>
                  <th className="px-2">Band</th>
                  <th className="px-2">Active</th>
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 && !draft && (
                  <tr><td colSpan={7} className="px-2 py-6 text-center text-sm text-slate-400">
                    No matrix for {docType}. Until one exists, whoever raises a {docType} picks its approvers freely.
                  </td></tr>
                )}

                {rules.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="px-2 py-1.5">
                      <input type="number" min={1} className="input w-16 py-1 text-sm" defaultValue={r.order}
                        onBlur={(e) => Number(e.target.value) !== r.order && patch.mutate({ id: r.id, b: { order: Number(e.target.value) } })} />
                    </td>
                    <td className="px-2 text-slate-700">
                      {r.approverName}
                      {r.approverRole && <span className="ml-1 text-xs text-slate-400">· {r.approverRole}</span>}
                    </td>
                    <td className="px-2 text-right">
                      <input type="number" min={0} className="input w-28 py-1 text-right text-sm" defaultValue={r.minAmount}
                        onBlur={(e) => Number(e.target.value) !== r.minAmount && patch.mutate({ id: r.id, b: { minAmount: Number(e.target.value) } })} />
                    </td>
                    <td className="px-2 text-right">
                      <input type="number" min={1} className="input w-28 py-1 text-right text-sm" placeholder="no limit"
                        defaultValue={r.maxAmount ?? ''}
                        onBlur={(e) => {
                          const v = e.target.value.trim() === '' ? null : Number(e.target.value);
                          if (v !== r.maxAmount) patch.mutate({ id: r.id, b: { maxAmount: v } });
                        }} />
                    </td>
                    <td className="px-2 text-xs text-slate-500">{r.bandLabel}</td>
                    <td className="px-2">
                      <input type="checkbox" checked={r.isActive} onChange={(e) => patch.mutate({ id: r.id, b: { isActive: e.target.checked } })} />
                    </td>
                    <td className="px-2 text-right">
                      <button className="text-xs text-red-500 hover:underline"
                        onClick={() => confirm(`Remove ${r.approverName} from the ${docType} matrix?`) && del.mutate(r.id)}>Remove</button>
                    </td>
                  </tr>
                ))}

                {draft && (
                  <tr className="border-b border-slate-100 bg-blue-50/40">
                    <td className="px-2 py-1.5">
                      <input type="number" min={1} className="input w-16 py-1 text-sm" value={draft.order}
                        onChange={(e) => setDraft({ ...draft, order: Number(e.target.value) })} />
                    </td>
                    <td className="px-2">
                      <select className="input py-1 text-sm" value={draft.approverId} onChange={(e) => setDraft({ ...draft, approverId: e.target.value })}>
                        <option value="">Select approver…</option>
                        {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.approvalRole ? ` (${c.approvalRole})` : ''}</option>)}
                      </select>
                      {candidates.length === 0 && (
                        <div className="mt-1 text-[11px] text-amber-700">Nobody is registered as a {docType} approver yet — set that on their user record above.</div>
                      )}
                    </td>
                    <td className="px-2 text-right">
                      <input type="number" min={0} className="input w-28 py-1 text-right text-sm" value={draft.minAmount}
                        onChange={(e) => setDraft({ ...draft, minAmount: Number(e.target.value) })} />
                    </td>
                    <td className="px-2 text-right">
                      <input type="number" min={1} className="input w-28 py-1 text-right text-sm" placeholder="no limit"
                        value={draft.maxAmount ?? ''}
                        onChange={(e) => setDraft({ ...draft, maxAmount: e.target.value.trim() === '' ? null : Number(e.target.value) })} />
                    </td>
                    <td className="px-2 text-xs text-slate-400">
                      {draft.maxAmount == null ? 'final approver' : `${inr(draft.minAmount)} – ${inr(draft.maxAmount)}`}
                    </td>
                    <td colSpan={2} className="px-2 text-right">
                      <button className="btn-primary mr-2 px-2 py-1 text-xs" disabled={!draft.approverId || create.isPending}
                        onClick={() => create.mutate(draft)}>Save</button>
                      <button className="text-xs text-slate-500 hover:underline" onClick={() => { setDraft(null); setErr(''); }}>Cancel</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!draft && (
            <button className="btn-outline mt-3 text-sm" onClick={() => setDraft(blank(docType, rules.length + 1))}>
              + Add rule
            </button>
          )}

          {/* Live check — the same rule the server applies on submit. */}
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-500">A {docType} worth</span>
              <input type="number" className="input w-36 py-1 text-sm" value={probe} onChange={(e) => setProbe(e.target.value)} />
              <span className="text-slate-500">would need:</span>
            </div>
            <div className="mt-2">
              {wouldSign.length === 0 ? (
                <span className="text-sm text-red-600">
                  {rules.length === 0 ? 'no matrix — the creator picks the chain.' : `no approval at all. ${inr(amount)} falls outside every band.`}
                </span>
              ) : (
                <ol className="flex flex-wrap items-center gap-1.5 text-sm">
                  {wouldSign.map((r, i) => (
                    <li key={r.id} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-slate-300">→</span>}
                      <span className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-navy">
                        {r.approverName}
                        <span className="ml-1 font-normal text-slate-400">{r.bandLabel}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
