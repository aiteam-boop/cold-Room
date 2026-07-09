// One room's "SCOPE & PROGRESS TRACKER" tab (Ambient Room, Chiller Room, …,
// and Common_Works, which uses the same layout with the plant-wide catalogue).
//
// Editable columns (what a human owns):   Target Qty, Planned Start/Finish/Handover, Remarks
// Derived columns (what the log owns):    Cumulative Qty Done, % Complete, Balance Qty, Last Updated, Status
//
// Target Qty is the drawing team's room-wise breakup — AA sir: "ye tumhara BOQ se
// todna padega… give me room wise breakup of panel". Until it arrives the row has
// no denominator, so its % is blank in Sheet mode and 0% in Corrected mode.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import {
  DprActivity, DprRoom, DprWarning, ModeToggle, Pct, StatusPill, WarningList,
  numOrDash, sheetDate, useDprMode,
} from './shared';

interface RoomResponse { room: DprRoom; mode: string; warnings: DprWarning[] }

const isoDay = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export default function RoomSheet({ projectId, zoneId }: { projectId: string; zoneId: string }) {
  const [mode, setMode] = useDprMode();
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const editable = canEdit('dpr');

  const { data, isLoading } = useQuery({
    queryKey: ['dpr-room', projectId, zoneId, mode],
    queryFn: async () => (await api.get(`/projects/${projectId}/dpr/rooms/${zoneId}?mode=${mode}`)).data as RoomResponse,
  });

  const patch = useMutation({
    mutationFn: async ({ itemId, body }: { itemId: string; body: Record<string, unknown> }) =>
      api.patch(`/projects/${projectId}/dpr/scope/${itemId}`, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dpr'] }); qc.invalidateQueries({ queryKey: ['dpr-room'] }); },
  });

  const handover = useMutation({
    mutationFn: async (force: boolean) =>
      api.post(`/projects/${projectId}/dpr/rooms/${zoneId}/handover`, { actualHandoverDate: new Date().toISOString().slice(0, 10), force }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dpr'] }); qc.invalidateQueries({ queryKey: ['dpr-room'] }); },
    onError: (e: any) => alert(e?.response?.data?.error ?? 'Could not record the handover.'),
  });

  if (isLoading) return <Spinner label="Loading room…" />;
  if (!data) return <div className="card p-6 text-red-600">Could not load this room.</div>;
  const { room } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold uppercase text-navy">{room.roomName} — Scope &amp; Progress Tracker</h2>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <WarningList warnings={data.warnings.filter((w) => w.code !== 'STALE_ROOM' || (room.staleDays ?? 0) > 7)} />

      {/* The room sheets' row-4 header strip */}
      <div className="card flex flex-wrap items-center gap-6 px-4 py-3">
        <Stat label="Room Overall % Complete" value={`${Math.round(room.overallPct * 100)}%`} big />
        <Stat label="Planned Handover Date" value={sheetDate(room.plannedHandoverDate)} />
        <Stat label="Actual Handover Date" value={sheetDate(room.actualHandoverDate)} />
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">Status</div>
          <div className="mt-0.5"><StatusPill status={room.handoverStatus} /></div>
        </div>
        {room.targetMissingCount > 0 && (
          <div className="rounded bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700">
            {room.targetMissingCount} of {room.activityCount} activities have no Target Qty
          </div>
        )}
        {editable && !room.isCommonBucket && !room.actualHandoverDate && (
          <button
            className="btn-secondary ml-auto"
            onClick={() => {
              if (room.overallPct >= 1) return handover.mutate(false);
              if (confirm(`${room.roomName} is ${Math.round(room.overallPct * 100)}% complete. Record handover anyway?`)) handover.mutate(true);
            }}
          >
            Record handover
          </button>
        )}
      </div>

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-navy text-left text-xs uppercase tracking-wide text-white">
                <th className="px-2.5 py-2.5 font-semibold">S.No</th>
                <th className="px-2.5 py-2.5 font-semibold">Category</th>
                <th className="px-2.5 py-2.5 font-semibold">Item / Activity</th>
                <th className="px-2.5 py-2.5 font-semibold">UOM</th>
                <th className="px-2.5 py-2.5 text-right font-semibold">Target Qty</th>
                <th className="px-2.5 py-2.5 font-semibold">Planned Start</th>
                <th className="px-2.5 py-2.5 font-semibold">Planned Finish</th>
                <th className="px-2.5 py-2.5 font-semibold">Planned Handover</th>
                <th className="px-2.5 py-2.5 text-right font-semibold">Cum. Qty Done</th>
                <th className="px-2.5 py-2.5 font-semibold">% Complete</th>
                <th className="px-2.5 py-2.5 text-right font-semibold">Balance Qty</th>
                <th className="px-2.5 py-2.5 font-semibold">Last Updated</th>
                <th className="px-2.5 py-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {room.activities.map((a, i) => (
                <Row key={a.id} a={a} index={i + 1} editable={editable}
                  onSave={(body) => patch.mutate({ itemId: a.id, body })} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ a, index, editable, onSave }: {
  a: DprActivity; index: number; editable: boolean; onSave: (body: Record<string, unknown>) => void;
}) {
  const [target, setTarget] = useState(a.targetQty == null ? '' : String(a.targetQty));

  const commitTarget = () => {
    const trimmed = target.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0)) { setTarget(a.targetQty == null ? '' : String(a.targetQty)); return; }
    if (next === a.targetQty) return;
    onSave({ targetQty: next, targetSource: next == null ? null : 'DRAWING' });
  };

  const dateCell = (field: 'plannedStart' | 'plannedFinish' | 'plannedHandover') =>
    editable ? (
      <input type="date" className="w-32 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs hover:border-slate-200 focus:border-navy focus:outline-none"
        value={isoDay(a[field])} onChange={(e) => onSave({ [field]: e.target.value || null })} />
    ) : (
      <span className="text-slate-600">{sheetDate(a[field])}</span>
    );

  return (
    <tr className={`border-b border-slate-100 last:border-0 ${a.targetMissing ? 'bg-red-50/30' : 'hover:bg-slate-50'}`}>
      <td className="px-2.5 py-1.5 text-slate-400">{index}</td>
      <td className="whitespace-nowrap px-2.5 py-1.5 text-xs font-medium text-slate-600">{a.category}</td>
      <td className="px-2.5 py-1.5 text-slate-700">
        {a.activity}
        {a.adjustedQty !== 0 && (
          <span className="ml-1.5 text-amber-500" title={`${a.adjustedQty > 0 ? '+' : ''}${a.adjustedQty} ${a.uom} came from an opening balance or adjustment, not the daily log`}>◆</span>
        )}
      </td>
      <td className="px-2.5 py-1.5 text-xs text-slate-500">{a.uom}</td>
      <td className="px-2.5 py-1.5 text-right">
        {editable ? (
          <input
            className={`w-20 rounded border px-1.5 py-0.5 text-right text-sm focus:border-navy focus:outline-none ${
              a.targetMissing ? 'border-red-200 bg-red-50' : 'border-transparent bg-transparent hover:border-slate-200'
            }`}
            value={target}
            placeholder="—"
            onChange={(e) => setTarget(e.target.value)}
            onBlur={commitTarget}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className={a.targetMissing ? 'text-red-400' : 'text-slate-700'}>{numOrDash(a.targetQty)}</span>
        )}
      </td>
      <td className="px-2.5 py-1.5">{dateCell('plannedStart')}</td>
      <td className="px-2.5 py-1.5">{dateCell('plannedFinish')}</td>
      <td className="px-2.5 py-1.5">{dateCell('plannedHandover')}</td>
      <td className="px-2.5 py-1.5 text-right font-semibold text-slate-800">{numOrDash(a.cumQty)}</td>
      <td className="px-2.5 py-1.5"><Pct value={a.pctComplete} missing={a.targetMissing} /></td>
      <td className="px-2.5 py-1.5 text-right text-slate-600">{numOrDash(a.balanceQty)}</td>
      <td className="whitespace-nowrap px-2.5 py-1.5 text-xs text-slate-500">{sheetDate(a.lastUpdated)}</td>
      <td className="px-2.5 py-1.5"><StatusPill status={a.status} /></td>
    </tr>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-0.5 font-semibold text-navy ${big ? 'text-xl' : 'text-sm'}`}>{value}</div>
    </div>
  );
}
