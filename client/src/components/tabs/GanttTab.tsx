import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Modal, Spinner } from '../ui';
import { fmtDate } from '../../lib/format';

const STATUS_COLOR: Record<string, string> = { NOT_STARTED: '#94a3b8', IN_PROGRESS: '#2563eb', COMPLETED: '#16a34a', DELAYED: '#dc2626' };
const DAY = 86400000;

export default function GanttTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canManage = canEdit('gantt');
  const [show, setShow] = useState(false);
  const [upOpen, setUpOpen] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['gantt', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/gantt`)).data });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/projects/${projectId}/gantt/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['gantt', projectId] }), onError: (e) => alert(errMsg(e)) });

  const { activities = [], summary } = data ?? {};
  const range = useMemo(() => {
    if (!activities.length) return null;
    let min = Infinity, max = -Infinity;
    for (const a of activities) { min = Math.min(min, new Date(a.plannedStartDate).getTime()); max = Math.max(max, new Date(a.plannedEndDate).getTime()); }
    const today = Date.now(); min = Math.min(min, today); max = Math.max(max, today);
    const pad = (max - min) * 0.04 || DAY * 2;
    return { min: min - pad, max: max + pad, span: (max - min) + pad * 2 };
  }, [activities]);

  if (isLoading) return <Spinner label="Loading timeline…" />;

  // Date-axis ticks (~8 evenly spaced dates across the timeline span).
  const ticks: { pos: number; label: string }[] = [];
  if (range) {
    const spanDays = range.span / DAY;
    let step = Math.max(1, Math.round(spanDays / 8));
    if (step >= 7) step = Math.round(step / 7) * 7 || 7;
    for (let t = range.min; t <= range.max + 1; t += step * DAY) {
      ticks.push({ pos: ((t - range.min) / range.span) * 100, label: new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-600">Project Timeline (Gantt)</h3>
        {canManage && <div className="flex gap-2"><button className="btn-outline text-sm" onClick={() => setUpOpen(true)}>Upload Excel</button><button className="btn-primary text-sm" onClick={() => setShow(true)}>+ Add Activity</button></div>}
      </div>

      {activities.length === 0 ? (
        <EmptyState title="No timeline yet" hint={canManage ? 'Add activities (with optional BOQ/room links and durations) or upload a schedule Excel. Delays show in red automatically.' : 'No Gantt activities defined yet.'} action={canManage ? <button className="btn-primary mt-2" onClick={() => setShow(true)}>+ Add Activity</button> : undefined} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <KPI label="Activities" value={summary.total} />
            <KPI label="Completed" value={summary.completed} accent="#16a34a" />
            <KPI label="In Progress" value={summary.inProgress} accent="#2563eb" />
            <KPI label="Delayed" value={summary.delayed} accent="#dc2626" sub={summary.worstDelay ? `worst: ${summary.worstDelay}d` : undefined} />
          </div>

          {/* Gantt bars */}
          <div className="card overflow-x-auto p-4">
            <div className="min-w-[640px]">
              {/* Date axis header */}
              <div className="mb-1 flex items-end gap-2 border-b border-slate-200 pb-1">
                <div className="w-52 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Activity</div>
                <div className="relative h-4 flex-1">
                  {ticks.map((t, i) => (
                    <div key={i} className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-slate-500" style={{ left: `${t.pos}%` }}>{t.label}</div>
                  ))}
                </div>
                {canManage && <span className="w-4 shrink-0" />}
              </div>
              {activities.map((a: any) => {
                const s = new Date(a.plannedStartDate).getTime(), e = new Date(a.plannedEndDate).getTime();
                const left = ((s - range!.min) / range!.span) * 100;
                const width = Math.max(((e - s) / range!.span) * 100, 1);
                const todayLeft = ((Date.now() - range!.min) / range!.span) * 100;
                const col = STATUS_COLOR[a.status];
                return (
                  <div key={a.id} className="group flex items-center gap-2 border-b border-slate-50 py-1.5">
                    <div className="w-52 shrink-0 truncate text-xs">
                      <span className="font-medium text-slate-700">{a.activityName}</span>
                      {a.delayDays > 0 && <span className="ml-1 text-red-600">+{a.delayDays}d</span>}
                      <div className="text-[10px] text-slate-400">{fmtDate(a.plannedStartDate)} → {fmtDate(a.plannedEndDate)} · {a.percentComplete}%</div>
                    </div>
                    <div className="relative h-5 flex-1 rounded bg-slate-100">
                      {ticks.map((t, i) => <div key={i} className="absolute top-0 h-full w-px bg-slate-200" style={{ left: `${t.pos}%` }} />)}
                      <div className="absolute top-0 z-10 w-px bg-red-500" style={{ left: `${todayLeft}%`, height: '100%' }} title="Today" />
                      <div className="absolute top-0.5 h-4 rounded" style={{ left: `${left}%`, width: `${width}%`, background: a.status === 'DELAYED' ? '#fecaca' : '#dbeafe' }}>
                        <div className="h-4 rounded" style={{ width: `${Math.min(a.percentComplete, 100)}%`, background: col }} />
                      </div>
                    </div>
                    {canManage && <button className="text-slate-300 opacity-0 hover:text-red-500 group-hover:opacity-100" onClick={() => del.mutate(a.id)}>✕</button>}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-4 text-[11px] text-slate-400">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: '#2563eb' }} />In progress</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: '#16a34a' }} />Completed</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: '#dc2626' }} />Delayed</span>
              <span><span className="mr-1 inline-block h-3 w-px bg-red-500 align-middle" />Today</span>
            </div>
          </div>
        </>
      )}

      {show && <ActivityModal projectId={projectId} onClose={() => setShow(false)} onDone={() => { setShow(false); qc.invalidateQueries({ queryKey: ['gantt', projectId] }); }} />}
      {upOpen && <UploadModal projectId={projectId} onClose={() => setUpOpen(false)} onDone={() => { setUpOpen(false); qc.invalidateQueries({ queryKey: ['gantt', projectId] }); }} />}
    </div>
  );
}

function ActivityModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  // Same queryKey + shape as BOQTab so the React Query cache isn't corrupted
  // (BOQTab caches the full { items, locked, categories } object).
  const boqQ = useQuery({ queryKey: ['boq', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data });
  const boqItems: any[] = boqQ.data?.items ?? [];
  const [f, setF] = useState<any>({ activityName: '', boqItemId: '', plannedStartDate: new Date().toISOString().slice(0, 10), plannedDurationDays: 7, assignedVendor: '' });
  const [err, setErr] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/projects/${projectId}/gantt`, { ...f, boqItemId: f.boqItemId || null, percentCompleteAuto: !!f.boqItemId }), onSuccess: onDone, onError: (e) => setErr(errMsg(e)) });
  return (
    <Modal title="Add Gantt Activity" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="space-y-3">
        <div><label className="label">Activity name *</label><input className="input" required value={f.activityName} onChange={(e) => setF({ ...f, activityName: e.target.value })} /></div>
        <div><label className="label">Link to BOQ item (auto % from progress)</label><select className="input" value={f.boqItemId} onChange={(e) => setF({ ...f, boqItemId: e.target.value })}><option value="">— none (manual %) —</option>{boqItems.filter((i) => !i.isGroup).map((i) => <option key={i.id} value={i.id}>{(i.description || '').slice(0, 60)}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Start date *</label><input className="input" type="date" required value={f.plannedStartDate} onChange={(e) => setF({ ...f, plannedStartDate: e.target.value })} /></div>
          <div><label className="label">Duration (days) *</label><input className="input" type="number" min="1" required value={f.plannedDurationDays} onChange={(e) => setF({ ...f, plannedDurationDays: e.target.value })} /></div>
        </div>
        <div><label className="label">Assigned vendor/contractor</label><input className="input" value={f.assignedVendor} onChange={(e) => setF({ ...f, assignedVendor: e.target.value })} /></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2"><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Adding…' : 'Add Activity'}</button></div>
      </form>
    </Modal>
  );
}

function UploadModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [msg, setMsg] = useState('');
  const up = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/gantt/upload`, fd); },
    onSuccess: (r) => { setMsg(`Imported ${r.data.created} activities.${r.data.errors?.length ? ` ${r.data.errors.length} row(s) skipped.` : ''}`); setTimeout(onDone, 1200); },
    onError: (e) => setMsg(errMsg(e)),
  });
  return (
    <Modal title="Upload Schedule Excel" onClose={onClose}>
      <p className="mb-2 text-sm text-slate-500">Columns: <strong>Activity Name, Start Date, End Date (or Duration), % Complete</strong>.</p>
      <input className="input" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} />
      {msg && <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}
    </Modal>
  );
}
