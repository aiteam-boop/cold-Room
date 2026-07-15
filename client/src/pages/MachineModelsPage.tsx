import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Modal, Spinner } from '../components/ui';
import { inr, fmtDate } from '../lib/format';

const ROOMS = ['Blast Freezer', 'Freezer', 'Chiller', 'Ambient', 'Cold Anteroom', 'Anteroom'];
const REFRIGERANTS = ['R404A', 'R134a', 'R407C', 'R448A', 'R32', 'R290'];
const COMPRESSORS = ['Semi-hermetic', 'Scroll', 'VFD', 'Reciprocating'];

// Machine make & model master (Feature 1). Equipment BOQ items pick from this.
export default function MachineModelsPage() {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canManage = canEdit('machinemodels');
  const [q, setQ] = useState('');
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['machine-models', q],
    queryFn: async () => (await api.get(`/machine-models?includeInactive=true${q ? `&q=${encodeURIComponent(q)}` : ''}`)).data.models as any[],
  });

  if (isLoading) return <Spinner label="Loading machine models…" />;
  if (error) return <div className="card p-6 text-red-600">You don't have access to the machine model master.</div>;
  const models = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-navy">Machine Make & Model Master</h1>
          <p className="text-sm text-slate-500">Refrigeration equipment options selectable on BOQ equipment items.</p>
        </div>
        <div className="flex items-center gap-2">
          <input className="input w-56" placeholder="Search make / model…" value={q} onChange={(e) => setQ(e.target.value)} />
          {canManage && <button className="btn-primary" onClick={() => { setEditing(null); setShow(true); }}>+ Add Model</button>}
        </div>
      </div>

      {models.length === 0 ? (
        <EmptyState title="No machine models yet" hint="Add makes/models (Bitzer, Copeland, Danfoss…) so equipment BOQ items can be matched to a specific unit." action={canManage ? <button className="btn-primary mt-2" onClick={() => setShow(true)}>+ Add Model</button> : undefined} />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Make</th><th>Model Code</th><th>Capacity</th><th>Refrigerant</th><th className="text-right">Ref. Price</th><th className="text-right">Last Paid</th><th>TDS</th><th>Status</th>{canManage && <th></th>}</tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className={`border-b border-slate-100 hover:bg-slate-50 ${m.isActive ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2 font-medium text-navy">{m.make}</td>
                  <td className="text-slate-700">{m.modelCode}</td>
                  <td className="text-slate-500">{m.capacityKW ? `${m.capacityKW} kW` : '—'}</td>
                  <td className="text-slate-500">{m.refrigerantType || '—'}</td>
                  {/* §6b — the reference price and what we actually paid last time. */}
                  <td className="text-right text-slate-600">{m.unitPrice != null ? inr(m.unitPrice) : '—'}</td>
                  <td className="text-right text-xs">
                    {m.lastPaidPrice != null
                      ? <span className="font-medium text-navy" title={`${m.lastPaidVendor ?? ''}${m.lastPaidAt ? ` · ${fmtDate(m.lastPaidAt)}` : ''}`}>{inr(m.lastPaidPrice)}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td>{m.tdsUrl ? <a className="text-xs font-medium text-navy hover:underline" href={m.tdsUrl} target="_blank" rel="noreferrer">📄 TDS</a> : <span className="text-slate-300">—</span>}</td>
                  <td>{m.isActive ? <span className="badge bg-green-100 text-green-700">Active</span> : <span className="badge bg-slate-100 text-slate-500">Inactive</span>}</td>
                  {canManage && <td className="px-2 text-right"><button className="text-xs font-medium text-navy hover:underline" onClick={() => { setEditing(m); setShow(true); }}>Edit</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <ModelModal model={editing} onClose={() => setShow(false)} onDone={() => { setShow(false); qc.invalidateQueries({ queryKey: ['machine-models'] }); }} />}
    </div>
  );
}

function ModelModal({ model, onClose, onDone }: { model?: any; onClose: () => void; onDone: () => void }) {
  const isEdit = !!model?.id;
  const [f, setF] = useState<any>({
    make: model?.make ?? '', modelCode: model?.modelCode ?? '', capacityKW: model?.capacityKW ?? '',
    refrigerantType: model?.refrigerantType ?? '', compressorType: model?.compressorType ?? '',
    applicableRooms: model?.applicableRooms ?? [], isActive: model?.isActive ?? true,
    unitPrice: model?.unitPrice ?? '', tdsUrl: model?.tdsUrl ?? '',
  });
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => {
      const payload = { ...f, capacityKW: f.capacityKW === '' ? null : Number(f.capacityKW), unitPrice: f.unitPrice === '' ? null : Number(f.unitPrice), tdsUrl: f.tdsUrl?.trim() || null };
      return isEdit ? api.patch(`/machine-models/${model.id}`, payload) : api.post('/machine-models', payload);
    },
    onSuccess: onDone, onError: (e) => setErr(errMsg(e)),
  });
  const toggleRoom = (r: string) => setF((p: any) => ({ ...p, applicableRooms: p.applicableRooms.includes(r) ? p.applicableRooms.filter((x: string) => x !== r) : [...p.applicableRooms, r] }));

  return (
    <Modal title={isEdit ? 'Edit Machine Model' : 'Add Machine Model'} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Make *</label><input className="input" required value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} placeholder="Bitzer / Copeland / Danfoss" /></div>
        <div><label className="label">Model Code *</label><input className="input" required value={f.modelCode} onChange={(e) => setF({ ...f, modelCode: e.target.value })} placeholder="S6F-30.2Y-40P" /></div>
        <div><label className="label">Capacity (kW)</label><input className="input" type="number" step="any" value={f.capacityKW} onChange={(e) => setF({ ...f, capacityKW: e.target.value })} /></div>
        <div><label className="label">Refrigerant</label><select className="input" value={f.refrigerantType} onChange={(e) => setF({ ...f, refrigerantType: e.target.value })}><option value="">—</option>{REFRIGERANTS.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div><label className="label">Compressor</label><select className="input" value={f.compressorType} onChange={(e) => setF({ ...f, compressorType: e.target.value })}><option value="">—</option>{COMPRESSORS.map((r) => <option key={r}>{r}</option>)}</select></div>
        {isEdit && <div><label className="label">Status</label><select className="input" value={f.isActive ? '1' : '0'} onChange={(e) => setF({ ...f, isActive: e.target.value === '1' })}><option value="1">Active</option><option value="0">Inactive</option></select></div>}
        {/* §6b — reference price + technical datasheet (TDS). */}
        <div><label className="label">Reference Price (₹)</label><input className="input" type="number" step="any" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} placeholder="list / standard price" /></div>
        <div><label className="label">TDS / Datasheet URL</label><input className="input" value={f.tdsUrl} onChange={(e) => setF({ ...f, tdsUrl: e.target.value })} placeholder="link to the spec PDF" /></div>
        <div className="sm:col-span-2">
          <label className="label">Applicable Rooms</label>
          <div className="flex flex-wrap gap-2">{ROOMS.map((r) => <button type="button" key={r} onClick={() => toggleRoom(r)} className={`rounded-full px-3 py-1 text-xs ${f.applicableRooms.includes(r) ? 'bg-navy text-white' : 'bg-slate-100 text-slate-600'}`}>{r}</button>)}</div>
        </div>
        {err && <div className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Model'}</button></div>
      </form>
    </Modal>
  );
}
