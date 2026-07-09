import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, projectStatusPill } from '../lib/format';
import { Modal, ProgressBar, RiskBadge, Spinner, EmptyState } from '../components/ui';
import ProjectEditModal from '../components/ProjectEditModal';

interface ProjectCard {
  id: string;
  name: string;
  clientName?: string;
  siteLocation?: string;
  status: string;
  startDate?: string | null;
  officialStartDate?: string | null;
  targetCompletionDate?: string;
  completionPct: number;
  estimatedCompletionDate?: string | null;
  boqLocked: boolean;
  counts: { boqItems: number; entries: number; members: number };
  delayRisk: { level: string; message: string };
  daysRemaining: number | null;
  timelinePct: number | null;
  pendingDrawingApproval: boolean;
  drawingApprovalLabel: string;
  stats: { completed: number; inProgress: number; notStarted: number };
  gantt: { total: number; delayed: number; worstDelay: number };
}

// Sort options for the multi-project dashboard (Sprint PRD §10.1). The server
// already returns the list ordered by delay severity — the default here matches
// it, so "Delay severity" is a no-op re-sort rather than a second ordering.
const SORTS = {
  delay: { label: 'Delay severity', fn: (a: ProjectCard, b: ProjectCard) => severity(b) - severity(a) || b.gantt.worstDelay - a.gantt.worstDelay },
  updated: { label: 'Last updated', fn: () => 0 },
  complete: { label: '% complete', fn: (a: ProjectCard, b: ProjectCard) => b.completionPct - a.completionPct },
  target: { label: 'Target date', fn: (a: ProjectCard, b: ProjectCard) => (a.targetCompletionDate ?? '9999').localeCompare(b.targetCompletionDate ?? '9999') },
} as const;
type SortKey = keyof typeof SORTS;

const severity = (p: ProjectCard) => (p.delayRisk.level === 'DELAYED' ? 2 : p.delayRisk.level === 'AT_RISK' ? 1 : 0);

export default function ProjectsList() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [sort, setSort] = useState<SortKey>('delay');

  const { data, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await api.get('/projects')).data.projects as ProjectCard[],
  });
  // The server's order is the "last updated" order; every other sort is derived.
  const projects = data ? [...data].sort(SORTS[sort].fn) : undefined;

  // Documents awaiting the signed-in user's approval (surfaced on the home page).
  const { data: myApprovals } = useQuery({
    queryKey: ['approvals-mine'],
    queryFn: async () => (await api.get('/approvals/mine')).data.items as any[],
    refetchInterval: 30_000,
  });
  const pendingCount = myApprovals?.length ?? 0;

  return (
    <div>
      {pendingCount > 0 && (
        <Link to="/approvals" className="mb-4 flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 hover:bg-amber-100">
          <span className="text-sm font-medium text-amber-800">
            🔔 You have {pendingCount} document{pendingCount > 1 ? 's' : ''} awaiting your approval.
          </span>
          <span className="text-sm font-semibold text-amber-800">Review →</span>
        </Link>
      )}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Projects</h1>
          <p className="text-sm text-slate-500">Cold room construction projects you can access.</p>
        </div>
        <div className="flex items-center gap-2">
          {!!data?.length && (
            <label className="flex items-center gap-1 text-xs text-slate-500">
              Sort by
              <select className="input py-1 text-xs" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
          )}
          {user?.role === 'ADMIN' && (
            <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New Project</button>
          )}
        </div>
      </div>

      {isLoading ? (
        <Spinner label="Loading projects…" />
      ) : !projects?.length ? (
        <EmptyState
          title="No projects yet"
          hint={user?.role === 'ADMIN' ? 'Create your first project to upload a BOQ and start tracking.' : 'Ask an admin to add you to a project.'}
          action={user?.role === 'ADMIN' ? <button className="btn-primary mt-2" onClick={() => setShowCreate(true)}>+ New Project</button> : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => <ProjectCardTile key={p.id} p={p} />)}
        </div>
      )}

      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={() => { qc.invalidateQueries({ queryKey: ['projects'] }); setShowCreate(false); }} />}
    </div>
  );
}

function ProjectCardTile({ p }: { p: ProjectCard }) {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const overdue = p.daysRemaining != null && p.daysRemaining < 0;
  const daysLabel = p.daysRemaining == null
    ? 'No target date'
    : overdue ? `${Math.abs(p.daysRemaining)} days overdue` : `${p.daysRemaining} days remaining`;
  // Admins may fix up any detail left blank at creation, straight from the card.
  const canEdit = user?.role === 'ADMIN';

  return (
    <>
    <Link to={`/projects/${p.id}`} className="card block p-5 transition hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-navy">{p.name}</h3>
          <div className="truncate text-sm text-slate-500">{p.clientName || '—'}</div>
          {p.siteLocation && <div className="truncate text-xs text-slate-400">{p.siteLocation}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {canEdit && (
            <button
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-navy"
              title="Edit project details"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(true); }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
            </button>
          )}
          <span className={`badge ${projectStatusPill(p.status)}`}>{p.status}</span>
        </div>
      </div>

      {/* The project hasn't officially started until every drawing is approved. */}
      {p.pendingDrawingApproval && (
        <div className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">{p.drawingApprovalLabel}</div>
      )}

      <div className="mt-4 flex items-end justify-between">
        <div className="text-3xl font-bold text-navy">{p.completionPct}%</div>
        <div className="text-right">
          <RiskBadge level={p.delayRisk.level} />
          {p.gantt.delayed > 0 && <div className="mt-0.5 text-[11px] text-red-600">{p.gantt.delayed} delayed · worst {p.gantt.worstDelay}d</div>}
        </div>
      </div>
      <div className="mt-2"><ProgressBar pct={p.completionPct} /></div>

      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs text-slate-500">
        <div><div className="text-sm font-semibold text-green-600">{p.stats.completed}</div>completed</div>
        <div><div className="text-sm font-semibold text-blue-600">{p.stats.inProgress}</div>in progress</div>
        <div><div className="text-sm font-semibold text-slate-400">{p.stats.notStarted}</div>not started</div>
      </div>

      {/* Timeline mini-bar: how far through the planned calendar we are, with a
          marker for actual completion so schedule vs progress is visible at a glance. */}
      {p.timelinePct != null && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[10px] uppercase tracking-wide text-slate-400">
            <span>Timeline</span><span>{p.timelinePct}% elapsed</span>
          </div>
          <div className="relative h-2 w-full rounded-full bg-slate-200">
            <div className="h-2 rounded-full bg-slate-400" style={{ width: `${p.timelinePct}%` }} />
            <div className="absolute -top-0.5 h-3 w-0.5 bg-navy" style={{ left: `${Math.min(p.completionPct, 100)}%` }} title={`${p.completionPct}% of work complete`} />
          </div>
        </div>
      )}

      <div className="mt-3 border-t border-slate-100 pt-2 text-xs">
        <div className="text-slate-500">Start: {fmtDate(p.startDate)} · Target: {fmtDate(p.targetCompletionDate)} · Est: {fmtDate(p.estimatedCompletionDate)}</div>
        <div className={overdue ? 'font-medium text-red-600' : 'text-slate-400'}>{daysLabel}</div>
      </div>
    </Link>
    {editing && <ProjectEditModal project={p} onClose={() => setEditing(false)} />}
    </>
  );
}

function CreateProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', clientName: '', siteLocation: '', startDate: '', targetCompletionDate: '' });
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { name: form.name, clientName: form.clientName, siteLocation: form.siteLocation };
      if (form.startDate) payload.startDate = form.startDate;
      if (form.targetCompletionDate) payload.targetCompletionDate = form.targetCompletionDate;
      return (await api.post('/projects', payload)).data;
    },
    onSuccess: onCreated,
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <Modal title="New Project" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }} className="space-y-3">
        <div><label className="label">Project name *</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Client name</label><input className="input" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} /></div>
          <div><label className="label">Site location</label><input className="input" value={form.siteLocation} onChange={(e) => setForm({ ...form, siteLocation: e.target.value })} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Start date</label><input className="input" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></div>
          <div><label className="label">Target completion</label><input className="input" type="date" value={form.targetCompletionDate} onChange={(e) => setForm({ ...form, targetCompletionDate: e.target.value })} /></div>
        </div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Creating…' : 'Create Project'}</button>
        </div>
      </form>
    </Modal>
  );
}
