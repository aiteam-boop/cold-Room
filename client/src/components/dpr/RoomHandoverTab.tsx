// The sheet's `Room_Handover` tab — per-room category %, planned vs actual
// handover, delay, and the plant-wide strip.
//
// In Sheet mode the "Actual Handover Date" column is MAXIFS(lastUpdated WHERE
// status="Completed") — the date the last activity happened to finish. That is
// why Ambient reads "handed over 07-Jul-26, 3 days early" while the room is 30%
// built. In Corrected mode the column only ever shows a recorded sign-off.

import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Spinner } from '../ui';
import { DelayCell, DprSummary, ModeToggle, Pct, StatusPill, WarningList, sheetDate, useDprMode } from './shared';

export default function RoomHandoverTab({ projectId, onOpenRoom }: { projectId: string; onOpenRoom?: (zoneId: string) => void }) {
  const [mode, setMode] = useDprMode();
  const { data, isLoading } = useQuery({
    queryKey: ['dpr', projectId, mode],
    queryFn: async () => (await api.get(`/projects/${projectId}/dpr/summary?mode=${mode}`)).data as DprSummary,
  });

  if (isLoading) return <Spinner label="Loading handover tracker…" />;
  if (!data) return <div className="card p-6 text-red-600">Could not load the handover tracker.</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-navy">Room-wise Progress &amp; Handover Tracker</h2>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      <WarningList warnings={data.warnings.filter((w) => ['DERIVED_HANDOVER_DATE', 'MEAN_OF_MEANS', 'STALE_ROOM'].includes(w.code))} />

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-navy text-left text-xs uppercase tracking-wide text-white">
                <th className="px-3 py-2.5 font-semibold">Room</th>
                <th className="px-3 py-2.5 font-semibold">PUF Panel %</th>
                <th className="px-3 py-2.5 font-semibold">Door Work %</th>
                <th className="px-3 py-2.5 font-semibold">Floor &amp; Racking %</th>
                <th className="px-3 py-2.5 font-semibold">Overall Room %</th>
                <th className="px-3 py-2.5 font-semibold">Planned Handover</th>
                <th className="px-3 py-2.5 font-semibold">Actual Handover</th>
                <th className="px-3 py-2.5 font-semibold">Delay (Days)</th>
                <th className="px-3 py-2.5 font-semibold">Handover Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((r) => (
                <tr key={r.zoneId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <button className="font-medium text-navy hover:underline" onClick={() => onOpenRoom?.(r.zoneId)}>{r.roomName}</button>
                  </td>
                  <td className="px-3 py-2"><Pct value={r.categoryPct['PUF Panel'] ?? 0} /></td>
                  <td className="px-3 py-2"><Pct value={r.categoryPct['Door Work'] ?? 0} /></td>
                  <td className="px-3 py-2"><Pct value={r.categoryPct['Floor & Racking'] ?? 0} /></td>
                  <td className="px-3 py-2"><Pct value={r.overallPct} /></td>
                  <td className="px-3 py-2 text-slate-600">{sheetDate(r.plannedHandoverDate)}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {sheetDate(r.actualHandoverDate)}
                    {mode === 'sheet' && r.actualHandoverDate && r.overallPct < 1 && (
                      <span className="ml-1.5 cursor-help text-red-500"
                        title="Derived from the last completed activity, not a real handover. Switch to Corrected mode.">⚠</span>
                    )}
                  </td>
                  <td className="px-3 py-2"><DelayCell days={r.delayDays} /></td>
                  <td className="px-3 py-2"><StatusPill status={r.handoverStatus} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        <div className="border-b border-slate-100 bg-navy px-4 py-2.5 text-sm font-semibold text-white">
          Plant-wide Work (Refrigeration / Electrical / Handover)
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-semibold">Category</th>
              <th className="px-3 py-2 font-semibold">% Complete</th>
              <th className="px-3 py-2 font-semibold">Last Updated</th>
              <th className="px-3 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.plantWide.map((p) => (
              <tr key={p.category} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2 font-medium text-slate-700">{p.category}</td>
                <td className="px-3 py-2"><Pct value={p.pct} /></td>
                <td className="px-3 py-2 text-slate-600">{sheetDate(p.lastUpdated)}</td>
                <td className="px-3 py-2"><StatusPill status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
