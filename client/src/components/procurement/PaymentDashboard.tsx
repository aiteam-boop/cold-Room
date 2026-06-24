import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Spinner } from '../ui';
import { fmtDate, inr } from '../../lib/format';

export default function PaymentDashboard({ projectId }: { projectId: string; role: string }) {
  const qc = useQueryClient();
  const { canEdit, can, hideFinancials } = useAuth();
  const isProc = canEdit('pay');
  const isAccounts = can('canMarkPaid');
  // Money helper — server already strips ₹ for hideFinancials users; this keeps
  // the UI honest (dash instead of ₹0) and prevents any flash.
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['pay-dash', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/payment-dashboard`)).data });

  const trigger = useMutation({
    mutationFn: (v: { docId: string; mid: string; date: string }) => api.post(`/projects/${projectId}/procurement/docs/${v.docId}/milestones/${v.mid}/trigger`, { date: v.date }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pay-dash', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });
  const pay = useMutation({
    mutationFn: (v: { docId: string; mid: string; ref: string; date: string }) => api.post(`/projects/${projectId}/procurement/docs/${v.docId}/milestones/${v.mid}/pay`, { paymentReference: v.ref, paymentDate: v.date }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pay-dash', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (isLoading || !data) return <Spinner label="Loading payment pipeline…" />;
  const { rows, summary } = data;
  if (rows.length === 0) return <EmptyState title="No approved POs/WOs yet" hint="Approved Purchase Orders and Work Orders appear here with their payment milestones." />;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KPI label="Total PO Value" value={money(summary.totalPO)} />
        <KPI label="Total WO Value" value={money(summary.totalWO)} />
        <KPI label="Invoiced" value={money(summary.totalInvoiced)} accent="#2563eb" />
        <KPI label="Paid" value={money(summary.totalPaid)} accent="#16a34a" />
        <KPI label="Pending" value={money(summary.totalPending)} accent="#dc2626" sub={summary.delayAlerts ? `${summary.delayAlerts} delay alert(s)` : undefined} />
      </div>

      <div className="card divide-y divide-slate-100">
        {rows.map((r: any) => (
          <div key={r.docId}>
            <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpen(open === r.docId ? null : r.docId)}>
              <span className="text-slate-400">{open === r.docId ? '▼' : '▶'}</span>
              <div className="w-40 min-w-0">
                <span className="font-medium text-navy">{r.docNumber}</span> <span className="badge bg-slate-100 text-slate-600">{r.type}</span>
                {r.delayed && <span className="ml-1 badge bg-red-100 text-red-700">delay</span>}
                <div className="truncate text-xs text-slate-400">{r.vendorName}</div>
              </div>
              <div className="hidden w-28 text-right text-sm sm:block">{money(r.totalWithGst)}</div>
              <div className="flex-1">
                <div className="h-2.5 w-full rounded-full bg-slate-200"><div className="h-2.5 rounded-full bg-green-500" style={{ width: `${Math.min(r.progressPct, 100)}%` }} /></div>
                <div className="mt-0.5 text-xs text-slate-400">{r.progressPct}% paid · {money(r.amountPaid)} / {money(r.totalWithGst)} · {r.milestonesTriggered}/{r.milestonesTotal} triggered</div>
              </div>
              <span className="badge bg-slate-100 text-slate-600">{r.grnStatus}</span>
            </button>

            {open === r.docId && (
              <div className="bg-slate-50/60 px-4 py-3">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs uppercase text-slate-400"><th className="py-1">Milestone</th><th>Condition</th><th className="text-right">Amount</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {r.milestones.map((m: any) => (
                      <tr key={m.id} className="border-t border-slate-100">
                        <td className="py-2 font-medium text-slate-700">{m.name} <span className="text-xs font-normal text-slate-400">{m.percentage}%</span></td>
                        <td className="text-xs text-slate-500">{m.triggerCondition || '—'}</td>
                        <td className="text-right">{money(m.inrAmount)}</td>
                        <td>
                          <span className={`badge ${m.status === 'PAID' ? 'bg-green-100 text-green-700' : m.status === 'TRIGGERED' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{m.status}</span>
                          {m.paymentReference && <div className="text-[11px] text-slate-400">Ref: {m.paymentReference} · {fmtDate(m.paymentDate)}</div>}
                        </td>
                        <td className="text-right">
                          {m.status === 'PENDING' && isProc && (
                            <button className="text-xs font-medium text-navy hover:underline" onClick={() => trigger.mutate({ docId: r.docId, mid: m.id, date: new Date().toISOString().slice(0, 10) })}>Mark Triggered</button>
                          )}
                          {m.status === 'TRIGGERED' && isAccounts && (
                            <button className="text-xs font-medium text-green-700 hover:underline" onClick={() => { const ref = prompt('Payment reference (UTR / cheque no.)') || ''; if (ref) pay.mutate({ docId: r.docId, mid: m.id, ref, date: new Date().toISOString().slice(0, 10) }); }}>Mark Paid</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 text-xs text-slate-400">Amisha triggers a milestone when its condition is met → Accounts marks it paid with a reference.</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
