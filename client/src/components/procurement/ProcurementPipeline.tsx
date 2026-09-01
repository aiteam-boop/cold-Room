import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import { inr, fmtDate, titleize } from '../../lib/format';
import FmsTimeline from './FmsTimeline';

// Spread the PO's Accounts-sheet payments across its still-PENDING terms (greedy, in
// order) so each covered term SHOWS as paid-via-sheet. Display mirror only — the
// in-app records are untouched (payment was made outside the app). Keyed by term index.
function computeSheetAlloc(payment: any): { byIdx: Record<number, { paid: number; full: boolean }>; total: number } {
  const byIdx: Record<number, { paid: number; full: boolean }> = {};
  const pool = (payment?.sheetPayments || []).map((s: any) => ({ left: Number(s.amount) || 0 }));
  let total = 0;
  if (!pool.length) return { byIdx, total };
  (payment.terms || []).forEach((t: any, idx: number) => {
    // Skip terms already settled in-app; a PENDING or TRIGGERED term paid via the
    // Accounts sheet is shown paid-via-sheet here.
    if (t.status === 'PAID' || t.status === 'PARTIALLY_PAID') return;
    let need = (t.inrAmount || 0) - (t.amountPaid || 0);
    if (need <= 0.01) return;
    let paid = 0;
    for (const p of pool) { if (need <= 0.01) break; if (p.left <= 0.01) continue; const take = Math.min(p.left, need); paid += take; need -= take; p.left -= take; }
    if (paid > 0.01) { byIdx[idx] = { paid, full: need <= 0.01 }; total += paid; }
  });
  return { byIdx, total };
}

// Phase timeline for one PO/WO: Approval → Payment → Goods Receipt. Read-only,
// lazy-loaded on expand — shown in the Approvals "Approved" tab and the project
// dashboard. Mirrors the Spares-IMS style: a 3-step header + detail cards.
export default function ProcurementPipeline({ projectId, docId }: { projectId: string; docId: string }) {
  const { hideFinancials } = useAuth();
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const { data, isLoading, isError } = useQuery({
    queryKey: ['pipeline', projectId, docId],
    queryFn: async () => (await api.get(`/projects/${projectId}/procurement/docs/${docId}/pipeline`)).data.pipeline as any,
  });

  if (isLoading) return <div className="py-6"><Spinner label="Loading pipeline…" /></div>;
  if (isError || !data) return <div className="py-4 text-sm text-slate-400">Could not load the pipeline for this document.</div>;

  const { doc, approval, payment, goodsReceipt } = data;
  // Fold Accounts-sheet payments into the paid/pending shown here (display only).
  const sheetAlloc = computeSheetAlloc(payment);
  const effPaid = (payment.paidAmount || 0) + sheetAlloc.total;
  const effPending = Math.max((payment.pendingAmount || 0) - sheetAlloc.total, 0);
  const approvalState: Phase = approval.total > 0 && approval.approved >= approval.total ? 'complete' : approval.approved > 0 ? 'partial' : 'pending';
  const paymentState: Phase = payment.termsTotal === 0 ? 'pending' : effPending <= 0.01 ? 'complete' : effPaid > 0.01 ? 'partial' : 'pending';
  const grState: Phase = goodsReceipt.totalPoQty <= 0 ? 'pending' : goodsReceipt.remainingQty <= 0.01 && goodsReceipt.totalReceivedQty > 0 ? 'complete' : goodsReceipt.totalReceivedQty > 0 ? 'partial' : 'pending';

  return (
    <div className="space-y-3">
      {/* ── 3-step header ── */}
      <div className="flex items-center">
        <Step label="Approval" icon="📝" state={approvalState} sub={`${approval.approved}/${approval.total} signed`} />
        <Connector state={approvalState} />
        <Step label="Payment" icon="💳" state={paymentState} sub={payment.termsTotal ? `${money(effPaid)} paid` : 'no terms'} />
        <Connector state={paymentState} />
        <Step label="Goods Receipt" icon="📦" state={grState} sub={goodsReceipt.count ? `${goodsReceipt.totalReceivedQty}/${goodsReceipt.totalPoQty} qty` : 'none yet'} last />
      </div>

      {/* ── detail cards ── */}
      <div className="grid gap-3 md:grid-cols-3">
        {/* Approval */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <CardHead title="Approval" state={approvalState} />
          <div className="mt-1 text-[11px] text-slate-400">{approval.approved} of {approval.total} stages approved</div>
          {approval.steps.length === 0 ? (
            <div className="mt-2 text-xs text-slate-400">No approval chain.</div>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {approval.steps.map((s: any) => (
                <li key={s.order} className="text-xs">
                  <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${s.status === 'APPROVED' ? 'bg-green-500' : s.status === 'PENDING' ? 'bg-amber-500' : s.status === 'ON_HOLD' ? 'bg-orange-500' : 'bg-slate-300'}`} />
                  <span className="font-medium text-slate-700">{s.name}</span>
                  {s.role && <span className="text-slate-400"> · {s.role}</span>}
                  <span className={`ml-1 ${s.status === 'APPROVED' ? 'text-green-600' : s.status === 'PENDING' ? 'text-amber-600' : 'text-slate-400'}`}>{titleize(s.status)}</span>
                  {s.actedAt && <div className="ml-3.5 text-[10px] text-slate-400">{fmtDate(s.actedAt)}{s.remarks ? ` · ${s.remarks}` : ''}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Payment */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <CardHead title="Payment" state={paymentState} />
          {/* What the payment terms are calculated on — GST-inclusive or basic —
              mirroring the PO's "Payment amount includes" choice. */}
          {doc?.gstEnabled && (
            <div className="mt-1 text-[11px] text-slate-500">
              Payment amount includes:{' '}
              {doc.payGstInclusive
                ? <span>GST ({doc.gstPct ?? 18}% inclusive) — <span className="font-medium text-slate-700">{money(doc.finalAmount)}</span></span>
                : <span>Basic only — <span className="font-medium text-slate-700">{money(doc.basicAmount)}</span></span>}
            </div>
          )}
          <div className="mt-1 text-[11px] text-slate-400">{money(effPaid)} paid · <span className={effPending > 0.01 ? 'font-medium text-rose-600' : ''}>{money(effPending)} pending</span></div>
          {payment.terms.length === 0 ? (
            <div className="mt-2 text-xs text-slate-400">No payment terms.</div>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {payment.terms.map((t: any, i: number) => {
                const partial = t.remaining > 0.01 && t.amountPaid > 0.01;
                const pctLeft = t.inrAmount > 0 ? Math.round((t.remaining / t.inrAmount) * 1000) / 10 : 0;
                return (
                  <li key={i} className="text-xs">
                    <div>
                      <span className="font-medium text-slate-700">{t.name}</span>
                      {t.percentage ? <span className="text-slate-400"> ({t.percentage}%)</span> : null}
                      <span className="text-slate-500"> — {money(t.amountPaid + (sheetAlloc.byIdx[i]?.paid || 0))} / {money(t.inrAmount)}</span>
                      {sheetAlloc.byIdx[i]
                        ? <span className="ml-1 rounded bg-green-100 px-1 text-[10px] text-green-700">✓ PAID{sheetAlloc.byIdx[i].full ? '' : ' (PART)'} · sheet</span>
                        : <span className={`ml-1 rounded px-1 text-[10px] ${t.status === 'PAID' ? 'bg-green-100 text-green-700' : t.status === 'PARTIALLY_PAID' ? 'bg-orange-100 text-orange-700' : t.status === 'TRIGGERED' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{t.status === 'PARTIALLY_PAID' ? 'PARTLY PAID' : titleize(t.status)}</span>}
                    </div>
                    {partial && <div className="text-[11px] font-medium text-rose-600">{money(t.remaining)} remaining ({pctLeft}% of this term left)</div>}
                    {/* Payment record(s) raised for this term: number, trigger date, release decision. */}
                    {(t.payments ?? []).map((p: any) => (
                      <div key={p.grnNumber} className="text-[10px] text-slate-500">
                        <span className="font-medium text-navy">{p.grnNumber}</span>
                        {t.triggeredAt && <span className="text-slate-400"> · triggered {fmtDate(t.triggeredAt)}</span>}
                        {p.releaseStatus === 'APPROVED' ? <span className="ml-1 font-medium text-green-600">✓ Approved{p.releaseAt ? ` · ${fmtDate(p.releaseAt)}` : ''}</span>
                          : p.releaseStatus === 'ON_HOLD' ? <span className="ml-1 font-medium text-orange-600">⏸ On Hold</span>
                          : p.releaseStatus === 'RESUBMITTED' ? <span className="ml-1 font-medium text-blue-600">↻ Re-submitted</span>
                          : <span className="ml-1 text-slate-400">approval pending</span>}
                        {p.utrNumber && <span className="ml-1 text-slate-500">· UTR: <span className="font-medium text-slate-700">{p.utrNumber}</span>{p.paidAt ? ` (${fmtDate(p.paidAt)})` : ''}</span>}
                      </div>
                    ))}
                    {(t.installments ?? []).length > 0 && <div className="text-[10px] text-slate-400">{t.installments.map((x: any) => `${money(x.amount)}${x.utrNumber ? ` (${x.utrNumber})` : ''}`).join(' · ')}</div>}
                  </li>
                );
              })}
            </ul>
          )}
          {/* UTR(s) backfilled from the Accounts sheet for POs paid via the form
              before the in-app flow. Read-only — not part of paid/pending above. */}
          {(payment.sheetPayments?.length ?? 0) > 0 && (
            <div className="mt-2 rounded border border-emerald-200 bg-emerald-50/70 p-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">✓ Paid via Accounts sheet</div>
                <div className="text-[11px] font-semibold text-emerald-700">{money(payment.sheetPayments.reduce((s: number, x: any) => s + (Number(x.amount) || 0), 0))}</div>
              </div>
              {payment.sheetPayments.map((s: any, i: number) => (
                <div key={i} className="mt-0.5 text-[11px] text-slate-600">
                  <span className="text-slate-400">UTR:</span> <span className="font-mono font-medium text-slate-700">{s.utr}</span>
                  {s.vrNo && <span className="text-slate-400"> · {s.vrNo}</span>}
                  {s.amount != null && <span className="text-slate-500"> · {money(s.amount)}</span>}
                </div>
              ))}
              <div className="mt-0.5 text-[9px] text-slate-400">Paid outside the app via the FMS Accounts form — not counted in the in-app paid/pending above.</div>
            </div>
          )}

          {/* Payment progress timeline — shown once there's a payment in motion (any
              amount paid in-app, a sheet payment, or a matched FMS row). In-app stages
              go green from the PO's approval; the last three (AP → Alok → Finance) fill
              in from the FMS sheet as Accounts processes it, else read "pending". */}
          {(payment.fmsStages || payment.paidAmount > 0 || (payment.sheetPayments?.length ?? 0) > 0) && (() => {
            // A UTR / VR (from the Accounts sheet or an in-app term) means it's paid —
            // so the whole Accounts timeline is complete even without the stage row.
            const sp: any[] = payment.sheetPayments ?? [];
            const spVr = sp.find((x) => x.vrNo)?.vrNo ?? null;
            const spUtr = sp.find((x) => x.utr)?.utr ?? null;
            const termUtr = (payment.terms ?? []).find((t: any) => t.utrNumber)?.utrNumber ?? null;
            const isPaid = Boolean(spVr || spUtr || termUtr) || (payment.pendingAmount <= 0.01 && payment.paidAmount > 0);
            return (
            <div className="mt-2 rounded border border-blue-200 bg-blue-50/50 p-2.5">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">Payment progress (Accounts / FMS)</div>
              <FmsTimeline
                fmsStages={payment.fmsStages ?? null}
                approved={approval.approved >= approval.total && approval.total > 0}
                paid={isPaid}
                vrNo={spVr}
                utr={spUtr || termUtr}
              />
              <div className="mt-1 text-[9px] text-slate-400">Live from the Accounts (FMS) sheet — where this bill stands after CRMCTS approval.</div>
            </div>
            );
          })()}
        </div>

        {/* Goods Receipt */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <CardHead title="Goods Receipt (GRN)" state={grState} />
          <div className="mt-1 text-[11px] text-slate-400">
            {goodsReceipt.count} GRN{goodsReceipt.count === 1 ? '' : 's'} · received {goodsReceipt.totalReceivedQty} of {goodsReceipt.totalPoQty}
            {goodsReceipt.remainingQty > 0.01 && <span className="font-medium text-rose-600"> · {goodsReceipt.remainingQty} remaining</span>}
          </div>
          {goodsReceipt.receipts.length === 0 ? (
            <div className="mt-2 text-xs text-slate-400">No goods receipts yet.</div>
          ) : (
            <ul className="mt-2 space-y-1">
              {goodsReceipt.receipts.map((r: any) => (
                <li key={r.grnNumber} className="flex items-center justify-between text-xs">
                  <span><span className="font-medium text-slate-700">{r.grnNumber}</span> <span className={`ml-1 rounded px-1 text-[10px] ${r.status === 'RECEIVED' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{titleize(r.status)}</span></span>
                  <span className="text-slate-400">{r.receivedQty} qty · {fmtDate(r.receivedDate)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

type Phase = 'complete' | 'partial' | 'pending';
const DOT: Record<Phase, string> = { complete: 'bg-green-500 text-white', partial: 'bg-amber-400 text-white', pending: 'bg-slate-200 text-slate-400' };
const PILL: Record<Phase, string> = { complete: 'bg-green-100 text-green-700', partial: 'bg-amber-100 text-amber-700', pending: 'bg-slate-100 text-slate-500' };
const PILL_LABEL: Record<Phase, string> = { complete: 'COMPLETE', partial: 'PARTIAL', pending: 'PENDING' };

function Step({ label, icon, state, sub, last }: { label: string; icon: string; state: Phase; sub: string; last?: boolean }) {
  return (
    <div className={`flex flex-col items-center text-center ${last ? '' : 'shrink-0'}`} style={{ minWidth: 96 }}>
      <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm ${DOT[state]}`}>{icon}</div>
      <div className="mt-1 text-[11px] font-semibold text-slate-600">{label}</div>
      <span className={`mt-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold ${PILL[state]}`}>{PILL_LABEL[state]}</span>
      <div className="mt-0.5 text-[10px] text-slate-400">{sub}</div>
    </div>
  );
}
function Connector({ state }: { state: Phase }) {
  return <div className={`mb-8 h-0.5 flex-1 ${state === 'complete' ? 'bg-green-400' : state === 'partial' ? 'bg-amber-300' : 'bg-slate-200'}`} />;
}
function CardHead({ title, state }: { title: string; state: Phase }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-sm font-semibold text-slate-700">{title}</div>
      <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${PILL[state]}`}>{PILL_LABEL[state]}</span>
    </div>
  );
}

