import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, projectStatusPill } from '../lib/format';
import { Modal, ProgressBar, RiskBadge, Spinner, EmptyState } from '../components/ui';

interface ProjectCard {
  id: string;
  name: string;
  clientName?: string;
  siteLocation?: string;
  status: string;
  targetCompletionDate?: string;
  completionPct: number;
  estimatedCompletionDate?: string | null;
  boqLocked: boolean;
  counts: { boqItems: number; entries: number; members: number };
  delayRisk: { level: string; message: string };
}

export default function ProjectsList() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await api.get('/projects')).data.projects as ProjectCard[],
  });

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Projects</h1>
          <p className="text-sm text-slate-500">Cold room construction projects you can access.</p>
        </div>
        {user?.role === 'ADMIN' && (
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ New Project</button>
        )}
      </div>

      {isLoading ? (
        <Spinner label="Loading projects…" />
      ) : !data?.length ? (
        <EmptyState
          title="No projects yet"
          hint={user?.role === 'ADMIN' ? 'Create your first project to upload a BOQ and start tracking.' : 'Ask an admin to add you to a project.'}
          action={user?.role === 'ADMIN' ? <button className="btn-primary mt-2" onClick={() => setShowCreate(true)}>+ New Project</button> : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="card block p-5 transition hover:shadow-md">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-navy">{p.name}</h3>
                <span className={`badge ${projectStatusPill(p.status)}`}>{p.status}</span>
              </div>
              <div className="mt-0.5 text-sm text-slate-500">{p.clientName || '—'}</div>

              <div className="mt-4 flex items-end justify-between">
                <div className="text-3xl font-bold text-navy">{p.completionPct}%</div>
                <RiskBadge level={p.delayRisk.level} />
              </div>
              <div className="mt-2"><ProgressBar pct={p.completionPct} /></div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs text-slate-500">
                <div><div className="text-sm font-semibold text-slate-700">{p.counts.boqItems}</div>BOQ items</div>
                <div><div className="text-sm font-semibold text-slate-700">{p.counts.entries}</div>entries</div>
                <div><div className="text-sm font-semibold text-slate-700">{p.counts.members}</div>members</div>
              </div>
              <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">
                Target: {fmtDate(p.targetCompletionDate)} · Est: {fmtDate(p.estimatedCompletionDate)}
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} onCreated={() => { qc.invalidateQueries({ queryKey: ['projects'] }); setShowCreate(false); }} />}
    </div>
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
