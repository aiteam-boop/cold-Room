import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import { inr, fmtDate, titleize } from '../../lib/format';

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

  const { approval, payment, goodsReceipt } = data;
  const approvalState: Phase = approval.total > 0 && approval.approved >= approval.total ? 'complete' : approval.approved > 0 ? 'partial' : 'pending';
  const paymentState: Phase = payment.termsTotal === 0 ? 'pending' : payment.pendingAmount <= 0.01 ? 'complete' : payment.paidAmount > 0.01 ? 'partial' : 'pending';
  const grState: Phase = goodsReceipt.totalPoQty <= 0 ? 'pending' : goodsReceipt.remainingQty <= 0.01 && goodsReceipt.totalReceivedQty > 0 ? 'complete' : goodsReceipt.totalReceivedQty > 0 ? 'partial' : 'pending';

  return (
    <div className="space-y-3">
      {/* ── 3-step header ── */}
      <div className="flex items-center">
        <Step label="Approval" icon="📝" state={approvalState} sub={`${approval.approved}/${approval.total} signed`} />
        <Connector state={approvalState} />
        <Step label="Payment" icon="💳" state={paymentState} sub={payment.termsTotal ? `${money(payment.paidAmount)} paid` : 'no terms'} />
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
          <div className="mt-1 text-[11px] text-slate-400">{money(payment.paidAmount)} paid · <span className={payment.pendingAmount > 0.01 ? 'font-medium text-rose-600' : ''}>{money(payment.pendingAmount)} pending</span></div>
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
                      <span className="text-slate-500"> — {money(t.amountPaid)} / {money(t.inrAmount)}</span>
                      <span className={`ml-1 rounded px-1 text-[10px] ${t.status === 'PAID' ? 'bg-green-100 text-green-700' : t.status === 'PARTIALLY_PAID' ? 'bg-orange-100 text-orange-700' : t.status === 'TRIGGERED' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>{t.status === 'PARTIALLY_PAID' ? 'PARTLY PAID' : titleize(t.status)}</span>
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
