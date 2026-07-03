import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { PageKey } from '../lib/permissions';
import { Spinner } from '../components/ui';
import { fmtDate, riskPill, projectStatusPill, titleize } from '../lib/format';
import DashboardTab from '../components/tabs/DashboardTab';
import BOQTab from '../components/tabs/BOQTab';
import DrawingTab from '../components/tabs/DrawingTab';
import GanttTab from '../components/tabs/GanttTab';
import ChangeOrdersTab from '../components/tabs/ChangeOrdersTab';
import TeamTab from '../components/tabs/TeamTab';
import PaymentDashboard from '../components/procurement/PaymentDashboard';
import DocList from '../components/procurement/DocList';
import GRNView from '../components/procurement/GRNView';
import VendorsView from '../components/procurement/VendorsView';
import DocumentsView from '../components/procurement/DocumentsView';

export interface WorkspaceData {
  project: {
    id: string; name: string; clientName?: string; siteLocation?: string;
    status: string; startDate?: string; targetCompletionDate?: string; boqLocked: boolean;
    members: { id: string; role: string; user: { id: string; name: string; email: string; role: string } }[];
  };
  progress: { completionPct: number; estimatedCompletionDate?: string | null };
  risk: { level: string; message: string };
  role: string;
}

type Item = { key: PageKey; label: string; icon: keyof typeof ICONS };
const MENU: { group: string; items: Item[] }[] = [
  { group: 'Project', items: [
    { key: 'dashboard', label: 'Dashboard', icon: 'grid' },
    { key: 'boq', label: 'BOQ & Progress', icon: 'list' },
    { key: 'drawing', label: 'Drawing & 3D', icon: 'cube' },
    { key: 'gantt', label: 'Gantt / Timeline', icon: 'list' },
    { key: 'changeorders', label: 'Change Orders', icon: 'doc' },
  ] },
  // Ordered + numbered to follow the real procurement workflow:
  // register vendor → raise PO/WO → receive goods → release payment → archive.
  { group: 'Procurement (workflow order)', items: [
    { key: 'vendors', label: '1. Vendors', icon: 'users' },
    { key: 'po', label: '2. Purchase Orders', icon: 'doc' },
    { key: 'wo', label: '3. Work Orders', icon: 'wrench' },
    { key: 'grn', label: '4. Goods Receipt (GRN)', icon: 'truck' },
    { key: 'pay', label: '5. Payment Pipeline', icon: 'wallet' },
    { key: 'documents', label: '6. Documents', icon: 'folder' },
  ] },
  { group: 'Team', items: [
    { key: 'team', label: 'Team', icon: 'people' },
  ] },
];

export default function ProjectWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const { canView } = useAuth();
  const [active, setActive] = useState<PageKey | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}`)).data as WorkspaceData,
  });

  if (isLoading) return <Spinner label="Loading project…" />;
  if (error || !data) return <div className="card p-6 text-red-600">Could not load this project.</div>;

  const role = data.role;
  const p = data.project;

  // Only the pages this user is granted (admins see all). Empty groups drop out.
  const menu = MENU
    .map((g) => ({ group: g.group, items: g.items.filter((it) => canView(it.key)) }))
    .filter((g) => g.items.length > 0);
  const visibleKeys = menu.flatMap((g) => g.items.map((it) => it.key));
  const current: PageKey | null = active && visibleKeys.includes(active) ? active : visibleKeys[0] ?? null;

  let daysLabel = '—';
  if (p.targetCompletionDate) {
    const days = Math.ceil((new Date(p.targetCompletionDate).getTime() - Date.now()) / 86400000);
    daysLabel = days >= 0 ? `${days} days left` : `${Math.abs(days)} days over`;
  }

  // Metric bar shown at the top of the content area.
  const metricBar = (
    <div className="card mb-5 flex flex-wrap items-center justify-between gap-4 px-5 py-3">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-bold text-navy">{p.name}</h1>
        <span className={`badge ${projectStatusPill(p.status)}`}>{p.status}</span>
        <span className="hidden text-sm text-slate-400 sm:inline">· {p.siteLocation || '—'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-5 text-sm">
        <Metric label="Completion" value={`${data.progress.completionPct}%`} />
        <Metric label="Target" value={fmtDate(p.targetCompletionDate)} />
        <Metric label="Timeline" value={daysLabel} />
        <div><div className="text-xs uppercase tracking-wide text-slate-400">Delay Risk</div><span className={`badge mt-0.5 ${riskPill(data.risk.level)}`}>{titleize(data.risk.level)}</span></div>
      </div>
    </div>
  );

  if (!current) {
    return (
      <div>
        {metricBar}
        <div className="card p-8 text-center text-slate-500">
          You don’t have access to any pages in this project. Contact an administrator.
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-5">
      {/* Left sidebar menu */}
      <aside className="w-56 shrink-0">
        <div className="card sticky top-20 overflow-hidden p-0">
          <div className="flex items-center gap-2 border-b border-slate-100 p-4">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-navy text-sm font-bold text-white">{p.name.slice(0, 1)}</div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-navy">{p.name}</div>
              <div className="truncate text-xs text-slate-400">{p.clientName || 'Cold Room Project'}</div>
            </div>
          </div>
          <nav className="p-2">
            {menu.map((g) => (
              <div key={g.group} className="mb-1">
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{g.group}</div>
                {g.items.map((it) => {
                  const on = current === it.key;
                  return (
                    <button key={it.key} onClick={() => setActive(it.key)}
                      className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${on ? 'bg-navy/10 text-navy' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
                      <span className={on ? 'text-navy' : 'text-slate-400'}>{ICONS[it.icon]}</span>
                      {it.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </div>
      </aside>

      {/* Main content */}
      <main className="min-w-0 flex-1">
        {metricBar}
        {current === 'dashboard' && <DashboardTab projectId={projectId!} />}
        {current === 'boq' && <BOQTab projectId={projectId!} role={role} locked={p.boqLocked} />}
        {current === 'drawing' && <DrawingTab projectId={projectId!} role={role} />}
        {current === 'gantt' && <GanttTab projectId={projectId!} />}
        {current === 'changeorders' && <ChangeOrdersTab projectId={projectId!} />}
        {current === 'pay' && <PaymentDashboard projectId={projectId!} role={role} />}
        {current === 'po' && <DocList projectId={projectId!} role={role} type="PO" />}
        {current === 'wo' && <DocList projectId={projectId!} role={role} type="WO" />}
        {current === 'grn' && <GRNView projectId={projectId!} role={role} />}
        {current === 'vendors' && <VendorsView projectId={projectId!} role={role} />}
        {current === 'documents' && <DocumentsView projectId={projectId!} role={role} />}
        {current === 'team' && <TeamTab projectId={projectId!} role={role} members={p.members} />}
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-navy">{value}</div>
    </div>
  );
}

// Minimal inline icons (stroke-based, 18px).
const I = (p: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{p ? <path d={p} /> : null}</svg>
);
const ICONS = {
  grid: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  list: I('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'),
  cube: I('M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12'),
  wallet: I('M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M21 12a2 2 0 0 0-2-2h-3a2 2 0 0 0 0 4h3a2 2 0 0 0 2-2z'),
  doc: I('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8'),
  wrench: I('M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z'),
  truck: I('M1 3h15v13H1zM16 8h4l3 3v5h-7M5.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM18.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'),
  users: I('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'),
  folder: I('M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'),
  people: I('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'),
};
