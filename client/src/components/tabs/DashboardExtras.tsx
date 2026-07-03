import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { COLOR_HEX, fmtDate } from '../../lib/format';

// NEW dashboard cards (additive — rendered below the existing dashboard):
// Room-wise progress (F3), Gantt/timeline summary (F4), Change Orders (F5).
export default function DashboardExtras({ projectId }: { projectId: string }) {
  const rooms = useQuery({ queryKey: ['room-progress', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/dashboard/room-progress`)).data.rooms as any[] });
  const gantt = useQuery({ queryKey: ['gantt', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/gantt`)).data });
  const cos = useQuery({ queryKey: ['change-orders', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/change-orders`)).data.orders as any[] });

  const g = gantt.data?.summary;
  const orders = cos.data ?? [];
  const openCo = orders.filter((o: any) => o.status === 'PENDING' || o.status === 'DRAFT').length;
  const approvedImpact = orders.filter((o: any) => o.status === 'APPROVED').reduce((s: number, o: any) => s + (o.costImpact || 0), 0);
  const roomList = (rooms.data ?? []).filter((r) => r.itemCount > 0);

  return (
    <div className="space-y-5">
      {/* Timeline + Change Orders summary */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-5">
          <div className="mb-2 text-sm font-medium text-slate-600">Timeline (Gantt)</div>
          {!g || g.total === 0 ? <div className="text-sm text-slate-400">No timeline activities yet. Add them in the Gantt / Timeline page.</div> : (
            <div className="grid grid-cols-4 gap-2 text-center">
              <Stat n={g.total} l="Activities" />
              <Stat n={g.completed} l="Done" c="#16a34a" />
              <Stat n={g.inProgress} l="Active" c="#2563eb" />
              <Stat n={g.delayed} l="Delayed" c="#dc2626" sub={g.worstDelay ? `worst ${g.worstDelay}d` : ''} />
            </div>
          )}
          {g?.projectTarget && <div className="mt-3 text-xs text-slate-400">Target completion: {fmtDate(g.projectTarget)}</div>}
        </div>
        <div className="card p-5">
          <div className="mb-2 text-sm font-medium text-slate-600">Change Orders</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat n={orders.length} l="Total" />
            <Stat n={openCo} l="Open" c="#d97706" />
            <Stat n={`₹${approvedImpact.toLocaleString('en-IN')}`} l="Approved impact" c="#0f2942" />
          </div>
        </div>
      </div>

      {/* Room-wise progress */}
      {roomList.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-slate-600">Room-wise Progress</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {roomList.map((r) => (
              <div key={r.zoneId} className="card p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold text-navy">{r.roomName}</div>
                    {r.temperatureRange && <div className="text-xs text-slate-400">{r.temperatureRange}</div>}
                  </div>
                  <span className="h-3 w-3 rounded-full" style={{ background: COLOR_HEX[r.colorStatus as keyof typeof COLOR_HEX] }} />
                </div>
                <div className="mt-2 flex items-end justify-between">
                  <div className="text-2xl font-bold" style={{ color: COLOR_HEX[r.colorStatus as keyof typeof COLOR_HEX] }}>{r.completionPct}%</div>
                  <div className="text-xs text-slate-400">{r.itemCount} items</div>
                </div>
                <div className="mt-1 h-2 w-full rounded-full bg-slate-200"><div className="h-2 rounded-full" style={{ width: `${Math.min(r.completionPct, 100)}%`, background: COLOR_HEX[r.colorStatus as keyof typeof COLOR_HEX] }} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ n, l, c, sub }: { n: any; l: string; c?: string; sub?: string }) {
  return <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold" style={{ color: c ?? '#0f2942' }}>{n}</div><div className="text-[11px] text-slate-400">{l}{sub ? ` · ${sub}` : ''}</div></div>;
}
