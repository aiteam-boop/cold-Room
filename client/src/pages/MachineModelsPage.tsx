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
  const [detail, setDetail] = useState<any | null>(null);

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
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Make</th><th>Model Code</th><th>Capacity</th><th>Refrigerant</th><th className="text-right">Ref. Price</th><th className="text-right">Last Paid</th><th>TDS</th><th>Status</th>{canManage && <th></th>}</tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className={`cursor-pointer border-b border-slate-100 hover:bg-slate-50 ${m.isActive ? '' : 'opacity-50'}`} onClick={() => setDetail(m)} title="View details">
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
                  <td>{m.tdsUrl ? <a className="text-xs font-medium text-navy hover:underline" href={m.tdsUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>📄 TDS</a> : <span className="text-slate-300">—</span>}</td>
                  <td>{m.isActive ? <span className="badge bg-green-100 text-green-700">Active</span> : <span className="badge bg-slate-100 text-slate-500">Inactive</span>}</td>
                  {canManage && <td className="px-2 text-right"><button className="text-xs font-medium text-navy hover:underline" onClick={(e) => { e.stopPropagation(); setEditing(m); setShow(true); }}>Edit</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <ModelModal model={editing} onClose={() => setShow(false)} onDone={() => { setShow(false); qc.invalidateQueries({ queryKey: ['machine-models'] }); }} />}
      {detail && <ModelDetailModal model={detail} canManage={canManage} onClose={() => setDetail(null)} onEdit={() => { setEditing(detail); setDetail(null); setShow(true); }} />}
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
    tdsFormat: model?.tdsFormat ?? '', evaporatorTempC: model?.evaporatorTempC ?? '', condenserTempC: model?.condenserTempC ?? '',
    ambientTempC: model?.ambientTempC ?? '', airflow: model?.airflow ?? '', finSpacing: model?.finSpacing ?? '',
    fanDetail: model?.fanDetail ?? '', powerInputKw: model?.powerInputKw ?? '', weightKg: model?.weightKg ?? '',
    dimensions: model?.dimensions ?? '', voltage: model?.voltage ?? '', compressorModel: model?.compressorModel ?? '',
    specs: model?.specs ?? null,
  });
  const [err, setErr] = useState('');
  const [readMsg, setReadMsg] = useState('');
  const set = (p: any) => setF((s: any) => ({ ...s, ...p }));
  const numOrNull = (v: any) => (v === '' || v == null ? null : Number(v));

  const m = useMutation({
    mutationFn: () => {
      const payload = {
        ...f,
        capacityKW: numOrNull(f.capacityKW), unitPrice: numOrNull(f.unitPrice),
        evaporatorTempC: numOrNull(f.evaporatorTempC), condenserTempC: numOrNull(f.condenserTempC),
        ambientTempC: numOrNull(f.ambientTempC), powerInputKw: numOrNull(f.powerInputKw), weightKg: numOrNull(f.weightKg),
        tdsUrl: f.tdsUrl?.trim() || null,
        tdsFormat: f.tdsFormat || null, airflow: f.airflow || null, finSpacing: f.finSpacing || null,
        fanDetail: f.fanDetail || null, dimensions: f.dimensions || null, voltage: f.voltage || null, compressorModel: f.compressorModel || null,
      };
      return isEdit ? api.patch(`/machine-models/${model.id}`, payload) : api.post('/machine-models', payload);
    },
    onSuccess: onDone, onError: (e) => setErr(errMsg(e)),
  });

  // Upload a TDS → the datasheet fills the form (suggest-only; user confirms + saves).
  const readTds = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return (await api.post('/machine-models/extract-tds', fd)).data; },
    onSuccess: (d) => {
      const e = d.extracted || {};
      const put: any = { tdsUrl: d.tdsUrl || f.tdsUrl };
      // Fill only blanks — never clobber something the user already typed.
      const map: [string, any][] = [
        ['modelCode', e.modelNumber], ['make', e.make], ['capacityKW', e.capacityKW], ['refrigerantType', e.refrigerantType],
        ['tdsFormat', e.tdsFormat], ['evaporatorTempC', e.evaporatorTempC], ['condenserTempC', e.condenserTempC],
        ['ambientTempC', e.ambientTempC], ['airflow', e.airflow], ['finSpacing', e.finSpacing], ['fanDetail', e.fanDetail],
        ['powerInputKw', e.powerInputKw], ['weightKg', e.weightKg], ['dimensions', e.dimensions], ['voltage', e.voltage],
        ['compressorType', e.compressorType], ['compressorModel', e.compressorModel],
      ];
      for (const [k, v] of map) if (v != null && v !== '' && (f[k] === '' || f[k] == null)) put[k] = v;
      put.specs = e.specs ?? f.specs;
      set(put);
      const found = map.filter(([, v]) => v != null && v !== '').length;
      setReadMsg(e.source === 'none' ? (e.note || 'Could not read the datasheet.') : `Read ${found} field(s) from the ${e.tdsFormat || 'TDS'} datasheet — check and Save.`);
    },
    onError: (e) => setReadMsg(errMsg(e)),
  });
  const toggleRoom = (r: string) => setF((p: any) => ({ ...p, applicableRooms: p.applicableRooms.includes(r) ? p.applicableRooms.filter((x: string) => x !== r) : [...p.applicableRooms, r] }));

  return (
    <Modal title={isEdit ? 'Edit Machine Model' : 'Add Machine Model'} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="grid gap-3 sm:grid-cols-2">
        {/* TDS → auto-fill. Upload the datasheet and the fields below fill themselves
            (IDU / ODU / other). Or paste a link. Both options (PRD §7 OQ-4). */}
        <div className="sm:col-span-2 rounded-lg border border-dashed border-navy/30 bg-navy/5 p-3">
          <div className="mb-1 text-sm font-semibold text-navy">📄 Technical Data Sheet (TDS)</div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="btn-primary cursor-pointer text-sm">
              {readTds.isPending ? 'Reading…' : 'Upload TDS → auto-fill'}
              <input type="file" className="hidden" accept=".pdf,image/*" disabled={readTds.isPending} onChange={(e) => e.target.files?.[0] && readTds.mutate(e.target.files[0])} />
            </label>
            <span className="text-xs text-slate-400">or paste a link:</span>
            <input className="input h-8 flex-1 text-xs" value={f.tdsUrl} onChange={(e) => setF({ ...f, tdsUrl: e.target.value })} placeholder="https://… link to the datasheet" />
            {f.tdsUrl && <a className="text-xs font-medium text-navy hover:underline" href={f.tdsUrl} target="_blank" rel="noreferrer">open</a>}
          </div>
          {readMsg && <div className="mt-2 text-xs text-slate-600">{readMsg}</div>}
        </div>

        <div><label className="label">Make (Company) *</label><input className="input" required value={f.make} onChange={(e) => setF({ ...f, make: e.target.value })} placeholder="Micro Coils / Bitzer / Danfoss" /></div>
        <div><label className="label">Model Number *</label><input className="input" required value={f.modelCode} onChange={(e) => setF({ ...f, modelCode: e.target.value })} placeholder="MEE 5003 9D H F" /></div>
        <div><label className="label">TDS Format</label><select className="input" value={f.tdsFormat} onChange={(e) => setF({ ...f, tdsFormat: e.target.value })}><option value="">—</option><option>IDU</option><option>ODU</option><option>OTHER</option></select></div>
        <div><label className="label">Capacity (kW)</label><input className="input" type="number" step="any" value={f.capacityKW} onChange={(e) => setF({ ...f, capacityKW: e.target.value })} /></div>
        <div><label className="label">Refrigerant</label><select className="input" value={f.refrigerantType} onChange={(e) => setF({ ...f, refrigerantType: e.target.value })}><option value="">—</option>{REFRIGERANTS.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div><label className="label">Evaporator Temp (°C)</label><input className="input" type="number" step="any" value={f.evaporatorTempC} onChange={(e) => setF({ ...f, evaporatorTempC: e.target.value })} /></div>
        <div><label className="label">Condenser Temp (°C)</label><input className="input" type="number" step="any" value={f.condenserTempC} onChange={(e) => setF({ ...f, condenserTempC: e.target.value })} /></div>
        <div><label className="label">Ambient Temp (°C)</label><input className="input" type="number" step="any" value={f.ambientTempC} onChange={(e) => setF({ ...f, ambientTempC: e.target.value })} /></div>
        <div><label className="label">Air Flow</label><input className="input" value={f.airflow} onChange={(e) => setF({ ...f, airflow: e.target.value })} placeholder="21465 m3/h" /></div>
        <div><label className="label">Fan Detail</label><input className="input" value={f.fanDetail} onChange={(e) => setF({ ...f, fanDetail: e.target.value })} placeholder="500 mm X 3" /></div>
        <div><label className="label">Fin Spacing</label><input className="input" value={f.finSpacing} onChange={(e) => setF({ ...f, finSpacing: e.target.value })} placeholder="7 MM" /></div>
        <div><label className="label">Voltage</label><input className="input" value={f.voltage} onChange={(e) => setF({ ...f, voltage: e.target.value })} placeholder="415V/3PH" /></div>
        <div><label className="label">Power Input (kW)</label><input className="input" type="number" step="any" value={f.powerInputKw} onChange={(e) => setF({ ...f, powerInputKw: e.target.value })} /></div>
        <div><label className="label">Weight (kg)</label><input className="input" type="number" step="any" value={f.weightKg} onChange={(e) => setF({ ...f, weightKg: e.target.value })} /></div>
        <div><label className="label">Dimensions</label><input className="input" value={f.dimensions} onChange={(e) => setF({ ...f, dimensions: e.target.value })} placeholder="L x W x H mm" /></div>
        <div><label className="label">Compressor</label><select className="input" value={f.compressorType} onChange={(e) => setF({ ...f, compressorType: e.target.value })}><option value="">—</option>{COMPRESSORS.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div><label className="label">Compressor Model</label><input className="input" value={f.compressorModel} onChange={(e) => setF({ ...f, compressorModel: e.target.value })} placeholder="HGX56e/995-4L (Bock)" /></div>
        {/* §6b — reference price. */}
        <div><label className="label">Reference Price (₹)</label><input className="input" type="number" step="any" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} placeholder="list / standard price" /></div>
        {isEdit && <div><label className="label">Status</label><select className="input" value={f.isActive ? '1' : '0'} onChange={(e) => setF({ ...f, isActive: e.target.value === '1' })}><option value="1">Active</option><option value="0">Inactive</option></select></div>}
        <div className="sm:col-span-2">
          <label className="label">Applicable Rooms <span className="text-[11px] font-normal text-slate-400">— which room this machine is used in (not in the TDS)</span></label>
          <div className="flex flex-wrap gap-2">{ROOMS.map((r) => <button type="button" key={r} onClick={() => toggleRoom(r)} className={`rounded-full px-3 py-1 text-xs ${f.applicableRooms.includes(r) ? 'bg-navy text-white' : 'bg-slate-100 text-slate-600'}`}>{r}</button>)}</div>
        </div>
        {err && <div className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Model'}</button></div>
      </form>
    </Modal>
  );
}

// Read-only details popup — every field, incl. all the TDS-extracted specs.
function ModelDetailModal({ model, canManage, onClose, onEdit }: { model: any; canManage: boolean; onClose: () => void; onEdit: () => void }) {
  const m = model;
  // The columnised fields, shown as a labelled grid (blanks hidden).
  const fields: [string, any][] = [
    ['Make (Company)', m.make],
    ['Model Number', m.modelCode],
    ['TDS Format', m.tdsFormat],
    ['Capacity', m.capacityKW != null ? `${m.capacityKW} kW` : null],
    ['Refrigerant', m.refrigerantType],
    ['Evaporator Temp', m.evaporatorTempC != null ? `${m.evaporatorTempC} °C` : null],
    ['Condenser Temp', m.condenserTempC != null ? `${m.condenserTempC} °C` : null],
    ['Ambient Temp', m.ambientTempC != null ? `${m.ambientTempC} °C` : null],
    ['Air Flow', m.airflow],
    ['Fan Detail', m.fanDetail],
    ['Fin Spacing', m.finSpacing],
    ['Voltage', m.voltage],
    ['Power Input', m.powerInputKw != null ? `${m.powerInputKw} kW` : null],
    ['Weight', m.weightKg != null ? `${m.weightKg} kg` : null],
    ['Dimensions', m.dimensions],
    ['Compressor', m.compressorType],
    ['Compressor Model', m.compressorModel],
    ['Reference Price', m.unitPrice != null ? inr(m.unitPrice) : null],
    ['Last Paid', m.lastPaidPrice != null ? `${inr(m.lastPaidPrice)}${m.lastPaidVendor ? ` · ${m.lastPaidVendor}` : ''}${m.lastPaidAt ? ` · ${fmtDate(m.lastPaidAt)}` : ''}` : null],
    ['Applicable Rooms', (m.applicableRooms ?? []).join(', ') || null],
    ['Status', m.isActive ? 'Active' : 'Inactive'],
  ];
  // Any extra "Label: value" pairs read off the TDS that aren't columnised above.
  const specs: Record<string, string> = m.specs && typeof m.specs === 'object' ? m.specs : {};

  return (
    <Modal title={`${m.make} — ${m.modelCode}`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {fields.filter(([, v]) => v != null && v !== '').map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 border-b border-slate-100 py-1 text-sm">
              <span className="text-slate-400">{label}</span>
              <span className="text-right font-medium text-slate-700">{value}</span>
            </div>
          ))}
        </div>

        {m.tdsUrl && (
          <div><a className="text-sm font-medium text-navy hover:underline" href={m.tdsUrl} target="_blank" rel="noreferrer">📄 Open Technical Data Sheet (TDS)</a></div>
        )}

        {Object.keys(specs).length > 0 && (
          <details className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Full datasheet ({Object.keys(specs).length} fields read from the TDS)</summary>
            <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {Object.entries(specs).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 text-xs">
                  <span className="text-slate-400">{k}</span>
                  <span className="text-right text-slate-600">{String(v)}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-outline" onClick={onClose}>Close</button>
          {canManage && <button className="btn-primary" onClick={onEdit}>Edit</button>}
        </div>
      </div>
    </Modal>
  );
}
