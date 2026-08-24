import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { EmptyState, Spinner } from '../ui';
import { fmtNum } from '../../lib/format';

// Procurement PRD §8 (G1/G2) — BOQ vs Received reconciliation with a running remark
// log. Per BOQ item: ordered (BOQ qty) vs received (goods actually accepted) →
// remaining (shortfall + / over-receipt −). Filter the short items; each row keeps
// an APPEND-ONLY remark history so an issue is tracked over time, never overwritten.
interface Remark { text: string; by: string | null; at: string }
interface Row {
  id: string; srNo?: string | null; description: string; category: string;
  roomZone?: string | null; unit?: string | null;
  ordered: number; received: number; remaining: number; remarks: Remark[];
}

export default function BOQReconcileView({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'short' | 'over' | 'done'>('all');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState('');

  const recQ = useQuery({ queryKey: ['boq-recon', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq/reconciliation`)).data.rows as Row[] });

  const addRemark = useMutation({
    mutationFn: async ({ id, text }: { id: string; text: string }) => (await api.post(`/projects/${projectId}/boq/reconciliation/${id}/remark`, { text })).data.remark as Remark,
    onSuccess: () => { setDraft(''); setMsg(''); qc.invalidateQueries({ queryKey: ['boq-recon', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  const rows = recQ.data ?? [];
  const shortCount = rows.filter((r) => r.remaining > 0.01).length;
  const overCount = rows.filter((r) => r.remaining < -0.01).length;
  const doneCount = rows.filter((r) => Math.abs(r.remaining) <= 0.01 && r.received > 0).length;
  const totOrdered = rows.reduce((s, r) => s + r.ordered, 0);
  const totReceived = rows.reduce((s, r) => s + r.received, 0);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'short' && !(r.remaining > 0.01)) return false;
      if (filter === 'over' && !(r.remaining < -0.01)) return false;
      if (filter === 'done' && !(Math.abs(r.remaining) <= 0.01 && r.received > 0)) return false;
      if (needle && ![r.srNo, r.description, r.roomZone, r.category].some((v) => v?.toLowerCase?.().includes(needle))) return false;
      return true;
    });
  }, [rows, q, filter]);

  // Group the shown rows by category (header rows), preserving order.
  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const r of shown) { const a = map.get(r.category) ?? []; a.push(r); map.set(r.category, a); }
    return [...map.entries()];
  }, [shown]);

  if (recQ.isLoading) return <Spinner label="Loading reconciliation…" />;
  if (rows.length === 0) return <EmptyState title="No BOQ imported yet" hint="Import the BOQ first — then reconcile it against what was received." />;

  const remCell = (r: Row) => {
    if (r.remaining > 0.01) return <span className="font-medium text-rose-600">− {fmtNum(r.remaining)} short</span>;
    if (r.remaining < -0.01) return <span className="font-medium text-sky-600">+ {fmtNum(-r.remaining)} over</span>;
    if (r.received > 0) return <span className="font-medium text-emerald-600">✓ complete</span>;
    return <span className="text-slate-400">—</span>;
  };
  const Chip = ({ v, on, children }: { v: string; on: boolean; children: any }) => (
    <button onClick={() => setFilter(v as any)} className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${on ? 'bg-navy text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{children}</button>
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold text-navy">{fmtNum(totOrdered)}</div><div className="text-[11px] text-slate-400">Total ordered (BOQ)</div></div>
        <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold text-emerald-600">{fmtNum(totReceived)}</div><div className="text-[11px] text-slate-400">Total received</div></div>
        <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold text-rose-600">{shortCount}</div><div className="text-[11px] text-slate-400">Items short</div></div>
        <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold text-sky-600">{overCount}</div><div className="text-[11px] text-slate-400">Items over-received</div></div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">Filter:</span>
        <Chip v="all" on={filter === 'all'}>All ({rows.length})</Chip>
        <Chip v="short" on={filter === 'short'}>Short ({shortCount})</Chip>
        <Chip v="over" on={filter === 'over'}>Over ({overCount})</Chip>
        <Chip v="done" on={filter === 'done'}>Complete ({doneCount})</Chip>
        <input className="input ml-auto h-8 w-56 text-xs" placeholder="Search item / room…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {msg && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{msg}</div>}

      {shown.length === 0 ? (
        <EmptyState title="Nothing here" hint={filter === 'short' ? 'No shortfall items 🎉' : 'No items match.'} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 w-16">Sr</th><th className="px-3 py-2">Item / Heading</th><th className="px-3 py-2 w-28">Room/Zone</th>
                <th className="px-3 py-2 w-16">Unit</th><th className="px-3 py-2 w-24 text-right">Ordered</th><th className="px-3 py-2 w-24 text-right">Received</th>
                <th className="px-3 py-2 w-36 text-right">Remaining</th><th className="px-3 py-2 w-28 text-center">Remarks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {groups.map(([cat, list]) => (
                <Fragment key={cat}>
                  <tr className="bg-slate-50/70"><td colSpan={8} className="px-3 py-1.5 text-xs font-semibold text-slate-600">{cat} <span className="font-normal text-slate-400">· {list.length}</span></td></tr>
                  {list.map((r) => {
                    const isOpen = openRow === r.id;
                    return (
                      <Fragment key={r.id}>
                        <tr className={`align-top ${r.remaining > 0.01 ? 'bg-rose-50/30' : ''}`}>
                          <td className="px-3 py-2 text-xs text-slate-400">{r.srNo || '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-700">{(r.description || '').split('\n')[0]}</td>
                          <td className="px-3 py-2 text-xs text-slate-400">{r.roomZone || '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-400">{r.unit || '—'}</td>
                          <td className="px-3 py-2 text-right">{fmtNum(r.ordered)}</td>
                          <td className="px-3 py-2 text-right text-slate-600">{fmtNum(r.received)}</td>
                          <td className="px-3 py-2 text-right">{remCell(r)}</td>
                          <td className="px-3 py-2 text-center">
                            <button onClick={() => { setOpenRow(isOpen ? null : r.id); setDraft(''); setMsg(''); }} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${r.remarks.length ? 'bg-amber-50 text-amber-700' : 'text-navy hover:underline'}`}>
                              💬 {r.remarks.length || 'add'}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-slate-50/60">
                            <td colSpan={8} className="px-4 py-3">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Remark history (newest first)</div>
                              {r.remarks.length === 0 ? <div className="mt-1 text-xs text-slate-400">No remarks yet.</div> : (
                                <ul className="mt-1 space-y-1">
                                  {r.remarks.map((rm, i) => (
                                    <li key={i} className="rounded border border-slate-200 bg-white px-2 py-1 text-xs">
                                      <span className="text-slate-700">{rm.text}</span>
                                      <span className="ml-2 text-[10px] text-slate-400">— {rm.by || 'Unknown'} · {new Date(rm.at).toLocaleString('en-GB')}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {canWrite && (
                                <div className="mt-2 flex items-start gap-2">
                                  <textarea className="input min-h-[38px] flex-1 text-xs" placeholder="Add a remark (appended to the history, never overwrites)…" value={draft} onChange={(e) => setDraft(e.target.value)} />
                                  <button className="btn-primary text-xs disabled:opacity-40" disabled={addRemark.isPending || !draft.trim()} onClick={() => addRemark.mutate({ id: r.id, text: draft.trim() })}>{addRemark.isPending ? 'Adding…' : 'Add remark'}</button>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
