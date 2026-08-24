import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Modal, Spinner } from '../ui';
import { fmtDate, inr } from '../../lib/format';

// Spread a PO's Accounts-sheet payments across its still-PENDING terms (greedy, in
// order) so each term SHOWS as paid-via-sheet with its UTR. This is a display mirror
// only — the in-app milestone/installment records are never touched (the payment was
// actually made outside the app, via the Accounts form). Terms already active in-app
// (TRIGGERED/PAID) are left to the in-app flow.
function computeSheetAlloc(r: any): Record<string, { paid: number; full: boolean; utrs: any[] }> {
  const alloc: Record<string, { paid: number; full: boolean; utrs: any[] }> = {};
  const pool = (r.sheetPayments || []).map((s: any) => ({ ...s, left: Number(s.amount) || 0 }));
  if (!pool.length) return alloc;
  for (const m of (r.milestones || [])) {
    if (m.status !== 'PENDING') continue;
    let need = m.inrAmount || 0;
    const utrs: any[] = []; let paid = 0;
    for (const p of pool) {
      if (need <= 0.01) break;
      if (p.left <= 0.01) continue;
      const take = Math.min(p.left, need);
      paid += take; need -= take; p.left -= take; utrs.push(p);
    }
    if (paid > 0.01) alloc[m.id] = { paid, full: need <= 0.01, utrs };
  }
  return alloc;
}

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
  // Backfill UTRs for old payments from the company Accounts sheet (read-only).
  const [utrReport, setUtrReport] = useState<any>(null);
  const fetchUtr = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/fetch-sheet-utr`)).data,
    onSuccess: (r) => { setUtrReport(r); qc.invalidateQueries({ queryKey: ['pay-dash', projectId] }); },
    onError: (e) => alert(errMsg(e)),
  });

  if (isLoading || !data) return <Spinner label="Loading payment pipeline…" />;
  const { rows, summary, vendors = [] } = data;
  if (rows.length === 0) return <EmptyState title="No approved POs/WOs yet" hint="Approved Purchase Orders and Work Orders appear here with their payment milestones." />;
  // Per-PO sheet-payment allocation (display mirror — see computeSheetAlloc).
  const allocByDoc: Record<string, ReturnType<typeof computeSheetAlloc>> = {};
  for (const r of rows) allocByDoc[r.docId] = computeSheetAlloc(r);

  // The row's paid amount/percentage must also count payments made via the
  // Accounts sheet (they never touch the in-app amountPaid), otherwise a PO that
  // shows "Paid (Accounts)" still reads "0% paid" with an empty bar. The sheet
  // allocation only fills PENDING terms, so it never double-counts in-app paid.
  const sheetPaidOf = (r: any) => Object.values(allocByDoc[r.docId] ?? {}).reduce((s: number, a: { paid: number }) => s + a.paid, 0);
  const dispPaidOf = (r: any) => (r.amountPaid || 0) + sheetPaidOf(r);
  const dispPctOf = (r: any) => (r.totalWithGst > 0 ? Math.min(Math.round((dispPaidOf(r) / r.totalWithGst) * 100), 100) : r.progressPct);

  return (
    <div className="space-y-4">
      {isAccounts && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs">
          <span className="font-medium text-slate-600">Old payments paid via the Accounts sheet?</span>
          <button className="btn-outline text-xs disabled:opacity-40" disabled={fetchUtr.isPending} onClick={() => fetchUtr.mutate()}>
            {fetchUtr.isPending ? 'Fetching from sheet…' : '⬇ Fetch UTR from Accounts sheet'}
          </button>
          <span className="text-slate-400">Reads the FMS sheet (view-only), matches by vendor + amount, and fills the UTR for any payment still missing one.</span>
        </div>
      )}
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
                <div className="h-2.5 w-full rounded-full bg-slate-200"><div className="h-2.5 rounded-full bg-green-500" style={{ width: `${dispPctOf(r)}%` }} /></div>
                <div className="mt-0.5 text-xs text-slate-400">{dispPctOf(r)}% paid · {money(dispPaidOf(r))} / {money(r.totalWithGst)} · {r.milestonesTriggered}/{r.milestonesTotal} triggered{sheetPaidOf(r) > 0 && <span className="text-green-600"> · incl. {money(sheetPaidOf(r))} via Accounts sheet</span>}</div>
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
              {(r.sheetPayments?.length ?? 0) > 0 && r.grnStatus === 'No Payment'
                ? <span className="badge bg-green-100 text-green-700" title="Paid via the Accounts sheet (outside the app)">✓ Paid (Accounts)</span>
                : <span className={`badge ${r.grnStatus === 'Payment Paid' ? 'bg-green-100 text-green-700' : r.grnStatus === 'Payment Triggered' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>{r.grnStatus}</span>}
            </button>

            {open === r.docId && (
              <div className="bg-slate-50/60 px-4 py-3">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs uppercase text-slate-400"><th className="py-1">Milestone</th><th>Condition</th><th className="text-right">Amount</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {r.milestones.map((m: any) => { const sa = allocByDoc[r.docId]?.[m.id]; return (
                      <tr key={m.id} className="border-t border-slate-100">
                        <td className="py-2 font-medium text-slate-700">{m.name} <span className="text-xs font-normal text-slate-400">{m.percentage}%</span></td>
                        <td className="text-xs text-slate-500">{m.triggerCondition || '—'}</td>
                        <td className="text-right">
                          {money(m.inrAmount)}
                          {/* Part-payment (A1/A3): show what's paid vs still pending. */}
                          {m.status === 'PARTIALLY_PAID' && (
                            <div className="text-[11px] text-slate-400">Paid {money(m.amountPaid)} · <span className="font-medium text-rose-600">Pending {money(m.remaining)}</span></div>
                          )}
                          {/* Term split across several payment entries but not fully
                              covered yet — flag the still-open balance in red. */}
                          {m.status !== 'PARTIALLY_PAID' && m.pending > 0 && (
                            <div className="text-[11px] font-medium text-rose-600">{money(m.pending)} pending</div>
                          )}
                        </td>
                        <td>
                          {/* Paid via the Accounts sheet (outside the app) — show it as
                              paid with the UTR, in green, instead of PENDING. */}
                          {sa && m.status === 'PENDING' ? (
                            <>
                              <span className="badge bg-green-100 text-green-700">✓ PAID{sa.full ? '' : ' (PART)'} · sheet</span>
                              <div className="mt-0.5 text-[11px] text-slate-500">UTR: {sa.utrs.map((u: any, i: number) => <span key={i}>{i > 0 ? ', ' : ''}<span className="font-medium text-slate-700">{u.utr}</span>{u.vrNo ? <span className="text-slate-400"> ({u.vrNo})</span> : ''}</span>)}</div>
                              <div className="text-[10px] text-slate-400">via Accounts sheet · {money(sa.paid)}{sa.full ? '' : ` of ${money(m.inrAmount)}`}</div>
                            </>
                          ) : (
                            <>
                              <span className={`badge ${m.status === 'PAID' ? 'bg-green-100 text-green-700' : m.status === 'PARTIALLY_PAID' ? 'bg-orange-100 text-orange-700' : m.status === 'TRIGGERED' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{m.status === 'PARTIALLY_PAID' ? 'PARTLY PAID' : m.status}</span>
                              {m.actualTriggerDate && m.status !== 'PAID' && m.status !== 'PARTIALLY_PAID' && <div className="text-[11px] text-slate-400">Triggered {fmtDate(m.actualTriggerDate)}</div>}
                              {(m.status === 'PAID' || m.status === 'PARTIALLY_PAID') && (
                                <div className="text-[11px] text-slate-400">
                                  {m.utrNumber ? <>UTR: <span className="font-medium text-slate-600">{m.utrNumber}</span></> : m.paymentReference ? `Ref: ${m.paymentReference}` : ''}
                                  {m.paymentDate && ` · ${fmtDate(m.paymentDate)}`}
                                  {m.paymentProofUrl && <> · <a className="text-navy hover:underline" href={m.paymentProofUrl} target="_blank" rel="noreferrer">proof</a></>}
                                  {m.installments?.length > 1 && (
                                    <div className="mt-0.5">{m.installments.map((i: any, idx: number) => (<span key={i.id}>{idx > 0 ? ' · ' : ''}{money(i.amount)}{i.utrNumber ? ` (${i.utrNumber})` : ''}</span>))}</div>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </td>
                        <td className="text-right">
                          {/* Sheet-paid terms need no action — they were settled outside the app. */}
                          {!sa && m.status === 'PENDING' && isProc && (
                            <button className="text-xs font-medium text-navy hover:underline" onClick={() => trigger.mutate({ docId: r.docId, mid: m.id, date: new Date().toISOString().slice(0, 10) })}>Mark Triggered</button>
                          )}
                          {/* Term triggers on submit, but is only payable once its own
                              payment is approved. A partly-paid term can be re-paid for
                              the balance (A1/A3). */}
                          {!sa && (m.status === 'TRIGGERED' || m.status === 'PARTIALLY_PAID') && isAccounts && (
                            m.paymentApproved
                              ? <button className="text-xs font-medium text-green-700 hover:underline" onClick={() => setPaying({ docId: r.docId, milestone: m })}>{m.status === 'PARTIALLY_PAID' ? 'Pay balance' : 'Mark Paid'}</button>
                              : <span className="text-[11px] text-slate-400">Awaiting approval</span>
                          )}
                        </td>
                      </tr>
                    ); })}
                  </tbody>
                </table>
                {/* Approved GRNs on this PO/WO with their invoice files. */}
                {r.grns?.length > 0 && (
                  <div className="mt-3 border-t border-slate-200 pt-2">
                    <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Payments (PI / invoices)</div>
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
                          {/* If this term still has an open balance across part-payments, flag it in red. */}
                          {g.termPending > 0 && <span className="ml-1 font-semibold text-rose-600">({money(g.termPending)} pending)</span>}
                        </span>
                        <span className="flex items-center gap-3">
                          <button className="font-medium text-navy hover:underline" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${g.id}/pdf`, `${g.grnNumber || 'Payment'}.pdf`)}>📄 Payment</button>
                          {g.piPdfUrl && <a className="font-medium text-navy hover:underline" href={g.piPdfUrl} target="_blank" rel="noreferrer">📄 PI</a>}
                          {g.invoicePdfUrl && <a className="font-medium text-navy hover:underline" href={g.invoicePdfUrl} target="_blank" rel="noreferrer">📄 Invoice</a>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Physical goods receipts raised against this PO/WO — shown
                    regardless of milestone match; a PO can carry several. */}
                {r.goodsReceipts?.length > 0 && (
                  <div className="mt-3 border-t border-slate-200 pt-2">
                    <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Goods Receipts (GRN)</div>
                    {r.goodsReceipts.map((g: any) => (
                      <div key={g.id} className="flex items-center justify-between gap-3 py-0.5 text-xs">
                        <span className="text-slate-600">
                          {g.grnNumber}
                          <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${g.status === 'RECEIVED' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{g.status === 'RECEIVED' ? 'Received' : 'Draft'}</span>
                          {g.receivedDate ? ` · ${fmtDate(g.receivedDate)}` : ''}
                          {g.vehicleNumber ? ` · 🚚 ${g.vehicleNumber}` : ''}
                          {g.deliveryChallanNumber ? ` · DC ${g.deliveryChallanNumber}` : ''}
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

      {utrReport && (
        <Modal title="UTR fetch from Accounts sheet" onClose={() => setUtrReport(null)} wide>
          <div className="space-y-3 text-sm">
            <div className="text-xs text-slate-500">Scanned {utrReport.sheetRowsScanned} sheet rows with a UTR.</div>
            <div>
              <div className="mb-1 font-semibold text-green-700">✓ Matched &amp; filled ({utrReport.matched?.length ?? 0})</div>
              {(utrReport.matched?.length ?? 0) === 0 ? <div className="text-xs text-slate-400">None.</div> : (
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-400"><tr><th className="py-1">Payment</th><th>Vendor</th><th className="text-right">Amount</th><th>UTR</th><th>VR No.</th><th>Matched by</th></tr></thead>
                  <tbody>
                    {utrReport.matched.map((m: any) => (
                      <tr key={m.payment} className="border-t border-slate-100">
                        <td className="py-1 font-medium text-navy">{m.payment}</td>
                        <td className="text-slate-600">{m.vendor}</td>
                        <td className="text-right">{money(m.amount)}</td>
                        <td className="font-mono text-[11px] text-slate-700">{m.utr}</td>
                        <td className="text-slate-500">{m.vrNo}</td>
                        <td><span className="badge bg-green-50 text-green-700">{m.via}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {(utrReport.docsUpdated?.length ?? 0) > 0 && (
              <div>
                <div className="mb-0.5 font-semibold text-navy">💠 Approved POs updated with sheet UTR ({utrReport.docsUpdated.length})</div>
                <div className="mb-1 text-[11px] text-slate-400">Paid via the Accounts form — the UTR now shows in each PO's pipeline (Payment card). Read-only mirror; not counted in in-app paid/pending.</div>
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-400"><tr><th className="py-1">PO/WO</th><th>Vendor</th><th className="text-right">Amount</th><th>UTR(s) · VR No.</th></tr></thead>
                  <tbody>
                    {utrReport.docsUpdated.map((d: any) => (
                      <tr key={d.docNumber} className="border-t border-slate-100 align-top">
                        <td className="py-1 font-medium text-navy">{d.docNumber}</td>
                        <td className="text-slate-600">{d.vendor}</td>
                        <td className="text-right">{money(d.amount)}</td>
                        <td>{d.utrs.map((u: any, i: number) => <div key={i} className="font-mono text-[11px] text-slate-700">{u.utr} <span className="text-slate-400">· {u.vrNo}</span></div>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(utrReport.docsAmbiguous?.length ?? 0) > 0 && (
              <div>
                <div className="mb-0.5 font-semibold text-rose-700">⛔ POs with a shared UTR — NOT applied ({utrReport.docsAmbiguous.length})</div>
                <div className="mb-1 text-[11px] text-slate-400">The same sheet UTR is on more than one PO (likely a duplicate/revised PO). Left untouched — decide manually which PO it belongs to.</div>
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-400"><tr><th className="py-1">PO/WO</th><th>Vendor</th><th className="text-right">Amount</th><th>Shared UTR · with</th></tr></thead>
                  <tbody>
                    {utrReport.docsAmbiguous.map((d: any) => (
                      <tr key={d.docNumber} className="border-t border-slate-100 align-top">
                        <td className="py-1 font-medium text-navy">{d.docNumber}</td>
                        <td className="text-slate-600">{d.vendor}</td>
                        <td className="text-right">{money(d.amount)}</td>
                        <td>{d.utrs.map((u: any, i: number) => <div key={i} className="font-mono text-[11px] text-slate-700">{u.vrNo}</div>)}<span className="text-[10px] text-rose-500">shared with {(d.sharedWith || []).join(', ')}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(utrReport.ambiguous?.length ?? 0) > 0 && (
              <div>
                <div className="mb-1 font-semibold text-amber-700">⚠ Needs manual check ({utrReport.ambiguous.length})</div>
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-400"><tr><th className="py-1">Payment</th><th>Vendor</th><th className="text-right">Amount</th><th>Why not auto-filled</th></tr></thead>
                  <tbody>
                    {utrReport.ambiguous.map((a: any) => (
                      <tr key={a.payment} className="border-t border-slate-100"><td className="py-1 font-medium text-navy">{a.payment}</td><td className="text-slate-600">{a.vendor}</td><td className="text-right">{money(a.amount)}</td><td className="text-slate-500">{a.reason}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(utrReport.skipped?.length ?? 0) > 0 && (
              <div className="text-xs text-slate-400">Skipped {utrReport.skipped.length}: {utrReport.skipped.map((s: any) => `${s.payment} (${s.reason})`).join(', ')}</div>
            )}
            <div className="flex justify-end"><button className="btn-primary text-sm" onClick={() => setUtrReport(null)}>Done</button></div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Accounts records the payment: UTR number + payment date are mandatory, an
// optional NEFT receipt can be attached (Sprint PRD §9.1). FMS auto-fetch of the
// UTR is a Phase-2 item — for now this is manual entry.
function MarkPaidModal({ projectId, docId, milestone, onClose, onDone }: { projectId: string; docId: string; milestone: any; onClose: () => void; onDone: () => void }) {
  // Pending balance for this term — the payment defaults to clearing it, but a
  // smaller amount records a part-payment (Amisha PRD A1/A3).
  const remaining = milestone.remaining != null ? milestone.remaining : milestone.inrAmount;
  const paidSoFar = milestone.amountPaid || 0;
  const [amount, setAmount] = useState(String(remaining));
  const [utrNumber, setUtr] = useState('');
  const [paymentDate, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState('');
  const [proof, setProof] = useState<File | null>(null);
  const [err, setErr] = useState('');

  const amt = Number(amount) || 0;
  const partial = amt > 0 && amt < remaining - 0.01;
  const base = `/projects/${projectId}/procurement/docs/${docId}/milestones/${milestone.id}`;
  const m = useMutation({
    mutationFn: async () => {
      await api.post(`${base}/pay`, { amount: amt, utrNumber: utrNumber.trim(), paymentDate, remarks });
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
          <div className="text-xs text-slate-500">Term {inr(milestone.inrAmount)}{milestone.triggerCondition ? ` · ${milestone.triggerCondition}` : ''}</div>
          {paidSoFar > 0 && <div className="mt-0.5 text-xs text-slate-500">Already paid {inr(paidSoFar)} · <span className="font-medium text-rose-600">Pending {inr(remaining)}</span></div>}
          {/* GST (A2): milestone amounts already follow the PO's GST rule — advance
              is charged WITHOUT GST until delivery; GST falls due on delivery. */}
          <div className="mt-1 text-[11px] text-slate-400">Amount follows the PO’s GST rule (advance is without GST until delivery).</div>
        </div>
        <div>
          <label className="label">Amount to pay *</label>
          <input className="input" type="number" step="0.01" min="0" max={remaining} required value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
            <span>Pending balance: {inr(remaining)}. Pay less for a part-payment.</span>
            {partial ? <span className="font-medium text-orange-600">Part-payment · {inr(Math.max(remaining - amt, 0))} will stay pending</span> : <button type="button" className="text-navy hover:underline" onClick={() => setAmount(String(remaining))}>Full</button>}
          </div>
        </div>
        <div><label className="label">UTR Number *</label><input className="input" required value={utrNumber} onChange={(e) => setUtr(e.target.value)} placeholder="NEFT / RTGS / IMPS reference" /></div>
        <div><label className="label">Payment Date *</label><input className="input" type="date" required value={paymentDate} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="label">Payment proof (optional)</label><input className="input text-xs" type="file" accept=".pdf,image/*" onChange={(e) => setProof(e.target.files?.[0] ?? null)} /></div>
        <div><label className="label">Remarks</label><input className="input" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={m.isPending || amt <= 0}>{m.isPending ? 'Saving…' : partial ? 'Record Part-Payment' : 'Mark Paid'}</button>
        </div>
      </form>
    </Modal>
  );
}
