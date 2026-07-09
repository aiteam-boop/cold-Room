// The sheet's `Daily_Entry` tab — the single shared input surface.
//
// AA sir: "item se pehle room aayega, room ke baad category, category ke baad
// item… pehle main ko pakdo, father ko, phir ladke ko, phir pote ko."
// So the form is a strict Room → Category → Item cascade. UOM is displayed, not
// typed: it belongs to the scope row (the sheet let people type "sq.m" and
// "Sq.m" for the same activity).
//
// Unlike the sheet, the Item list is filtered by the chosen Room. In the workbook
// the Item dropdown is one flat list of all 28 activities, which is how
// "Freezer / Refrigeration / Refrigeration Piping — 10 Rmt" got logged on
// 14-Jun-26 and then counted by nothing at all.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Modal, Spinner } from '../ui';
import { sheetDate } from './shared';

interface OptionScope { id: string; zoneId: string; category: string; activity: string; uom: string }
interface OptionRoom { id: string; zoneName: string; isCommonBucket: boolean; categories: string[]; activities: OptionScope[] }

interface Entry {
  id: string;
  kind: string;
  date: string;
  qtyDoneToday: number;
  labourTeam: string | null;
  remarks: string | null;
  roomScopeItem: { activity: string; category: string; uom: string; zone: { id: string; zoneName: string } };
}

const today = () => new Date().toISOString().slice(0, 10);

export default function DailyEntryTab({ projectId }: { projectId: string }) {
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [adjustFor, setAdjustFor] = useState<OptionScope | null>(null);

  const { data: opts } = useQuery({
    queryKey: ['dpr-options', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/dpr/options`)).data as { rooms: OptionRoom[] },
  });
  const { data, isLoading } = useQuery({
    queryKey: ['dpr-entries', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/dpr/entries`)).data as { entries: Entry[] },
  });

  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/projects/${projectId}/dpr/entries/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dpr'] }); qc.invalidateQueries({ queryKey: ['dpr-entries'] }); },
  });

  if (isLoading) return <Spinner label="Loading daily log…" />;
  const entries = data?.entries ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-navy">Daily Progress Entry</h2>
          <p className="text-xs text-slate-400">
            One row per activity completed today. Enter <strong>today's quantity only</strong>, not the cumulative — every
            room sheet updates itself.
          </p>
        </div>
        {canEdit('dpr') && (
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={() => setAdjustFor({ id: '', zoneId: '', category: '', activity: '', uom: '' })}>
              Opening balance / adjustment
            </button>
            <button className="btn-primary" onClick={() => setOpen(true)}>+ Add entry</button>
          </div>
        )}
      </div>

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-navy text-left text-xs uppercase tracking-wide text-white">
                <th className="px-3 py-2.5 font-semibold">Date</th>
                <th className="px-3 py-2.5 font-semibold">Room</th>
                <th className="px-3 py-2.5 font-semibold">Category</th>
                <th className="px-3 py-2.5 font-semibold">Item / Activity</th>
                <th className="px-3 py-2.5 font-semibold">UOM</th>
                <th className="px-3 py-2.5 text-right font-semibold">Qty Done Today</th>
                <th className="px-3 py-2.5 font-semibold">Labour / Team</th>
                <th className="px-3 py-2.5 font-semibold">Remarks</th>
                {canEdit('dpr') && <th className="px-3 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">No entries yet.</td></tr>
              )}
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-700">{sheetDate(e.date)}</td>
                  <td className="px-3 py-2 text-slate-600">{e.roomScopeItem.zone.zoneName}</td>
                  <td className="px-3 py-2 text-slate-600">{e.roomScopeItem.category}</td>
                  <td className="px-3 py-2 text-slate-700">
                    {e.roomScopeItem.activity}
                    {e.kind !== 'DAILY' && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-700"
                        title="Not a day's work — an opening balance or a correction to the running total">
                        {e.kind}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{e.roomScopeItem.uom}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800">{e.qtyDoneToday}</td>
                  <td className="px-3 py-2 text-slate-600">{e.labourTeam || '—'}</td>
                  <td className="max-w-xs px-3 py-2 text-xs text-slate-500">{e.remarks || '—'}</td>
                  {canEdit('dpr') && (
                    <td className="px-3 py-2 text-right">
                      <button className="text-xs text-red-500 hover:underline"
                        onClick={() => { if (confirm('Delete this entry? Every rollup will recalculate.')) del.mutate(e.id); }}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {open && opts && <EntryModal projectId={projectId} rooms={opts.rooms} onClose={() => setOpen(false)} />}
      {adjustFor && opts && <AdjustModal projectId={projectId} rooms={opts.rooms} onClose={() => setAdjustFor(null)} />}
    </div>
  );
}

// ── Add-entry modal: the Room → Category → Item cascade ──────────────────────

function useCascade(rooms: OptionRoom[]) {
  const [zoneId, setZoneId] = useState('');
  const [category, setCategory] = useState('');
  const [activityId, setActivityId] = useState('');

  const room = rooms.find((r) => r.id === zoneId);
  const categories = room?.categories ?? [];
  const activities = useMemo(
    () => (room?.activities ?? []).filter((a) => !category || a.category === category),
    [room, category],
  );
  const scope = activities.find((a) => a.id === activityId);

  // Changing a parent invalidates its children — that is the whole point of the
  // cascade, and the reason the sheet's flat dropdown loses data.
  const pickRoom = (v: string) => { setZoneId(v); setCategory(''); setActivityId(''); };
  const pickCategory = (v: string) => { setCategory(v); setActivityId(''); };

  return { zoneId, category, activityId, room, categories, activities, scope, pickRoom, pickCategory, setActivityId };
}

function EntryModal({ projectId, rooms, onClose }: { projectId: string; rooms: OptionRoom[]; onClose: () => void }) {
  const qc = useQueryClient();
  const c = useCascade(rooms);
  const [date, setDate] = useState(today());
  const [qty, setQty] = useState('');
  const [labourTeam, setLabourTeam] = useState('');
  const [remarks, setRemarks] = useState('');
  const [err, setErr] = useState('');

  const save = useMutation({
    mutationFn: async () =>
      api.post(`/projects/${projectId}/dpr/entries`, {
        roomScopeItemId: c.activityId, date, qtyDoneToday: Number(qty),
        labourTeam: labourTeam || undefined, remarks: remarks || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dpr'] });
      qc.invalidateQueries({ queryKey: ['dpr-entries'] });
      onClose();
    },
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Could not save the entry.'),
  });

  const ready = c.activityId && date && Number(qty) > 0;

  return (
    <Modal title="Daily Progress Entry" onClose={onClose}>
      <div className="space-y-3">
        {err && <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}

        <Field label="Date">
          <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>

        <Field label="Room" hint="Refrigeration & Electrical work lives under Common / Plant-wide">
          <select className="input" value={c.zoneId} onChange={(e) => c.pickRoom(e.target.value)}>
            <option value="">Select room…</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.zoneName}</option>)}
          </select>
        </Field>

        <Field label="Category">
          <select className="input" value={c.category} disabled={!c.zoneId} onChange={(e) => c.pickCategory(e.target.value)}>
            <option value="">{c.zoneId ? 'Select category…' : 'Pick a room first'}</option>
            {c.categories.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>

        <Field label="Item / Activity">
          <select className="input" value={c.activityId} disabled={!c.category} onChange={(e) => c.setActivityId(e.target.value)}>
            <option value="">{c.category ? 'Select activity…' : 'Pick a category first'}</option>
            {c.activities.map((a) => <option key={a.id} value={a.id}>{a.activity}</option>)}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="UOM">
            <input className="input bg-slate-50 text-slate-500" value={c.scope?.uom ?? ''} readOnly placeholder="—" />
          </Field>
          <Field label="Qty Done Today">
            <input type="number" step="any" min="0" className="input" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Today's quantity only" />
          </Field>
        </div>

        <Field label="Labour / Team">
          <input className="input" value={labourTeam} onChange={(e) => setLabourTeam(e.target.value)} placeholder="Team A, Rehman…" />
        </Field>
        <Field label="Remarks">
          <textarea className="input" rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!ready || save.isPending} onClick={() => { setErr(''); save.mutate(); }}>
            {save.isPending ? 'Saving…' : 'Save entry'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Opening balance / adjustment ─────────────────────────────────────────────
// The auditable replacement for typing over the SUMIFS.

function AdjustModal({ projectId, rooms, onClose }: { projectId: string; rooms: OptionRoom[]; onClose: () => void }) {
  const qc = useQueryClient();
  const c = useCascade(rooms);
  const [date, setDate] = useState(today());
  const [qty, setQty] = useState('');
  const [kind, setKind] = useState<'OPENING' | 'ADJUSTMENT'>('OPENING');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');

  const save = useMutation({
    mutationFn: async () =>
      api.post(`/projects/${projectId}/dpr/entries/adjustment`, { roomScopeItemId: c.activityId, date, qty: Number(qty), kind, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dpr'] });
      qc.invalidateQueries({ queryKey: ['dpr-entries'] });
      onClose();
    },
    onError: (e: any) => setErr(e?.response?.data?.error ?? 'Could not save the adjustment.'),
  });

  const ready = c.activityId && date && Number(qty) !== 0 && reason.trim().length >= 3;

  return (
    <Modal title="Opening balance / manual adjustment" onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Use this when a cumulative quantity is known from site but was never logged day-by-day — the situation people
          handled in the sheet by typing over the <code>SUMIFS</code> formula. Here the number still adds up, but it
          carries your name, the date and a reason.
        </div>
        {err && <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as 'OPENING' | 'ADJUSTMENT')}>
              <option value="OPENING">Opening balance (work done before the app)</option>
              <option value="ADJUSTMENT">Correction to the running total</option>
            </select>
          </Field>
          <Field label="Date">
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label="Room">
          <select className="input" value={c.zoneId} onChange={(e) => c.pickRoom(e.target.value)}>
            <option value="">Select room…</option>
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.zoneName}</option>)}
          </select>
        </Field>
        <Field label="Category">
          <select className="input" value={c.category} disabled={!c.zoneId} onChange={(e) => c.pickCategory(e.target.value)}>
            <option value="">{c.zoneId ? 'Select category…' : 'Pick a room first'}</option>
            {c.categories.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="Item / Activity">
          <select className="input" value={c.activityId} disabled={!c.category} onChange={(e) => c.setActivityId(e.target.value)}>
            <option value="">{c.category ? 'Select activity…' : 'Pick a category first'}</option>
            {c.activities.map((a) => <option key={a.id} value={a.id}>{a.activity}</option>)}
          </select>
        </Field>

        <Field label={`Quantity ${c.scope ? `(${c.scope.uom})` : ''}`} hint="Negative values are allowed on a correction">
          <input type="number" step="any" className="input" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Reason" hint="Required — this is what the sheet never captured">
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. 145 Sq.m of back wall completed before the app was rolled out" />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!ready || save.isPending} onClick={() => { setErr(''); save.mutate(); }}>
            {save.isPending ? 'Saving…' : 'Record adjustment'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {children}
      {hint && <div className="mt-1 text-[11px] text-slate-400">{hint}</div>}
    </div>
  );
}
