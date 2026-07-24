import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Modal, Spinner } from '../ui';
import { fmtDate } from '../../lib/format';
import DrawingApprovalPanel, { DrawingApprovalBanner } from '../DrawingApprovalPanel';
import type { DrawingApprovalData } from '../DrawingApprovalPanel';

// Bar colours follow Sprint PRD §3.4. The key correction: a bar is only RED
// when it is genuinely overdue AND has no recorded completion. Work that
// finished on time but late-recorded is GREEN, not red.
const BAR: Record<string, { fill: string; track: string; label: (a: Activity) => string }> = {
  NOT_STARTED: { fill: '#94a3b8', track: '#e2e8f0', label: () => 'Not Started' },
  PAST_DUE_NOT_STARTED: { fill: '#dc2626', track: '#fecaca', label: (a) => `${a.delayDays || a.pastDueDays} days past due` },
  IN_PROGRESS: { fill: '#2563eb', track: '#dbeafe', label: (a) => `${a.percentComplete}% complete` },
  IN_PROGRESS_OVERDUE: { fill: '#2563eb', track: '#fecaca', label: (a) => `${a.delayDays} days delayed` },
  DONE_ON_TIME: { fill: '#16a34a', track: '#bbf7d0', label: (a) => `Done — ${a.actualDurationDays ?? a.tatDays} days` },
  DONE_LATE: { fill: '#eab308', track: '#fef08a', label: (a) => `Done late — ${a.overrunDays} days overrun` },
};
const DAY = 86400000;

interface GanttRemark { at: string; byId: string; byName: string; byEmail: string; text: string }
interface Activity {
  id: string; activityName: string;
  plannedStartDate: string; plannedEndDate: string; plannedDurationDays: number; tatDays: number;
  actualStartDate: string | null; actualEndDate: string | null;
  completedAt: string | null; completionNotes: string | null;
  remarks: GanttRemark[];
  responsibleDisplay: string | null; responsibleUserId: string | null; responsibleName: string | null;
  percentComplete: number; status: string; barState: string;
  delayDays: number; pastDueDays: number; overrunDays: number; actualDurationDays: number | null;
  boqItemId: string | null; assignedVendor: string | null;
}

type CheckpointTarget = { activity: Activity; verb: 'start' | 'complete' };

export default function GanttTab({ projectId, focusId }: { projectId: string; focusId?: string }) {
  const qc = useQueryClient();
  const { canEdit, isAdmin } = useAuth();
  const canManage = canEdit('gantt');
  const [show, setShow] = useState(false);
  const [upOpen, setUpOpen] = useState(false);
  const [checkpoint, setCheckpoint] = useState<CheckpointTarget | null>(null);
  const [remarkFor, setRemarkFor] = useState<Activity | null>(null);
  const [showDrawings, setShowDrawings] = useState(false);
  // Deep-link target: scroll the row into view and ring it so the user lands
  // straight on the task they followed the link for and can act on it.
  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (focusId && focusRef.current) focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [focusId]);

  const { data, isLoading } = useQuery({ queryKey: ['gantt', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/gantt`)).data });
  const refresh = () => qc.invalidateQueries({ queryKey: ['gantt', projectId] });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/projects/${projectId}/gantt/${id}`), onSuccess: refresh, onError: (e) => alert(errMsg(e)) });
  const revert = useMutation({
    mutationFn: (v: { id: string; reason: string }) => api.post(`/projects/${projectId}/gantt/${v.id}/revert`, { reason: v.reason }),
    onSuccess: refresh, onError: (e) => alert(errMsg(e)),
  });
  const applyTemplate = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/gantt/apply-template`),
    onSuccess: (r) => { refresh(); alert(`Added ${r.data.created} standard activities${r.data.skipped ? `, skipped ${r.data.skipped} already present` : ''}.`); },
    onError: (e) => alert(errMsg(e)),
  });
  // Reassign a task to a real project member so it carries a person (and, via the
  // API, their employeeCode) — turning a role-only programme task into an
  // owned one. Picking a person clears the free-text role label.
  const assign = useMutation({
    mutationFn: (v: { id: string; responsibleUserId: string | null; responsibleName: string | null }) =>
      api.patch(`/projects/${projectId}/gantt/${v.id}`, { responsibleUserId: v.responsibleUserId, responsibleName: v.responsibleName }),
    onSuccess: refresh, onError: (e) => alert(errMsg(e)),
  });
  // Project team members feed the per-row "assign person" dropdown.
  const projectQ = useQuery({ queryKey: ['project', projectId], queryFn: async () => (await api.get(`/projects/${projectId}`)).data });
  const members: { user: { id: string; name: string } }[] = projectQ.data?.project?.members ?? [];

  const { activities = [], summary } = (data ?? {}) as { activities: Activity[]; summary: any };
  const drawing = data?.drawingApproval as DrawingApprovalData | undefined;

  const range = useMemo(() => {
    if (!activities.length) return null;
    let min = Infinity, max = -Infinity;
    for (const a of activities) {
      min = Math.min(min, new Date(a.plannedStartDate).getTime());
      max = Math.max(max, new Date(a.plannedEndDate).getTime(), a.actualEndDate ? new Date(a.actualEndDate).getTime() : -Infinity);
    }
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

  const askRevert = (a: Activity) => {
    const reason = window.prompt(`Revert completion of “${a.activityName}”? A reason is required and will be logged.`);
    if (reason?.trim()) revert.mutate({ id: a.id, reason: reason.trim() });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-600">Project Timeline (Gantt)</h3>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-outline text-sm" disabled={applyTemplate.isPending} onClick={() => applyTemplate.mutate()}>Apply Standard Template</button>
            <button className="btn-outline text-sm" onClick={() => setUpOpen(true)}>Upload Excel</button>
            <button className="btn-primary text-sm" onClick={() => setShow(true)}>+ Add Activity</button>
          </div>
        )}
      </div>

      {/* Day 0 of the Gantt. Nothing below it means much until the drawings are in. */}
      {drawing && <DrawingApprovalBanner data={drawing} onOpen={() => setShowDrawings((v) => !v)} />}
      {showDrawings && <DrawingApprovalPanel projectId={projectId} />}

      {activities.length === 0 ? (
        <EmptyState title="No timeline yet" hint={canManage ? 'Apply the standard template to lay out the 10 default activities with their TATs, add activities manually, or upload a schedule Excel.' : 'No Gantt activities defined yet.'} action={canManage ? <button className="btn-primary mt-2" onClick={() => applyTemplate.mutate()}>Apply Standard Template</button> : undefined} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <KPI label="Activities" value={summary.total} />
            <KPI label="Completed" value={summary.completed} accent="#16a34a" />
            <KPI label="In Progress" value={summary.inProgress} accent="#2563eb" />
            <KPI label="Delayed" value={summary.delayed} accent="#dc2626" sub={summary.worstDelay ? `worst: ${summary.worstDelay}d` : undefined} />
          </div>

          <div className="card overflow-x-auto p-4">
            <div className="min-w-[860px]">
              <div className="mb-1 flex items-end gap-2 border-b border-slate-200 pb-1">
                <div className="w-60 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Activity</div>
                <div className="relative h-4 flex-1">
                  {ticks.map((t, i) => (
                    <div key={i} className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] font-medium text-slate-500" style={{ left: `${t.pos}%` }}>{t.label}</div>
                  ))}
                </div>
                <span className="w-44 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Checkpoints</span>
              </div>

              {activities.map((a) => {
                const s = new Date(a.plannedStartDate).getTime(), e = new Date(a.plannedEndDate).getTime();
                const pos = (t: number) => ((t - range!.min) / range!.span) * 100;
                const left = pos(s);
                const width = Math.max(pos(e) - left, 1);
                const todayLeft = pos(Date.now());
                const style = BAR[a.barState] ?? BAR.NOT_STARTED;
                const done = a.barState === 'DONE_ON_TIME' || a.barState === 'DONE_LATE';

                // The overrun tail: how far past the planned end the bar runs. For
                // finished work that is the actual end date; for open work, today.
                const tailEnd = done
                  ? (a.actualEndDate ? pos(new Date(a.actualEndDate).getTime()) : null)
                  : (a.delayDays > 0 ? todayLeft : null);
                const showTail = tailEnd != null && tailEnd > left + width;

                const focused = focusId === a.id;
                return (
                  <div key={a.id} ref={focused ? focusRef : undefined}
                    className={`group flex items-center gap-2 border-b border-slate-50 py-1.5 ${focused ? 'rounded-lg bg-amber-50 ring-2 ring-amber-400' : ''}`}>
                    <div className="w-60 shrink-0 truncate text-xs">
                      <span className="font-medium text-slate-700">{a.activityName}</span>
                      {a.delayDays > 0 && <span className="ml-1 font-semibold text-red-600">+{a.delayDays}d</span>}
                      <div className="text-[10px] text-slate-400">
                        {fmtDate(a.plannedStartDate)} → {fmtDate(a.plannedEndDate)} · {style.label(a)}
                      </div>
                      {canManage ? (
                        <select
                          className={`mt-0.5 w-full rounded border px-1 py-0.5 text-[10px] ${a.responsibleUserId ? 'border-slate-200 text-slate-600' : 'border-amber-200 bg-amber-50 text-amber-700'}`}
                          value={a.responsibleUserId ?? ''}
                          title="Assign this task to a team member (gives it an owner + employee code)"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => { const val = e.target.value; assign.mutate({ id: a.id, responsibleUserId: val || null, responsibleName: val ? null : (a.responsibleName ?? null) }); }}
                        >
                          <option value="">👤 {a.responsibleName || 'Unassigned'} — assign person…</option>
                          {members.map((mm) => <option key={mm.user.id} value={mm.user.id}>{mm.user.name}</option>)}
                        </select>
                      ) : (
                        a.responsibleDisplay && <div className="truncate text-[10px] text-slate-400">👤 {a.responsibleDisplay}</div>
                      )}
                    </div>

                    <div className="relative h-5 flex-1 rounded bg-slate-100" title={`Planned: ${a.tatDays} days${a.responsibleDisplay ? ` | Responsible: ${a.responsibleDisplay}` : ''}`}>
                      {ticks.map((t, i) => <div key={i} className="absolute top-0 h-full w-px bg-slate-200" style={{ left: `${t.pos}%` }} />)}
                      <div className="absolute top-0 z-10 w-px bg-red-500" style={{ left: `${todayLeft}%`, height: '100%' }} title="Today" />
                      {/* Red extension beyond the planned bar (overdue / overrun). */}
                      {showTail && (
                        <div className="absolute top-0.5 h-4 rounded-r" style={{ left: `${left + width}%`, width: `${Math.max(tailEnd! - left - width, 0.4)}%`, background: '#dc2626', opacity: 0.85 }} />
                      )}
                      <div className="absolute top-0.5 h-4 rounded" style={{ left: `${left}%`, width: `${width}%`, background: style.track }}>
                        <div className="h-4 rounded" style={{ width: done ? '100%' : `${Math.min(a.percentComplete, 100)}%`, background: style.fill }} />
                      </div>
                    </div>

                    <div className="flex w-44 shrink-0 items-center justify-end gap-1">
                      {/* Remarks — a progress note log per activity. Anyone can read;
                          editors add. Shows the count so a busy activity stands out. */}
                      <button
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${a.remarks?.length ? 'border-blue-200 text-blue-700 hover:bg-blue-50' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                        title="Progress remarks — status & reason for delay"
                        onClick={() => setRemarkFor(a)}
                      >
                        💬 {a.remarks?.length ? a.remarks.length : ''}Remark
                      </button>
                      {canManage && (
                        <>
                          {!a.actualStartDate && !a.actualEndDate && (
                            <button className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-50" onClick={() => setCheckpoint({ activity: a, verb: 'start' })}>Mark Started</button>
                          )}
                          {!a.actualEndDate && (
                            <button className="rounded border border-green-200 px-1.5 py-0.5 text-[10px] font-medium text-green-700 hover:bg-green-50" onClick={() => setCheckpoint({ activity: a, verb: 'complete' })}>Mark Complete</button>
                          )}
                          {a.actualEndDate && (
                            <span className="text-[10px] text-green-700" title={a.completionNotes || undefined}>✓ {fmtDate(a.actualEndDate)}</span>
                          )}
                          {/* Completion is immutable — only an admin can undo it, with a logged reason. */}
                          {a.actualEndDate && isAdmin && (
                            <button className="text-[10px] text-slate-400 hover:text-amber-600" title="Revert completion (logged)" onClick={() => askRevert(a)}>↺</button>
                          )}
                          <button className="text-slate-300 opacity-0 hover:text-red-500 group-hover:opacity-100" onClick={() => del.mutate(a.id)}>✕</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-slate-400">
              <Legend c="#94a3b8" t="Not started" />
              <Legend c="#2563eb" t="In progress" />
              <Legend c="#16a34a" t="Done on time" />
              <Legend c="#eab308" t="Done late" />
              <Legend c="#dc2626" t="Delayed / past due" />
              <span><span className="mr-1 inline-block h-3 w-px bg-red-500 align-middle" />Today</span>
            </div>
          </div>
        </>
      )}

      {show && <ActivityModal projectId={projectId} onClose={() => setShow(false)} onDone={() => { setShow(false); refresh(); }} />}
      {upOpen && <UploadModal projectId={projectId} onClose={() => setUpOpen(false)} onDone={() => { setUpOpen(false); refresh(); }} />}
      {checkpoint && <CheckpointModal projectId={projectId} target={checkpoint} onClose={() => setCheckpoint(null)} onDone={() => { setCheckpoint(null); refresh(); }} />}
      {remarkFor && <RemarkModal projectId={projectId} activity={remarkFor} canEdit={canManage} isAdmin={isAdmin} onClose={() => setRemarkFor(null)} onChanged={(a) => { setRemarkFor(a); refresh(); }} />}
    </div>
  );
}

function Legend({ c, t }: { c: string; t: string }) {
  return <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: c }} />{t}</span>;
}

// "Mark Started" / "Mark Complete" — a date picker defaulting to today, plus
// optional notes on completion (Sprint PRD §3.3).
function CheckpointModal({ projectId, target, onClose, onDone }: { projectId: string; target: CheckpointTarget; onClose: () => void; onDone: () => void }) {
  const { activity, verb } = target;
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/gantt/${activity.id}/${verb}`, verb === 'complete' ? { date, notes } : { date }),
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });
  const plannedEnd = new Date(activity.plannedEndDate).toISOString().slice(0, 10);
  const late = verb === 'complete' && date > plannedEnd;

  return (
    <Modal title={verb === 'start' ? 'Mark Started' : 'Mark Complete'} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div className="font-medium text-slate-700">{activity.activityName}</div>
          <div className="text-xs text-slate-500">Planned {fmtDate(activity.plannedStartDate)} → {fmtDate(activity.plannedEndDate)} · {activity.tatDays} working days</div>
        </div>
        <div>
          <label className="label">{verb === 'start' ? 'Actual start date' : 'Actual completion date'} *</label>
          <input className="input" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {verb === 'complete' && (
          <>
            {late && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">This is after the planned end date — the bar will show as “Done late”.</div>}
            <div><label className="label">Notes (optional)</label><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Once marked complete this cannot be undone — only an admin can revert it, with a logged reason.</div>
          </>
        )}
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : verb === 'start' ? 'Mark Started' : 'Mark Complete'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Progress-remarks log for one activity: read the timestamped history, add a new
// note (status / why it's late). Anyone sees the log; editors add; author or
// admin can remove a mistaken entry.
function RemarkModal({ projectId, activity, canEdit, isAdmin, onClose, onChanged }: {
  projectId: string; activity: Activity; canEdit: boolean; isAdmin: boolean;
  onClose: () => void; onChanged: (a: Activity) => void;
}) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const remarks = activity.remarks ?? [];

  const add = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/gantt/${activity.id}/remark`, { text: text.trim() }),
    onSuccess: (r) => { setText(''); onChanged(r.data.activity as Activity); },
    onError: (e) => setErr(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: (index: number) => api.delete(`/projects/${projectId}/gantt/${activity.id}/remark/${index}`),
    onSuccess: (r) => onChanged(r.data.activity as Activity),
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <Modal title="Activity Remarks" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div className="font-medium text-slate-700">{activity.activityName}</div>
          <div className="text-xs text-slate-500">
            Planned {fmtDate(activity.plannedStartDate)} → {fmtDate(activity.plannedEndDate)}
            {activity.actualStartDate ? ` · Started ${fmtDate(activity.actualStartDate)}` : ''}
            {activity.delayDays > 0 ? ` · ${activity.delayDays}d late` : ''}
          </div>
        </div>

        {/* History — newest first */}
        {remarks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-sm text-slate-400">No remarks yet.</div>
        ) : (
          <ol className="max-h-64 space-y-1.5 overflow-y-auto">
            {remarks.map((_, i) => i).reverse().map((i) => {
              const r = remarks[i];
              const mine = r.byId === user?.id;
              return (
                <li key={i} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="whitespace-pre-wrap text-sm text-slate-700">{r.text}</div>
                    {(mine || isAdmin) && (
                      <button className="shrink-0 text-xs text-slate-300 hover:text-red-500" title="Remove this remark"
                        onClick={() => { if (confirm('Remove this remark?')) remove.mutate(i); }}>✕</button>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    {r.byName}{r.byEmail ? ` · ${r.byEmail}` : ''} · {new Date(r.at).toLocaleString('en-GB')}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        {canEdit ? (
          <div>
            <label className="label">Add a remark</label>
            <textarea className="input text-sm" rows={2} value={text} onChange={(e) => setText(e.target.value)}
              placeholder="e.g. Panels 60% installed, awaiting doors — running 3 days behind due to late delivery" />
            <div className="mt-1 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">Saved with your name, email &amp; the date-time.</span>
              <button className="btn-primary text-sm" disabled={add.isPending || text.trim().length === 0} onClick={() => { setErr(''); add.mutate(); }}>
                {add.isPending ? 'Saving…' : 'Add remark'}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-400">You have view-only access to the timeline.</div>
        )}
      </div>
    </Modal>
  );
}

function ActivityModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  // Same queryKey + shape as BOQTab so the React Query cache isn't corrupted
  // (BOQTab caches the full { items, locked, categories } object).
  const boqQ = useQuery({ queryKey: ['boq', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data });
  const tplQ = useQuery({ queryKey: ['gantt-template', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/gantt/template`)).data.activities as { activityName: string; tatDays: number; responsibleName: string }[] });
  const projectQ = useQuery({ queryKey: ['project', projectId], queryFn: async () => (await api.get(`/projects/${projectId}`)).data });
  const boqItems: any[] = boqQ.data?.items ?? [];
  const members: { user: { id: string; name: string } }[] = projectQ.data?.project?.members ?? [];

  const [f, setF] = useState<any>({ activityName: '', boqItemId: '', plannedStartDate: new Date().toISOString().slice(0, 10), plannedDurationDays: 7, responsibleUserId: '', responsibleName: '', assignedVendor: '' });
  const [err, setErr] = useState('');

  // Typing a standard activity name pre-fills its TAT + responsible party.
  const applyStandard = (name: string) => {
    const std = tplQ.data?.find((t) => t.activityName.toLowerCase() === name.toLowerCase());
    setF((p: any) => ({ ...p, activityName: name, ...(std && { plannedDurationDays: std.tatDays, responsibleName: std.responsibleName }) }));
  };

  const m = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/gantt`, {
      ...f,
      boqItemId: f.boqItemId || null,
      responsibleUserId: f.responsibleUserId || null,
      responsibleName: f.responsibleName || null,
      percentCompleteAuto: !!f.boqItemId,
    }),
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <Modal title="Add Gantt Activity" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="space-y-3">
        <div>
          <label className="label">Activity name *</label>
          <input className="input" required list="std-activities" value={f.activityName} onChange={(e) => applyStandard(e.target.value)} />
          <datalist id="std-activities">{tplQ.data?.map((t) => <option key={t.activityName} value={t.activityName}>{t.tatDays} working days · {t.responsibleName}</option>)}</datalist>
          <p className="mt-0.5 text-[11px] text-slate-400">Pick a standard activity to pre-fill its TAT and responsible party.</p>
        </div>
        <div><label className="label">Link to BOQ item (auto % from progress)</label><select className="input" value={f.boqItemId} onChange={(e) => setF({ ...f, boqItemId: e.target.value })}><option value="">— none (manual %) —</option>{boqItems.filter((i) => !i.isGroup).map((i) => <option key={i.id} value={i.id}>{(i.description || '').slice(0, 60)}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Start date *</label><input className="input" type="date" required value={f.plannedStartDate} onChange={(e) => setF({ ...f, plannedStartDate: e.target.value })} /></div>
          <div><label className="label">Planned Duration (working days) *</label><input className="input" type="number" min="1" required value={f.plannedDurationDays} onChange={(e) => setF({ ...f, plannedDurationDays: e.target.value })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Responsible person</label>
            <select className="input" value={f.responsibleUserId} onChange={(e) => setF({ ...f, responsibleUserId: e.target.value })}>
              <option value="">— use free text below —</option>
              {members.map((mm) => <option key={mm.user.id} value={mm.user.id}>{mm.user.name}</option>)}
            </select>
          </div>
          <div><label className="label">…or free text</label><input className="input" placeholder="e.g. Kingspan" disabled={!!f.responsibleUserId} value={f.responsibleName} onChange={(e) => setF({ ...f, responsibleName: e.target.value })} /></div>
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
      <p className="mb-2 text-sm text-slate-500">Columns: <strong>Activity Name, Start Date, End Date (or Duration), % Complete</strong> — or a week-marker grid (<strong>Week n(dd-dd Mon)</strong>).</p>
      <input className="input" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} />
      {msg && <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}
    </Modal>
  );
}
