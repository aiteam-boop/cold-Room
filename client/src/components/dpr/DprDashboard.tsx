// The sheet's `Dashboard` tab: four KPIs, the room-wise handover strip, and the
// plant-wide roll-up. Every KPI mirrors a specific cell:
//   Overall Project % = Dashboard!A7      Total Activities   = Dashboard!C7
//   Rooms Ready       = Dashboard!E7      Total Rooms Tracked = Dashboard!G7

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner, EmptyState } from '../ui';
import {
  DprSummary, ModeToggle, Pct, StatusPill, WarningList, DelayCell,
  sheetDate, useDprMode,
} from './shared';

export default function DprDashboard({ projectId, onOpenRoom }: { projectId: string; onOpenRoom?: (zoneId: string) => void }) {
  const [mode, setMode] = useDprMode();
  const { canEdit } = useAuth();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['dpr', projectId, mode],
    queryFn: async () => (await api.get(`/projects/${projectId}/dpr/summary?mode=${mode}`)).data as DprSummary,
  });

  const seed = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/dpr/seed`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dpr'] }),
  });

  if (isLoading) return <Spinner label="Loading DPR…" />;
  if (!data) return <div className="card p-6 text-red-600">Could not load the DPR.</div>;

  if (data.totalActivities === 0) {
    return (
      <EmptyState
        title="This project has no room-wise scope yet"
        hint={`Create the ${7} rooms, the Common / Plant-wide bucket and their 118 activities from the standard cold-room catalogue. Target quantities come later, from the drawing team.`}
        action={
          canEdit('dpr') ? (
            <button className="btn-primary" disabled={seed.isPending} onClick={() => seed.mutate()}>
              {seed.isPending ? 'Creating…' : 'Set up room-wise scope'}
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-navy">Cold Storage Project — DPR Dashboard</h2>
        <div className="flex items-center gap-4">
          <div className="text-xs text-slate-400">Report Date: <span className="font-semibold text-slate-600">{sheetDate(new Date().toISOString())}</span></div>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      </div>

      <WarningList warnings={data.warnings} />

      {/* Dashboard!A7 / C7 / E7 / G7 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="Overall Project %"
          value={`${Math.round(data.overallPct * 100)}%`}
          sub={
            mode === 'sheet' && data.activitiesCounted < data.totalActivities
              ? `averaged over only ${data.activitiesCounted} of ${data.totalActivities}`
              : `over all ${data.totalActivities} activities`
          }
          danger={mode === 'sheet' && data.activitiesCounted < data.totalActivities}
        />
        <Kpi
          label="Total Activities"
          value={String(data.totalActivities)}
          sub={data.totalActivities === data.expectedActivities ? 'complete catalogue' : `expected ${data.expectedActivities}`}
        />
        <Kpi label="Rooms Ready for Handover" value={String(data.roomsReady)} sub={`of ${data.totalRooms}`} />
        <Kpi label="Total Rooms Tracked" value={String(data.totalRooms)} sub="+ 1 plant-wide bucket" />
      </div>

      {/* Room_Handover, rows 5–11 */}
      <div className="card overflow-hidden p-0">
        <div className="border-b border-slate-100 bg-navy px-4 py-2.5 text-sm font-semibold text-white">
          Room-wise Handover Status
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2 font-semibold">Room</th>
                <th className="px-3 py-2 font-semibold">PUF %</th>
                <th className="px-3 py-2 font-semibold">Door %</th>
                <th className="px-3 py-2 font-semibold">Floor %</th>
                <th className="px-3 py-2 font-semibold">Overall %</th>
                <th className="px-3 py-2 font-semibold">Planned Handover</th>
                <th className="px-3 py-2 font-semibold">Actual Handover</th>
                <th className="px-3 py-2 font-semibold">Delay</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((r) => (
                <tr key={r.zoneId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <button className="font-medium text-navy hover:underline" onClick={() => onOpenRoom?.(r.zoneId)}>
                      {r.roomName}
                    </button>
                    {r.staleDays != null && r.staleDays > 7 && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500" title="Days since the last entry in this room">
                        {r.staleDays}d stale
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2"><Pct value={r.categoryPct['PUF Panel'] ?? 0} /></td>
                  <td className="px-3 py-2"><Pct value={r.categoryPct['Door Work'] ?? 0} /></td>
                  <td className="px-3 py-2"><Pct value={r.categoryPct['Floor & Racking'] ?? 0} /></td>
                  <td className="px-3 py-2"><Pct value={r.overallPct} /></td>
                  <td className="px-3 py-2 text-slate-600">{sheetDate(r.plannedHandoverDate)}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {sheetDate(r.actualHandoverDate)}
                    {mode === 'sheet' && r.actualHandoverDate && r.overallPct < 1 && (
                      <span className="ml-1.5 text-red-500" title="Derived from the last completed activity, not a real handover (bug B3)">⚠</span>
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

      {/* Dashboard rows 21–24 */}
      <div className="card overflow-hidden p-0">
        <div className="border-b border-slate-100 bg-navy px-4 py-2.5 text-sm font-semibold text-white">
          Plant-wide Work (Refrigeration / Electrical)
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

function Kpi({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${danger ? 'text-red-600' : 'text-navy'}`}>{value}</div>
      {sub && <div className={`mt-0.5 text-[11px] ${danger ? 'text-red-500' : 'text-slate-400'}`}>{sub}</div>}
    </div>
  );
}
