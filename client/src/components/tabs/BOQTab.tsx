import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Modal, ProgressBar, Spinner } from '../ui';
import { fmtNum, statusPill } from '../../lib/format';
import ProgressEntryModal from './ProgressEntryModal';
import ApprovalQueue from './ApprovalQueue';
import ProgressHistory from './ProgressHistory';
import BOQImportModal from './BOQImportModal';
import BOQAnalysisView from './BOQAnalysisView';
import BOQEnhanceView from './BOQEnhanceView';
import BOQCostView from './BOQCostView';
import BOQMasterView from './BOQMasterView';
import BOQCategorizeView from './BOQCategorizeView';
import BOQReconcileView from './BOQReconcileView';

// Sub-views of the BOQ page. The same underlying rows, three different lenses
// (DPR PRD §3.2 G9 / transcript R10-R11):
//   master → the contracted scope, immutable, no money
//   table  → how much of it is built  (BOQ & Progress)
//   cost   → what it cost to buy      (BOQ & Cost)
const SUBS = ['master', 'table', 'cost', 'models', 'categorize', 'reconcile', 'analysis', 'queue', 'history'] as const;
type Sub = (typeof SUBS)[number];

const SUB_LABEL: Record<Sub, string> = {
  master: 'BOQ (Master)',
  table: 'BOQ & Progress',
  cost: 'BOQ & Cost',
  models: 'Models & Item Lists',
  categorize: '🏷️ Categorize',
  reconcile: '⚖️ BOQ vs Received',
  analysis: '✨ AI Analysis',
  queue: 'Approval Queue',
  history: 'History',
};

interface BOQItem {
  id: string; srNo?: string; description: string; category?: string; roomZone?: string;
  unit?: string; makeModel?: string; remarks?: string; plannedQty: number; isGroup: boolean;
  installedQty: number; remainingQty: number; completionPct: number; colorStatus: string;
  modelNumber?: string | null;
}

// Inline editable "Model No." — decided after the BOQ, so it saves via a dedicated
// endpoint that works even when the BOQ is locked (PRD §5).
function ModelNumberCell({ projectId, item, canWrite }: { projectId: string; item: BOQItem; canWrite: boolean }) {
  const qc = useQueryClient();
  const [val, setVal] = useState(item.modelNumber ?? '');
  const save = useMutation({
    mutationFn: (modelNumber: string) => api.patch(`/projects/${projectId}/boq/items/${item.id}/model-number`, { modelNumber: modelNumber.trim() || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['boq', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });
  if (!canWrite) return <span className="text-xs text-slate-500">{item.modelNumber || '—'}</span>;
  return (
    <input
      className="input h-7 w-28 text-xs"
      placeholder="model no."
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => { if ((val.trim() || null) !== (item.modelNumber ?? null)) save.mutate(val); }}
    />
  );
}

export default function BOQTab({ projectId, locked }: { projectId: string; role: string; locked: boolean }) {
  const qc = useQueryClient();
  const { canEdit, can } = useAuth();
  // canWrite/isAdmin map to the "edit" grant on the BOQ page; approvals to the
  // canApprove section permission.
  const canWrite = canEdit('boq');
  const isAdmin = canEdit('boq');
  const isSupervisor = can('canApprove');

  const [showEntry, setShowEntry] = useState(false);
  const [entryItem, setEntryItem] = useState<BOQItem | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // The active sub-view lives in the URL so a cost sheet can be bookmarked and
  // shared (PRD §6.2: "URL updates for bookmarking").
  const [params, setParams] = useSearchParams();
  const raw = params.get('boq') as Sub | null;
  const sub: Sub = raw && SUBS.includes(raw) ? raw : 'table';
  const setSub = (s: Sub) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (s === 'table') next.delete('boq'); else next.set('boq', s);
    return next;
  }, { replace: true });

  const { data, isLoading } = useQuery({
    queryKey: ['boq', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data as { items: BOQItem[]; locked: boolean; categories: any[] },
  });

  const lockMut = useMutation({
    mutationFn: async (lock: boolean) => api.post(`/projects/${projectId}/boq/${lock ? 'lock' : 'unlock'}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['boq', projectId] }); qc.invalidateQueries({ queryKey: ['project', projectId] }); },
  });

  const kpis = useMemo(() => {
    const items = (data?.items ?? []).filter((i) => !i.isGroup);
    return {
      total: items.length,
      done: items.filter((i) => i.completionPct >= 100).length,
      inProgress: items.filter((i) => i.completionPct > 0 && i.completionPct < 100).length,
      notStarted: items.filter((i) => i.completionPct === 0).length,
    };
  }, [data]);

  if (isLoading) return <Spinner label="Loading BOQ…" />;

  const items = data?.items ?? [];
  const hasItems = items.length > 0;

  // Group rows by category preserving order
  const grouped: { category: string; rows: BOQItem[] }[] = [];
  for (const it of items) {
    const cat = it.category || 'Uncategorized';
    let g = grouped.find((x) => x.category === cat);
    if (!g) { g = { category: cat, rows: [] }; grouped.push(g); }
    if (!it.isGroup) g.rows.push(it);
  }

  return (
    <div className="space-y-4">
      {/* Summary KPIs (PRD §10.4). The cost view brings its own financial KPIs,
          and the master view is deliberately free of derived numbers. */}
      {sub !== 'cost' && sub !== 'master' && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KPI label="Total Items" value={kpis.total} />
          <KPI label="Completed" value={kpis.done} accent="#16a34a" />
          <KPI label="In Progress" value={kpis.inProgress} accent="#d97706" />
          <KPI label="Not Started" value={kpis.notStarted} accent="#dc2626" />
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {SUBS.filter((s) => s !== 'queue' || isSupervisor).map((s) => (
            <button key={s} onClick={() => setSub(s)} className={`rounded-md px-3 py-1.5 font-medium ${sub === s ? 'bg-white shadow-sm text-navy' : 'text-slate-500'}`}>
              {SUB_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && hasItems && sub === 'table' && (
            <button className="btn-primary" onClick={() => { setEntryItem(null); setShowEntry(true); }}>+ Add Progress</button>
          )}
          {/* Import and locking act on the master document, so they only make
              sense on the master / progress views. */}
          {isAdmin && (sub === 'master' || sub === 'table') && (
            <>
              <button className="btn-outline" onClick={() => setShowImport(true)}>Upload / Import BOQ</button>
              {hasItems && (
                <button className="btn-outline" onClick={() => lockMut.mutate(!locked)} disabled={lockMut.isPending}>
                  {locked ? '🔓 Unlock BOQ' : '🔒 Lock Baseline'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* The master view states the lock rule itself, in its own words. */}
      {locked && sub !== 'master' && <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">BOQ baseline is locked. Progress can still be logged; structural edits require unlocking (versioned).</div>}

      {sub === 'master' && <BOQMasterView items={items} locked={locked} />}
      {sub === 'cost' && <BOQCostView projectId={projectId} />}
      {sub === 'models' && <BOQEnhanceView projectId={projectId} canWrite={canWrite} />}
      {sub === 'categorize' && <BOQCategorizeView projectId={projectId} items={items} canWrite={canWrite} />}
      {sub === 'reconcile' && <BOQReconcileView projectId={projectId} canWrite={canWrite} />}
      {sub === 'analysis' && <BOQAnalysisView projectId={projectId} isAdmin={isAdmin} />}
      {sub === 'queue' && <ApprovalQueue projectId={projectId} canApprove={isSupervisor} />}
      {sub === 'history' && <ProgressHistory projectId={projectId} isAdmin={isSupervisor} />}

      {sub === 'table' && (
        !hasItems ? (
          <EmptyState
            title="No BOQ items yet"
            hint={isAdmin ? 'Upload the BOQ spreadsheet (.xlsx/.csv) or import the FKI baseline to begin tracking.' : 'The project admin has not uploaded the BOQ yet.'}
            action={isAdmin ? <button className="btn-primary mt-2" onClick={() => setShowImport(true)}>Upload / Import BOQ</button> : undefined}
          />
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                  <tr>
                    <th className="px-2 py-2">Sr.No</th>
                    <th className="px-4 py-2">Description</th>
                    <th className="px-2">Room/Zone</th>
                    <th className="px-2">Make &amp; Model</th>
                    {/* The chosen machine model number — decided later, vendor-specific (PRD §5). */}
                    <th className="px-2">Model No.</th>
                    <th className="px-2">Remarks</th>
                    <th className="px-2 text-right">Planned</th>
                    <th className="px-2 text-right">Installed</th>
                    <th className="px-2 text-right">Remaining</th>
                    <th className="px-2 w-48">Completion</th>
                    {canWrite && <th className="px-2"></th>}
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => (
                    <CategoryGroup
                      key={g.category}
                      projectId={projectId}
                      group={g}
                      collapsed={!!collapsed[g.category]}
                      toggle={() => setCollapsed((c) => ({ ...c, [g.category]: !c[g.category] }))}
                      canWrite={canWrite}
                      onAdd={(it) => { setEntryItem(it); setShowEntry(true); }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {showEntry && (
        <ProgressEntryModal
          projectId={projectId}
          items={items.filter((i) => !i.isGroup)}
          preselect={entryItem}
          onClose={() => setShowEntry(false)}
          onSaved={() => { setShowEntry(false); qc.invalidateQueries({ queryKey: ['boq', projectId] }); qc.invalidateQueries({ queryKey: ['dashboard', projectId] }); }}
        />
      )}
      {showImport && (
        <BOQImportModal
          projectId={projectId}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); qc.invalidateQueries({ queryKey: ['boq', projectId] }); qc.invalidateQueries({ queryKey: ['dashboard', projectId] }); qc.invalidateQueries({ queryKey: ['project', projectId] }); }}
        />
      )}
    </div>
  );
}

function CategoryGroup({ projectId, group, collapsed, toggle, canWrite, onAdd }: {
  projectId: string;
  group: { category: string; rows: BOQItem[] };
  collapsed: boolean; toggle: () => void; canWrite: boolean; onAdd: (it: BOQItem) => void;
}) {
  const planned = group.rows.reduce((s, r) => s + r.plannedQty, 0);
  const installed = group.rows.reduce((s, r) => s + r.installedQty, 0);
  const pct = planned > 0 ? Math.round((installed / planned) * 1000) / 10 : 0;
  return (
    <>
      <tr className="cursor-pointer bg-slate-100/60 font-semibold text-navy hover:bg-slate-100" onClick={toggle}>
        <td className="px-4 py-2" colSpan={9}>
          <span className="mr-2 inline-block w-3 text-slate-400">{collapsed ? '▶' : '▼'}</span>
          {group.category} <span className="ml-2 text-xs font-normal text-slate-400">({group.rows.length})</span>
        </td>
        <td className="px-2"><div className="flex items-center gap-2"><ProgressBar pct={pct} height={8} /><span className="w-10 text-right text-xs">{pct}%</span></div></td>
        {canWrite && <td></td>}
      </tr>
      {!collapsed && group.rows.map((it) => (
        <tr key={it.id} className="border-b border-slate-100 align-top hover:bg-slate-50">
          <td className="px-2 py-2 text-xs text-slate-500 whitespace-nowrap">{it.srNo || '—'}</td>
          <td className="px-4 py-2">
            <div className="text-slate-700">{it.description}</div>
          </td>
          <td className="px-2 text-xs text-slate-500">{it.roomZone || '—'}</td>
          <td className="px-2 text-xs text-slate-500">{it.makeModel || '—'}</td>
          {/* Chosen machine model number — typed, editable even when the BOQ is locked. */}
          <td className="px-2">{it.isGroup ? null : <ModelNumberCell projectId={projectId} item={it} canWrite={canWrite} />}</td>
          <td className="px-2 text-xs text-slate-500 max-w-[16rem] whitespace-pre-wrap">{it.remarks || '—'}</td>
          <td className="px-2 text-right">{fmtNum(it.plannedQty)} <span className="text-xs text-slate-400">{it.unit}</span></td>
          <td className="px-2 text-right text-navy">{fmtNum(it.installedQty)}</td>
          <td className="px-2 text-right">{fmtNum(it.remainingQty)}</td>
          <td className="px-2">
            <div className="flex items-center gap-2">
              <ProgressBar pct={it.completionPct} height={8} />
              <span className={`badge ${statusPill(it.completionPct)} w-12 justify-center`}>{it.completionPct}%</span>
            </div>
          </td>
          {canWrite && (
            <td className="px-2 text-right">
              <button className="text-xs font-medium text-navy hover:underline" onClick={() => onAdd(it)}>+ Log</button>
            </td>
          )}
        </tr>
      ))}
    </>
  );
}
