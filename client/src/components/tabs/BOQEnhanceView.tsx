import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { EmptyState, Modal, Spinner } from '../ui';

// Features 1 (Make & Model), 2 (Item Lists), 6 (Completeness) for the BOQ.
export default function BOQEnhanceView({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const comp = useQuery({ queryKey: ['boq-completeness', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq-items/completeness`)).data });
  // Match BOQTab's cache shape ({ items, locked, categories }) — same queryKey.
  const boq = useQuery({ queryKey: ['boq', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data });
  const models = useQuery({ queryKey: ['machine-models'], queryFn: async () => (await api.get('/machine-models')).data.models as any[] });

  if (comp.isLoading || boq.isLoading) return <Spinner label="Analyzing BOQ…" />;
  const c = comp.data;
  const items = ((boq.data?.items as any[]) ?? []).filter((i) => !i.isGroup);
  const equipment = items.filter((i) => i.itemCategory === 'EQUIPMENT' || /(unit|compressor|condens|evaporator|refrigerat|scada|chiller)/i.test(`${i.description} ${i.category}`));

  return (
    <div className="space-y-4">
      {/* F6: completeness banner */}
      {c && (
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-600">BOQ Completeness</div>
            <div className={`text-2xl font-bold ${c.score >= 90 ? 'text-green-600' : c.score >= 70 ? 'text-amber-600' : 'text-red-600'}`}>{c.score}%</div>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3 text-sm">
            <Flag label="Missing quantity" n={c.flags.missingQty.count} items={c.flags.missingQty.items} />
            <Flag label="Equipment missing Make&Model" n={c.flags.missingModel.count} items={c.flags.missingModel.items} />
            <Flag label="Marked TBC/TBD" n={c.flags.tbd.count} items={c.flags.tbd.items} />
          </div>
          {!c.canLock && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">⚠ Baseline can't be locked until every equipment item has a Make & Model.</div>}
        </div>
      )}

      {/* F1: Make & Model per equipment item */}
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2 text-sm font-medium text-slate-600">Equipment — Make & Model ({equipment.length})</div>
        {equipment.length === 0 ? <div className="p-4 text-sm text-slate-400">No equipment items detected in this BOQ.</div> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">Item</th><th>Make & Model</th><th>Status</th>{canWrite && <th></th>}</tr></thead>
            <tbody>
              {equipment.map((it) => <ModelRow key={it.id} projectId={projectId} item={it} models={models.data ?? []} canWrite={canWrite} />)}
            </tbody>
          </table>
        )}
      </div>

      {/* F2: Item lists per BOQ item */}
      <ItemListSection projectId={projectId} items={items} canWrite={canWrite} />
    </div>
  );
}

function Flag({ label, n, items }: { label: string; n: number; items: any[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-lg p-2 ${n === 0 ? 'bg-green-50' : 'bg-red-50'}`}>
      <button className="flex w-full items-center justify-between" onClick={() => n && setOpen((o) => !o)}>
        <span className={n === 0 ? 'text-green-700' : 'text-red-700'}>{label}</span>
        <span className={`font-bold ${n === 0 ? 'text-green-700' : 'text-red-700'}`}>{n}</span>
      </button>
      {open && <ul className="mt-1 space-y-0.5 text-xs text-slate-500">{items.map((i: any) => <li key={i.id}>• {i.description.slice(0, 50)}</li>)}</ul>}
    </div>
  );
}

function ModelRow({ projectId, item, models, canWrite }: { projectId: string; item: any; models: any[]; canWrite: boolean }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (machineModelId: string) => api.patch(`/projects/${projectId}/boq-items/${item.id}/model`, { machineModelId: machineModelId || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['boq', projectId] }); qc.invalidateQueries({ queryKey: ['boq-completeness', projectId] }); },
    onError: (e) => alert(errMsg(e)),
  });
  const status = item.makeModelStatus || (item.makeModel ? 'CONFIRMED' : 'MISSING');
  const dot = status === 'CONFIRMED' ? 'bg-green-500' : status === 'PARTIAL' ? 'bg-amber-500' : 'bg-red-500';
  return (
    <tr className="border-b border-slate-100">
      <td className="px-4 py-2 text-slate-700">{item.description.slice(0, 60)}<div className="text-xs text-slate-400">{item.roomZone}</div></td>
      <td className="text-slate-600">{item.makeModel || <span className="text-slate-400">—</span>}</td>
      <td><span className="inline-flex items-center gap-1 text-xs"><span className={`h-2 w-2 rounded-full ${dot}`} />{status}</span></td>
      {canWrite && (
        <td className="px-2 py-1 text-right">
          <select className="rounded border border-slate-300 px-1 py-1 text-xs" value={item.machineModelId || ''} onChange={(e) => set.mutate(e.target.value)}>
            <option value="">Select model…</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.fullDisplayName || `${m.make} ${m.modelCode}`}</option>)}
          </select>
        </td>
      )}
    </tr>
  );
}

function ItemListSection({ projectId, items, canWrite }: { projectId: string; items: any[]; canWrite: boolean }) {
  const withQty = useMemo(() => items.filter((i) => (i.plannedQty ?? 0) > 0), [items]);
  const [openItem, setOpenItem] = useState<any | null>(null);
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-2 text-sm font-medium text-slate-600">Item Lists (vendor sub-item breakdown)</div>
      <div className="max-h-80 overflow-y-auto">
        {withQty.map((it) => (
          <div key={it.id} className="flex items-center justify-between border-b border-slate-50 px-4 py-2 text-sm">
            <div className="min-w-0"><span className="text-slate-700">{it.description.slice(0, 55)}</span><div className="text-xs text-slate-400">Planned {it.plannedQty} {it.unit}</div></div>
            <button className="text-xs font-medium text-navy hover:underline" onClick={() => setOpenItem(it)}>Item list →</button>
          </div>
        ))}
      </div>
      {openItem && <ItemListModal projectId={projectId} item={openItem} canWrite={canWrite} onClose={() => setOpenItem(null)} />}
    </div>
  );
}

function ItemListModal({ projectId, item, canWrite, onClose }: { projectId: string; item: any; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['item-list', item.id], queryFn: async () => (await api.get(`/projects/${projectId}/boq-items/${item.id}/item-list`)).data });
  const [rows, setRows] = useState<any[]>([{ itemCode: '', description: '', unit: item.unit || '', qty: 0 }]);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');

  const parse = useMutation({ mutationFn: (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/boq-items/${item.id}/item-list/parse`, fd); }, onSuccess: (r) => setRows(r.data.items.length ? r.data.items : rows), onError: (e) => setMsg(errMsg(e)) });
  const save = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/boq-items/${item.id}/item-list`, { items: rows, overrideNote: note || undefined }),
    onSuccess: () => { setMsg('Saved.'); qc.invalidateQueries({ queryKey: ['item-list', item.id] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const within = item.plannedQty <= 0 || (total >= item.plannedQty * 0.9 && total <= item.plannedQty * 1.1);

  return (
    <Modal title={`Item List — ${item.description.slice(0, 40)}`} onClose={onClose} wide>
      <div className="mb-2 text-sm text-slate-500">Planned: <strong>{item.plannedQty} {item.unit}</strong>. Sub-items should total within ±10%.</div>
      {list.data?.lists?.length > 0 && (
        <div className="mb-3 rounded-lg bg-slate-50 p-2 text-xs text-slate-500">
          {list.data.lists.length} saved list(s) · grand total {list.data.grandTotal} {item.unit}
        </div>
      )}
      {canWrite && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <label className="btn-outline cursor-pointer text-xs">Upload Excel<input type="file" className="hidden" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && parse.mutate(e.target.files[0])} /></label>
            <button className="btn-outline text-xs" onClick={() => setRows([...rows, { itemCode: '', description: '', unit: item.unit || '', qty: 0 }])}>+ Row</button>
            <span className={`ml-auto text-xs font-medium ${within ? 'text-green-600' : 'text-red-600'}`}>Total: {total} {item.unit} {within ? '✓' : '⚠ outside ±10%'}</span>
          </div>
          <div className="max-h-64 overflow-y-auto rounded border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-400"><tr><th className="px-2 py-1">Code</th><th>Description</th><th className="w-16">Unit</th><th className="w-20">Qty</th><th></th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="px-2 py-1"><input className="w-full rounded border border-transparent px-1 hover:border-slate-300" value={r.itemCode} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, itemCode: e.target.value } : x))} /></td>
                    <td><input className="w-full rounded border border-transparent px-1 hover:border-slate-300" value={r.description} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, description: e.target.value } : x))} /></td>
                    <td><input className="w-full rounded border border-transparent px-1 hover:border-slate-300" value={r.unit} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, unit: e.target.value } : x))} /></td>
                    <td><input className="w-full rounded border border-transparent px-1 text-right hover:border-slate-300" type="number" value={r.qty} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, qty: e.target.value } : x))} /></td>
                    <td><button className="px-1 text-slate-300 hover:text-red-500" onClick={() => setRows(rows.filter((_, idx) => idx !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!within && <input className="input mt-2 text-sm" placeholder="Justification (required to save outside ±10%)" value={note} onChange={(e) => setNote(e.target.value)} />}
          {msg && <div className="mt-2 text-xs text-slate-500">{msg}</div>}
          <div className="mt-3 flex justify-end gap-2"><button className="btn-outline" onClick={onClose}>Close</button><button className="btn-primary" disabled={save.isPending || (!within && !note)} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save Item List'}</button></div>
        </>
      )}
    </Modal>
  );
}
