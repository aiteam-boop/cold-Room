import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { EmptyState } from '../ui';

// Procurement PRD §5 (D1) — clean up BOQ headings: give every "Uncategorized" line
// a proper category (Refrigeration Units, Refrigerant Piping, …). The category is a
// classification (not scope/qty), so this stays editable even on a locked BOQ — the
// same rule the model-number field already follows. The immutable BOQ Master view is
// left untouched; this is the one place headings get re-mapped.
export default function BOQCategorizeView({ projectId, items, canWrite }: { projectId: string; items: any[]; canWrite: boolean }) {
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [unonly, setUnonly] = useState(true);
  const [q, setQ] = useState('');
  const [bulk, setBulk] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const leaves = useMemo(() => items.filter((i) => !i.isGroup), [items]);
  const catOf = (it: any) => (it.id in edits ? edits[it.id] : (it.category ?? ''));
  const isUn = (it: any) => { const c = catOf(it).trim(); return !c || c.toLowerCase() === 'uncategorized' || c.toLowerCase() === 'uncategorised'; };

  // Existing categories (across the project) power the type-or-pick datalist so the
  // user standardises instead of inventing near-duplicate spellings.
  const categories = useMemo(() => {
    const set = new Set<string>();
    leaves.forEach((i) => { const c = (i.category || '').trim(); if (c && !/^uncategori[sz]ed$/i.test(c)) set.add(c); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [leaves]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return leaves.filter((it) => (unonly ? isUn(it) : true) && (!needle || [it.srNo, it.description, it.roomZone, it.makeModel].some((v) => v?.toLowerCase?.().includes(needle))));
  }, [leaves, unonly, q, edits]);

  const dirty = Object.keys(edits).filter((id) => { const it = leaves.find((x) => x.id === id); return it && (edits[id] || '') !== (it.category ?? ''); });
  const unCount = leaves.filter(isUn).length;

  const setCat = (id: string, v: string) => setEdits((p) => ({ ...p, [id]: v }));

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/boq/items/categories`, { items: dirty.map((id) => ({ id, category: edits[id]?.trim() ? edits[id].trim() : null })) })).data,
    onSuccess: (r) => { setMsg({ ok: true, t: `Saved — ${r.updated} heading(s) categorised.` }); setEdits({}); qc.invalidateQueries({ queryKey: ['boq', projectId] }); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  // Apply the bulk category to every currently-shown line.
  const applyBulk = () => { if (!bulk.trim()) return; setEdits((p) => { const n = { ...p }; shown.forEach((it) => { n[it.id] = bulk.trim(); }); return n; }); };

  if (leaves.length === 0) return <EmptyState title="No BOQ imported yet" hint="Import the BOQ first — then categorise the headings here." />;

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Give every heading a proper category. This is a classification only — it never changes the BOQ scope or quantities, and works even on a locked BOQ.
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-500">{leaves.length} headings · <span className={unCount ? 'font-medium text-amber-600' : 'text-emerald-600'}>{unCount} uncategorised</span></span>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={unonly} onChange={(e) => setUnonly(e.target.checked)} /> Uncategorised only</label>
        <input className="input h-8 w-48 text-xs" placeholder="Search headings…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="ml-auto flex items-center gap-2">
          {canWrite && (
            <>
              <input className="input h-8 w-52 text-xs" list="boq-cats" placeholder="Set category for shown…" value={bulk} onChange={(e) => setBulk(e.target.value)} />
              <button className="btn-outline text-xs disabled:opacity-40" disabled={!bulk.trim() || shown.length === 0} onClick={applyBulk}>Apply to {shown.length}</button>
              <button className="btn-primary text-xs disabled:opacity-40" disabled={save.isPending || dirty.length === 0} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : `Save${dirty.length ? ` (${dirty.length})` : ''}`}</button>
            </>
          )}
        </div>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.t}</div>}

      <datalist id="boq-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>

      {shown.length === 0 ? (
        <EmptyState title={unonly ? 'All headings are categorised 🎉' : 'No headings match'} hint={unonly ? 'Nothing left to fix.' : undefined} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <tr><th className="px-3 py-2 w-16">Sr</th><th className="px-3 py-2">Heading / Description</th><th className="px-3 py-2 w-40">Room / Zone</th><th className="px-3 py-2 w-64">Category</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((it) => {
                const cur = catOf(it);
                const changed = (it.id in edits) && (edits[it.id] || '') !== (it.category ?? '');
                return (
                  <tr key={it.id} className="align-top">
                    <td className="px-3 py-2 text-xs text-slate-400">{it.srNo || '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-700">{(it.description || '').split('\n')[0]}</td>
                    <td className="px-3 py-2 text-xs text-slate-400">{it.roomZone || '—'}</td>
                    <td className="px-3 py-2">
                      <input
                        className={`input h-8 text-xs ${isUn(it) ? 'border-amber-400' : changed ? 'border-sky-400' : ''}`}
                        list="boq-cats" disabled={!canWrite} value={cur}
                        placeholder="— category —"
                        onChange={(e) => setCat(it.id, e.target.value)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
