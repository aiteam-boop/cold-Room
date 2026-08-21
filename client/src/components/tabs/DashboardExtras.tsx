import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { COLOR_HEX, fmtDate, titleize, inr } from '../../lib/format';
import { Modal } from '../ui';
import ProcurementPipeline from '../procurement/ProcurementPipeline';

// NEW dashboard cards (additive — rendered below the existing dashboard):
// Room-wise progress (F3), Gantt/timeline summary (F4), Change Orders (F5).
export default function DashboardExtras({ projectId, onOpenGantt }: { projectId: string; onOpenGantt?: () => void }) {
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
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-600">Timeline (Gantt)</div>
            {onOpenGantt && g?.total > 0 && <button className="text-xs font-medium text-navy hover:underline" onClick={onOpenGantt}>View Full Gantt →</button>}
          </div>
          {!g || g.total === 0 ? <div className="text-sm text-slate-400">No timeline activities yet. Add them in the Gantt / Timeline page.</div> : (
            <>
              <div className="grid grid-cols-4 gap-2 text-center">
                <Stat n={g.total} l="Activities" />
                <Stat n={g.completed} l="Done" c="#16a34a" />
                <Stat n={g.inProgress} l="Active" c="#2563eb" />
                <Stat n={g.delayed} l="Delayed" c="#dc2626" sub={g.worstDelay ? `worst ${g.worstDelay}d` : ''} />
              </div>
              {g.pendingDrawingApproval && (
                <div className="mt-3 rounded bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700">{g.drawingApprovalLabel}</div>
              )}
              <MiniGantt activities={gantt.data?.activities ?? []} />
            </>
          )}
          {g?.projectTarget && <div className="mt-3 text-xs text-slate-400">Target completion: {fmtDate(g.projectTarget)}</div>}
        </div>
        <div className="card p-5">
          <div className="mb-2 text-sm font-medium text-slate-600">Change Orders</div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat n={orders.length} l="Total" />
            <Stat n={openCo} l="Open" c="#d97706" />
            <Stat n={`₹${approvedImpact.toLocaleString('en-IN')}`} l="Approved impact" c="#052379" />
          </div>
        </div>
      </div>

      {/* Room-wise progress */}
      {roomList.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-medium text-slate-600">Room-wise Progress</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
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

      {/* Procurement pipeline — each PO/WO's phases (Approval → Payment → GRN). */}
      <ProcPipelineSection projectId={projectId} />
    </div>
  );
}

// A collapsible list of the project's PO/WOs; expanding one shows its phase
// timeline (Approval → Payment → Goods Receipt), lazy-loaded on open.
function ProcPipelineSection({ projectId }: { projectId: string }) {
  const { hideFinancials } = useAuth();
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const docsQ = useQuery({ queryKey: ['proc-docs-pipeline', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/docs`)).data.docs as any[] });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // When a PO/WO has several goods receipts, the GRN action opens this popup list.
  const [grnPopup, setGrnPopup] = useState<any | null>(null);
  const docs = docsQ.data ?? [];
  if (docsQ.isError || docs.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-sm font-medium text-slate-600">Procurement Pipeline — {docs.length} PO/WO</div>
      {/* A real HTML table so every column lines up under its header (independent per-row
          grids never aligned). Order: Document · Vendor · Raised By · Amount · Date · Items ·
          Documents (PO/PI/GRN) · Status (pending-approver + badge, rightmost). */}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              <th className="w-6 px-2 py-2"></th>
              <th className="px-3 py-2">Document</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Raised By</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Items</th>
              <th className="px-3 py-2 text-right">Documents</th>
              <th className="px-3 py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {docs.map((d: any) => {
              const isOpen = open.has(d.id);
              return (
                <Fragment key={d.id}>
                  <tr className="cursor-pointer align-middle hover:bg-slate-50" onClick={() => toggle(d.id)}>
                    <td className="px-2 py-2.5 text-slate-400">{isOpen ? '▾' : '▸'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className="font-medium text-navy">{d.docNumber}</span>
                      <span className="badge ml-1.5 bg-slate-100 text-slate-600">{d.type}</span>
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2.5 text-slate-500" title={d.vendorName || ''}>{d.vendorName || '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-400" title={d.createdBy?.name ? `Raised by ${d.createdBy.name}` : ''}>{d.createdBy?.name ? `👤 ${d.createdBy.name}` : '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-medium text-slate-700">{d.finalAmount != null ? money(d.finalAmount) : ''}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-400">{d.docDate ? fmtDate(d.docDate) : ''}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-slate-400">
                      {(d.counts?.lineItems ?? 0) > 0 ? `📋 ${d.counts.lineItems} items` : ''}
                      {d.delivery?.status === 'LATE' || d.delivery?.status === 'OVERDUE'
                        ? <span className="ml-1 font-medium text-rose-600">🚚 {d.delivery.status === 'LATE' ? `Late${d.delivery.delayDays ? ` +${d.delivery.delayDays}d` : ''}` : `Overdue${d.delivery.delayDays ? ` +${d.delivery.delayDays}d` : ''}`}</span>
                        : d.delivery?.status === 'ON_TIME' ? <span className="ml-1 text-emerald-600">🚚 On time</span> : ''}
                    </td>
                    {/* Documents: PO/WO PDF, PI (if any), GRN (if any). */}
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className="flex items-center justify-end gap-1">
                        <span role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); openAuthedFile(`/projects/${projectId}/procurement/docs/${d.id}/pdf`); }} className="cursor-pointer rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-medium text-navy hover:bg-slate-50" title={`Open ${d.type} PDF`}>📄 {d.type}</span>
                        {(d.pis?.length ?? 0) > 0 && <span role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); window.open(d.pis[0].piUrl, '_blank'); }} className="cursor-pointer rounded border border-navy/20 bg-navy/5 px-1.5 py-0.5 text-[10px] font-medium text-navy hover:bg-navy/10" title="Open Proforma Invoice">📄 PI{d.pis.length > 1 ? ` (${d.pis.length})` : ''}</span>}
                        {(d.goodsReceipts?.length ?? 0) > 0 && <span role="link" tabIndex={0} onClick={(e) => { e.stopPropagation(); if (d.goodsReceipts.length === 1) openAuthedFile(`/projects/${projectId}/procurement/goods-receipts/${d.goodsReceipts[0].id}/pdf`); else setGrnPopup(d); }} className="cursor-pointer rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100" title="Open Goods Receipt PDF">📦 GRN{d.goodsReceipts.length > 1 ? ` (${d.goodsReceipts.length})` : ''}</span>}
                      </span>
                    </td>
                    {/* Status: pending-approver merged next to the status badge (rightmost). */}
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <span className="flex items-center justify-end gap-2">
                        {d.status === 'PENDING_APPROVAL' && d.pendingWith && (
                          <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700" title="Currently pending with">⏳ {d.pendingWith}{d.pendingWithRole ? ` · ${d.pendingWithRole}` : ''}</span>
                        )}
                        <span className={`badge ${d.status === 'APPROVED' ? 'bg-green-100 text-green-700' : d.status === 'PENDING_APPROVAL' ? 'bg-amber-100 text-amber-700' : d.status === 'ON_HOLD' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-500'}`}>{titleize(d.status)}</span>
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={9} className="border-t border-slate-100 bg-slate-50/50 px-4 py-3">
                        <ProcurementPipeline projectId={projectId} docId={d.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {grnPopup && (
        <Modal onClose={() => setGrnPopup(null)} title={`Goods Receipts — ${grnPopup.docNumber}`}>
          <div className="space-y-2">
            {(grnPopup.goodsReceipts ?? []).map((g: any) => (
              <button key={g.id} onClick={() => openAuthedFile(`/projects/${projectId}/procurement/goods-receipts/${g.id}/pdf`)} className="flex w-full items-center justify-between rounded border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50">
                <span className="font-medium text-navy">📦 {g.grnNumber}</span>
                <span className="flex items-center gap-2"><span className="badge bg-slate-100 text-slate-600">{titleize(g.status || '')}</span><span className="text-[10px] text-navy underline">Open PDF</span></span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Stat({ n, l, c, sub }: { n: any; l: string; c?: string; sub?: string }) {
  return <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold" style={{ color: c ?? '#052379' }}>{n}</div><div className="text-[11px] text-slate-400">{l}{sub ? ` · ${sub}` : ''}</div></div>;
}

// Compact Gantt summary (Sprint PRD §10.2) — real activity bars, not a static
// placeholder. Shows the most urgent handful: delayed first, then in-flight.
const MINI_FILL: Record<string, string> = {
  NOT_STARTED: '#94a3b8', PAST_DUE_NOT_STARTED: '#dc2626',
  IN_PROGRESS: '#2563eb', IN_PROGRESS_OVERDUE: '#dc2626',
  DONE_ON_TIME: '#16a34a', DONE_LATE: '#eab308',
};
const RANK: Record<string, number> = { DELAYED: 0, IN_PROGRESS: 1, NOT_STARTED: 2, COMPLETED: 3 };

function MiniGantt({ activities }: { activities: any[] }) {
  if (!activities.length) return null;
  const top = [...activities].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || b.delayDays - a.delayDays).slice(0, 6);

  // Scale across the whole project, not just the shown rows, so the today marker
  // sits where it really is on the schedule.
  let min = Infinity, max = -Infinity;
  for (const a of activities) {
    min = Math.min(min, new Date(a.plannedStartDate).getTime());
    max = Math.max(max, new Date(a.plannedEndDate).getTime());
  }
  const now = Date.now();
  min = Math.min(min, now); max = Math.max(max, now);
  const span = max - min || 1;
  const pos = (t: number) => ((t - min) / span) * 100;

  return (
    <div className="mt-3 space-y-1">
      {top.map((a) => {
        const left = pos(new Date(a.plannedStartDate).getTime());
        const width = Math.max(pos(new Date(a.plannedEndDate).getTime()) - left, 1.5);
        return (
          <div key={a.id} className="flex items-center gap-2">
            <div className="w-28 shrink-0 truncate text-[10px] text-slate-500" title={a.activityName}>{a.activityName}</div>
            <div className="relative h-2 flex-1 rounded-full bg-slate-100">
              <div className="absolute top-0 z-10 h-full w-px bg-red-500" style={{ left: `${pos(now)}%` }} title="Today" />
              <div className="absolute top-0 h-2 rounded-full" style={{ left: `${left}%`, width: `${width}%`, background: MINI_FILL[a.barState] ?? '#94a3b8' }} />
            </div>
            <div className="w-10 shrink-0 text-right text-[10px] font-medium text-red-600">{a.delayDays > 0 ? `+${a.delayDays}d` : ''}</div>
          </div>
        );
      })}
    </div>
  );
}
