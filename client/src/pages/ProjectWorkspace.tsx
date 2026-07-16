import { useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { PageKey } from '../lib/permissions';
import { Spinner } from '../components/ui';
import { fmtDate, riskPill, projectStatusPill, titleize } from '../lib/format';
import DashboardTab from '../components/tabs/DashboardTab';
import BOQTab from '../components/tabs/BOQTab';
import BudgetView from '../components/tabs/BudgetView';
import DrawingTab from '../components/tabs/DrawingTab';
import GanttTab from '../components/tabs/GanttTab';
import ChangeOrdersTab from '../components/tabs/ChangeOrdersTab';
import TeamTab from '../components/tabs/TeamTab';
import PaymentDashboard from '../components/procurement/PaymentDashboard';
import DocList from '../components/procurement/DocList';
import GRNView from '../components/procurement/GRNView';
import VendorsView from '../components/procurement/VendorsView';
import DocumentsView from '../components/procurement/DocumentsView';
import ReportsTab from '../components/tabs/ReportsTab';
import FMSView from '../components/procurement/FMSView';
import DprDashboard from '../components/dpr/DprDashboard';
import DailyEntryTab from '../components/dpr/DailyEntryTab';
import RoomSheet from '../components/dpr/RoomSheet';
import RoomHandoverTab from '../components/dpr/RoomHandoverTab';
import MilestonesTab from '../components/dpr/MilestonesTab';
import type { DprSummary } from '../components/dpr/shared';

export interface WorkspaceData {
  project: {
    id: string; name: string; clientName?: string; siteLocation?: string;
    status: string; startDate?: string; targetCompletionDate?: string; boqLocked: boolean;
    officialStartDate?: string | null;
    members: { id: string; role: string; user: { id: string; name: string; email: string; role: string } }[];
  };
  progress: { completionPct: number; estimatedCompletionDate?: string | null };
  risk: { level: string; message: string };
  role: string;
  drawingApproval: { allApproved: boolean; label: string; officialStartDate: string | null; worstDelayDays: number };
}

// `view` distinguishes the tabs that share one PageKey — the whole room-wise DPR
// module is gated by the single 'dpr' grant but renders as one sidebar entry per
// tab of the original workbook.
type Item = { key: PageKey; label: string; icon: keyof typeof ICONS; view?: string };
type Nav = { key: PageKey; view?: string };
const navId = (n: Nav) => (n.view ? `${n.key}:${n.view}` : n.key);

const MENU: { group: string; items: Item[] }[] = [
  { group: 'Project', items: [
    { key: 'dashboard', label: 'Dashboard', icon: 'grid' },
    { key: 'boq', label: 'BOQ & Progress', icon: 'list' },
    // The internal costing, beside the BOQ. It IS pricing, so it is hidden from
    // anyone with hideFinancials (filtered below) — never shown to a vendor.
    { key: 'boq', label: 'BOQ & Budget', icon: 'wallet', view: 'budget' },
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
    { key: 'fms', label: '6. FMS — Vendor Payments', icon: 'wallet' },
    { key: 'documents', label: '7. Documents', icon: 'folder' },
    // The registers above stay flat; the PO → GRN → invoice → payment drill-down
    // and vendor outstanding live here (transcript R14/R15).
    { key: 'reports', label: '8. Reports & Registers', icon: 'chart' },
  ] },
  { group: 'Team', items: [
    { key: 'team', label: 'Team', icon: 'people' },
  ] },
];

export default function ProjectWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const { canView, isDprOwner, hideFinancials, can } = useAuth();
  // The room-wise DPR is the owner's personal cockpit — shown only to the DPR
  // owner account(s), NOT every admin and never via the 'dpr' grant.
  const showDpr = isDprOwner;

  // Deep link support: a `?open=<entity>:<id>` param (set by the /go resolver)
  // lands the user straight on the item's tab with that item opened/highlighted.
  const [searchParams] = useSearchParams();
  const deep = useMemo(() => {
    const raw = searchParams.get('open');
    if (!raw) return null;
    const idx = raw.indexOf(':');
    if (idx < 0) return null;
    const entity = raw.slice(0, idx);
    const id = raw.slice(idx + 1);
    const KEY: Record<string, PageKey> = { po: 'po', wo: 'wo', grn: 'grn', payment: 'fms', task: 'gantt', boq: 'boq' };
    const key = KEY[entity];
    if (!key || !id) return null;
    return { key, id };
  }, [searchParams]);

  const [active, setActive] = useState<Nav | null>(deep ? { key: deep.key } : null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}`)).data as WorkspaceData,
  });

  // The DPR sidebar mirrors the workbook's tab strip, so it needs the real room
  // list. Sheet mode is used purely to enumerate rooms — no numbers are read here.
  const { data: dpr } = useQuery({
    queryKey: ['dpr', projectId, 'sheet'],
    queryFn: async () => (await api.get(`/projects/${projectId}/dpr/summary?mode=sheet`)).data as DprSummary,
    enabled: showDpr,
  });

  if (isLoading) return <Spinner label="Loading project…" />;
  if (error || !data) return <div className="card p-6 text-red-600">Could not load this project.</div>;

  const role = data.role;
  const p = data.project;

  // One sidebar entry per tab of DPR_Cold_Storage_RoomWise.xlsx, in sheet order.
  // Before the scope is seeded there are no rooms, so a single entry lands the
  // user on the dashboard's set-up screen.
  const dprItems: Item[] = showDpr
    ? [
        { key: 'dpr' as PageKey, label: 'Dashboard', icon: 'grid', view: 'dashboard' },
        { key: 'dpr' as PageKey, label: 'Daily Entry', icon: 'pencil', view: 'entry' },
        ...(dpr?.rooms ?? []).map((r): Item => ({ key: 'dpr' as PageKey, label: r.roomName, icon: 'room', view: `room:${r.zoneId}` })),
        ...(dpr?.common ? [{ key: 'dpr' as PageKey, label: 'Common Works', icon: 'wrench' as const, view: `room:${dpr.common.zoneId}` }] : []),
        ...(dpr?.rooms.length ? [
          { key: 'dpr' as PageKey, label: 'Room Handover', icon: 'people' as const, view: 'handover' },
          { key: 'dpr' as PageKey, label: 'Milestones', icon: 'flag' as const, view: 'milestones' },
        ] : []),
      ]
    : [];

  const fullMenu = [...MENU, ...(dprItems.length ? [{ group: 'DPR (Room-wise)', items: dprItems }] : [])];

  // A budget capability (enter or freeze) IS the grant for the BOQ & Budget page —
  // you can't cost a budget you can't see — so it shows even without the boq page
  // grant or despite hideFinancials. Otherwise it needs boq view + visible pricing.
  const canBudget = can('canEditBudget') || can('canFreezeBudget');
  const canSeeBudget = canBudget || (canView('boq') && !hideFinancials);

  // Only the pages this user is granted (admins see all). Empty groups drop out.
  const menu = fullMenu
    .map((g) => ({ group: g.group, items: g.items.filter((it) => (it.view === 'budget' ? canSeeBudget : canView(it.key))) }))
    .filter((g) => g.items.length > 0);
  const allNavs: Nav[] = menu.flatMap((g) => g.items.map((it) => ({ key: it.key, view: it.view })));
  const visibleIds = new Set(allNavs.map(navId));
  const current: Nav | null = active && visibleIds.has(navId(active)) ? active : allNavs[0] ?? null;

  // Only feed a deep-link focus to the tab that is actually showing it.
  const focusFor = (k: PageKey) => (deep && deep.key === k && current?.key === k ? deep.id : undefined);

  const openRoom = (zoneId: string) => setActive({ key: 'dpr', view: `room:${zoneId}` });

  let daysLabel = '—';
  if (p.targetCompletionDate) {
    const days = Math.ceil((new Date(p.targetCompletionDate).getTime() - Date.now()) / 86400000);
    daysLabel = days >= 0 ? `${days} days left` : `${Math.abs(days)} days over`;
  }

  // Metric bar shown at the top of the content area. The project's official
  // start date is the drawing-approval date — before that it reads "pending"
  // in orange, wherever the start date is shown (Sprint PRD §2.3).
  const dwg = data.drawingApproval;
  const metricBar = (
    <div className="card mb-5 space-y-2 px-5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-bold text-navy">{p.name}</h1>
          <span className={`badge ${projectStatusPill(p.status)}`}>{p.status}</span>
          <span className="hidden text-sm text-slate-400 sm:inline">· {p.siteLocation || '—'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-5 text-sm">
          <Metric label="Completion" value={`${data.progress.completionPct}%`} />
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-400">Project Start</div>
            <div className={`mt-0.5 text-sm font-semibold ${dwg?.allApproved ? 'text-navy' : 'text-amber-600'}`}>
              {dwg?.allApproved ? fmtDate(dwg.officialStartDate) : 'Pending drawings'}
            </div>
          </div>
          <Metric label="Target" value={fmtDate(p.targetCompletionDate)} />
          <Metric label="Timeline" value={daysLabel} />
          <div><div className="text-xs uppercase tracking-wide text-slate-400">Delay Risk</div><span className={`badge mt-0.5 ${riskPill(data.risk.level)}`}>{titleize(data.risk.level)}</span></div>
        </div>
      </div>
      {dwg && !dwg.allApproved && (
        <div className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
          {dwg.label}
          {dwg.worstDelayDays > 0 && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-red-700">Drawing Approval — {dwg.worstDelayDays} days delayed</span>}
        </div>
      )}
    </div>
  );

  if (!current) {
    // No rail here (there are no pages to list), so this branch supplies the page
    // padding the workspace <main> normally owns.
    return (
      <div className="px-5 py-6 lg:px-6">
        {metricBar}
        <div className="card p-8 text-center text-slate-500">
          You don’t have access to any pages in this project. Contact an administrator.
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Left rail — FIXED to the viewport, not to the page flow.
          `fixed left-0 top-14` anchors it to the screen's left edge, directly
          under the 56px header, so it is completely independent of the page's
          centred container and cannot drift sideways when the browser is zoomed
          or the window resized. It scrolls inside itself (overflow-y-auto) rather
          than with the page, so it stays put while the content scrolls. */}
      <aside className="fixed bottom-0 left-0 top-14 z-30 flex w-60 flex-col overflow-y-auto border-r border-slate-200 bg-white">
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
                const nav: Nav = { key: it.key, view: it.view };
                const on = current != null && navId(current) === navId(nav);
                return (
                  <button key={navId(nav)} onClick={() => setActive(nav)}
                    className={`mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${on ? 'bg-navy/10 text-navy' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}>
                    <span className={`shrink-0 ${on ? 'text-navy' : 'text-slate-400'}`}>{ICONS[it.icon]}</span>
                    <span className="min-w-0 flex-1">{it.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main content — offset by exactly the rail's width (w-60 → pl-60), so it
          fills everything to the right of the rail and never sits under it. */}
      <main className="min-w-0 pl-60">
        <div className="px-5 py-6 lg:px-6">
        {metricBar}
        {current.key === 'dashboard' && <DashboardTab projectId={projectId!} onOpenGantt={canView('gantt') ? () => setActive({ key: 'gantt' }) : undefined} />}
        {current.key === 'boq' && current.view !== 'budget' && <BOQTab projectId={projectId!} role={role} locked={p.boqLocked} />}
        {current.key === 'boq' && current.view === 'budget' && <BudgetView projectId={projectId!} />}
        {current.key === 'drawing' && <DrawingTab projectId={projectId!} role={role} />}
        {current.key === 'gantt' && <GanttTab projectId={projectId!} focusId={focusFor('gantt')} />}
        {current.key === 'changeorders' && <ChangeOrdersTab projectId={projectId!} />}
        {current.key === 'pay' && <PaymentDashboard projectId={projectId!} role={role} />}
        {current.key === 'fms' && <FMSView projectId={projectId!} focusId={focusFor('fms')} />}
        {current.key === 'po' && <DocList projectId={projectId!} role={role} type="PO" focusId={focusFor('po')} />}
        {current.key === 'wo' && <DocList projectId={projectId!} role={role} type="WO" focusId={focusFor('wo')} />}
        {current.key === 'grn' && <GRNView projectId={projectId!} role={role} focusId={focusFor('grn')} />}
        {current.key === 'vendors' && <VendorsView projectId={projectId!} role={role} />}
        {current.key === 'documents' && <DocumentsView projectId={projectId!} role={role} />}
        {current.key === 'reports' && <ReportsTab projectId={projectId!} />}
        {current.key === 'team' && <TeamTab projectId={projectId!} role={role} members={p.members} />}

        {/* Room-wise DPR — one view per tab of the original workbook. */}
        {current.key === 'dpr' && (!current.view || current.view === 'dashboard') && <DprDashboard projectId={projectId!} onOpenRoom={openRoom} />}
        {current.key === 'dpr' && current.view === 'entry' && <DailyEntryTab projectId={projectId!} />}
        {current.key === 'dpr' && current.view?.startsWith('room:') && (
          <RoomSheet key={current.view} projectId={projectId!} zoneId={current.view.slice(5)} />
        )}
        {current.key === 'dpr' && current.view === 'handover' && <RoomHandoverTab projectId={projectId!} onOpenRoom={openRoom} />}
        {current.key === 'dpr' && current.view === 'milestones' && <MilestonesTab projectId={projectId!} />}
        </div>
      </main>
    </>
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
  chart: I('M3 3v18h18M7 15l3-4 3 3 5-7'),
  pencil: I('M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z'),
  room: I('M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6'),
  flag: I('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7'),
};
