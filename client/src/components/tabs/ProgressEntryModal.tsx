import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { Modal, ProgressBar } from '../ui';
import { fmtNum } from '../../lib/format';

interface Item {
  id: string; description: string; unit?: string; plannedQty: number;
  installedQty: number; remainingQty: number; completionPct: number;
}

export default function ProgressEntryModal({ projectId, items, preselect, onClose, onSaved }: {
  projectId: string; items: Item[]; preselect: Item | null; onClose: () => void; onSaved: () => void;
}) {
  const [itemId, setItemId] = useState(preselect?.id ?? '');
  const [search, setSearch] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [qty, setQty] = useState('');
  const [remarks, setRemarks] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [err, setErr] = useState('');

  const item = items.find((i) => i.id === itemId) || null;
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return items.filter((i) => i.description.toLowerCase().includes(q)).slice(0, 50);
  }, [items, search]);

  const qtyNum = Number(qty);
  const overLimit = item && item.plannedQty > 0 && qtyNum > item.remainingQty;
  const valid = !!item && qtyNum > 0 && !overLimit;
  const newPct = item && item.plannedQty > 0 ? Math.min(((item.installedQty + (qtyNum || 0)) / item.plannedQty) * 100, 100) : 0;

  const save = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append('boqItemId', itemId);
      fd.append('date', date);
      fd.append('quantityInstalled', String(qtyNum));
      if (remarks) fd.append('remarks', remarks);
      if (photo) fd.append('photo', photo);
      return api.post(`/projects/${projectId}/progress`, fd);
    },
    onSuccess: onSaved,
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <Modal title="Log Daily Progress" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="space-y-4">
        {/* Activity selector (searchable) */}
        <div>
          <label className="label">Activity (BOQ item) *</label>
          {!preselect && (
            <input className="input mb-2" placeholder="Search activities…" value={search} onChange={(e) => setSearch(e.target.value)} />
          )}
          <select className="input" value={itemId} onChange={(e) => setItemId(e.target.value)} required size={preselect ? 1 : 1}>
            <option value="">Select an activity…</option>
            {(preselect ? items : filtered).map((i) => (
              <option key={i.id} value={i.id}>{i.description} ({fmtNum(i.remainingQty)} {i.unit} left)</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Date of work *</label>
            <input className="input" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div>
            <label className="label">Quantity installed * {item?.unit && <span className="text-slate-400">({item.unit})</span>}</label>
            <input className="input" type="number" step="any" min="0" value={qty} onChange={(e) => setQty(e.target.value)} required />
          </div>
        </div>

        <div>
          <label className="label">Photo (optional proof)</label>
          <input className="input" type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <label className="label">Remarks</label>
          <textarea className="input" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>

        {/* Live preview (PRD §10.6) */}
        {item && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Current: {fmtNum(item.installedQty)} / {fmtNum(item.plannedQty)} {item.unit}</span>
              <span className="font-medium">{item.completionPct}% → <span className="text-navy">{Math.round(newPct * 10) / 10}%</span></span>
            </div>
            <div className="mt-2"><ProgressBar pct={newPct} /></div>
            {item.plannedQty > 0 && <div className="mt-1 text-xs text-slate-400">Remaining after this entry: {fmtNum(Math.max(item.remainingQty - (qtyNum || 0), 0))} {item.unit}</div>}
          </div>
        )}

        {overLimit && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">Quantity exceeds remaining planned ({fmtNum(item!.remainingQty)} {item!.unit}).</div>}
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        <div className="flex items-center justify-between pt-1">
          <div className="text-xs text-slate-400">Submits to the supervisor approval queue.</div>
          <div className="flex gap-2">
            <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={!valid || save.isPending}>{save.isPending ? 'Submitting…' : 'Submit for Approval'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
