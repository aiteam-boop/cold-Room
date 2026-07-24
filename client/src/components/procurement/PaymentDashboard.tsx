import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Modal, Spinner } from '../ui';
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
  const [paying, setPaying] = useState<{ docId: string; milestone: any } | null>(null);

  const { data, isLoading } = useQuery({ queryKey: ['pay-dash', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/payment-dashboard`)).data });

  const trigger = useMutation({
    mutationFn: (v: { docId: string; mid: string; date: string }) => api.post(`/projects/${projectId}/procurement/docs/${v.docId}/milestones/${v.mid}/trigger`, { date: v.date }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pay-dash', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (isLoading || !data) return <Spinner label="Loading payment pipeline…" />;
  const { rows, summary, vendors = [] } = data;
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
                {/* Invoiced vs PO variance — payments are capped at the invoiced amount. */}
                {!hideFinancials && r.amountInvoiced > 0 && (
                  <div className="mt-0.5 text-xs">
                    <span className="text-blue-600">Invoiced {money(r.amountInvoiced)}</span>
                    {Math.round((r.totalWithGst - r.amountInvoiced) * 100) / 100 > 0 && (
                      <span className="text-amber-600"> · {money(r.totalWithGst - r.amountInvoiced)} under PO</span>
                    )}
                    <span className="text-slate-400"> · payable up to {money(r.amountInvoiced)}</span>
                  </div>
                )}
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
                          {m.actualTriggerDate && m.status !== 'PAID' && <div className="text-[11px] text-slate-400">Triggered {fmtDate(m.actualTriggerDate)}</div>}
                          {m.status === 'PAID' && (
                            <div className="text-[11px] text-slate-400">
                              {m.utrNumber ? <>UTR: <span className="font-medium text-slate-600">{m.utrNumber}</span></> : m.paymentReference ? `Ref: ${m.paymentReference}` : ''}
                              {m.paymentDate && ` · ${fmtDate(m.paymentDate)}`}
                              {m.paymentProofUrl && <> · <a className="text-navy hover:underline" href={m.paymentProofUrl} target="_blank" rel="noreferrer">proof</a></>}
                            </div>
                          )}
                        </td>
                        <td className="text-right">
                          {m.status === 'PENDING' && isProc && (
                            <button className="text-xs font-medium text-navy hover:underline" onClick={() => trigger.mutate({ docId: r.docId, mid: m.id, date: new Date().toISOString().slice(0, 10) })}>Mark Triggered</button>
                          )}
                          {m.status === 'TRIGGERED' && isAccounts && (
                            <button className="text-xs font-medium text-green-700 hover:underline" onClick={() => setPaying({ docId: r.docId, milestone: m })}>Mark Paid</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Approved GRNs on this PO/WO with their invoice files. */}
                {r.grns?.length > 0 && (
                  <div className="mt-3 border-t border-slate-200 pt-2">
                    <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Received (GRN invoices)</div>
                    {r.grns.map((g: any) => (
                      <div key={g.id} className="flex items-center justify-between gap-3 py-0.5 text-xs">
                        {/* PI (drives the payment, arrives first) then the tax invoice
                            (arrives later and closes the entry) — both shown the same way. */}
                        <span className="text-slate-600">
                          {g.grnNumber}
                          {/* Which payment term this GRN is for — so it's clear at a glance. */}
                          {g.milestoneName && <span className="ml-1 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">{g.milestoneName}</span>}
                          {(g.piNumber || g.piValue != null) ? ` · PI${g.piNumber ? ` ${g.piNumber}` : ''}${g.piValue != null ? ` · ${money(g.piValue)}` : ''}` : ''}
                          {(g.invoiceNumber || g.invoiceValue != null || g.invoicePdfUrl)
                            ? `${g.invoiceNumber ? ` · Invoice ${g.invoiceNumber}` : ' · Invoice'}${g.invoiceValue != null ? ` · ${money(g.invoiceValue)}` : ''}`
                            : ' · tax invoice pending'}
                        </span>
                        <span className="flex items-center gap-3">
                          <button className="font-medium text-navy hover:underline" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${g.id}/pdf`, `${g.grnNumber || 'GRN'}.pdf`)}>📄 GRN</button>
                          {g.piPdfUrl && <a className="font-medium text-navy hover:underline" href={g.piPdfUrl} target="_blank" rel="noreferrer">📄 PI</a>}
                          {g.invoicePdfUrl && <a className="font-medium text-navy hover:underline" href={g.invoicePdfUrl} target="_blank" rel="noreferrer">📄 Invoice</a>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-xs text-slate-400">Procurement triggers a milestone when its condition is met → Accounts marks it paid with the UTR number.</div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Per-vendor rollup: last payment date, last UTR, running total paid. */}
      {!hideFinancials && vendors.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-semibold text-slate-600">Payments by vendor</div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">Vendor</th><th>Last payment</th><th>Last UTR</th><th className="text-right">Total paid</th></tr></thead>
            <tbody>
              {vendors.map((v: any) => (
                <tr key={v.vendorName} className="border-t border-slate-100">
                  <td className="py-1.5 font-medium text-slate-700">{v.vendorName}</td>
                  <td className="text-xs text-slate-500">{fmtDate(v.lastPaymentDate)}</td>
                  <td className="text-xs text-slate-500">{v.lastUtr || '—'}</td>
                  <td className="text-right font-medium">{money(v.amountPaid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {paying && (
        <MarkPaidModal
          projectId={projectId}
          docId={paying.docId}
          milestone={paying.milestone}
          onClose={() => setPaying(null)}
          onDone={() => { setPaying(null); qc.invalidateQueries({ queryKey: ['pay-dash', projectId] }); }}
        />
      )}
    </div>
  );
}

// Accounts records the payment: UTR number + payment date are mandatory, an
// optional NEFT receipt can be attached (Sprint PRD §9.1). FMS auto-fetch of the
// UTR is a Phase-2 item — for now this is manual entry.
function MarkPaidModal({ projectId, docId, milestone, onClose, onDone }: { projectId: string; docId: string; milestone: any; onClose: () => void; onDone: () => void }) {
  const [utrNumber, setUtr] = useState('');
  const [paymentDate, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [err, setErr] = useState('');

  const base = `/projects/${projectId}/procurement/docs/${docId}/milestones/${milestone.id}`;
  const m = useMutation({
    mutationFn: async () => {
      await api.post(`${base}/pay`, { utrNumber: utrNumber.trim(), paymentDate, remarks });
      // Attach the proof only after the payment itself lands, so a failed upload
      // never leaves the milestone stuck in TRIGGERED.
      if (proof) { const fd = new FormData(); fd.append('file', proof); await api.post(`${base}/proof`, fd); }
    },
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <Modal title="Mark Payment as Paid" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          <div className="font-medium text-slate-700">{milestone.name} · {milestone.percentage}%</div>
          <div className="text-xs text-slate-500">{inr(milestone.inrAmount)}{milestone.triggerCondition ? ` · ${milestone.triggerCondition}` : ''}</div>
        </div>
        <div><label className="label">UTR Number *</label><input className="input" required value={utrNumber} onChange={(e) => setUtr(e.target.value)} placeholder="NEFT / RTGS / IMPS reference" /></div>
        <div><label className="label">Payment Date *</label><input className="input" type="date" required value={paymentDate} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="label">Payment proof (optional)</label><input className="input text-xs" type="file" accept=".pdf,image/*" onChange={(e) => setProof(e.target.files?.[0] ?? null)} /></div>
        <div><label className="label">Remarks</label><input className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Mark Paid'}</button>
        </div>
      </form>
    </Modal>
  );
}
