// Reports & Registers.
//
// AA sir (transcript P18/P19): "Ye khali pure register hai… Report section mein
// tumhare sab aa jayenge — ki uske against kya PO hua, phir uske baad payment hua,
// kya diya… vendor koi paisa baaki hai kya, uske advance terms kya hai?"
//
// So the PO / WO / GRN screens stay flat registers. The drill-down lives here:
// one expandable row per PO, unfolding into its GRNs, invoices and payment
// milestones — plus a vendor-level "what do we still owe, and on what terms".

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Spinner } from '../ui';
import { docStatusPill, fmtDate, inr } from '../../lib/format';
import { DeliveryPill, type Delivery } from '../DeliveryBadge';

interface Milestone {
  id: string; name: string; fieldKey: string; percentage: number; inrAmount: number;
  status: string; expectedDate: string | null; paymentDate: string | null; utrNumber: string | null;
  punctuality: string; punctualityDelayDays: number | null;
}
interface RegGRN {
  id: string; grnNumber: string; grnDate: string; status: string;
  invoiceNumber: string | null; invoiceDate: string | null; invoiceValue: number | null;
  invoicePdfUrl: string | null; acceptedQty: number; defectQty: number;
}
interface Row {
  docId: string; docNumber: string; docType: string; status: string; docDate: string;
  vendorName: string | null; basicAmount: number; finalAmount: number;
  delivery: Delivery; grns: RegGRN[]; invoicedValue: number;
  milestones: Milestone[]; amountPaid: number; amountPending: number; amountDueNow: number; overdueMilestones: number;
}
interface Register {
  rows: Row[];
  summary: {
    docs: number; totalOrdered: number; totalInvoiced: number; totalPaid: number;
    totalPending: number; totalDueNow: number; docsWithoutDeliveryDate: number;
    onTimeDelivery: { pct: number | null; onTime: number; measured: number };
    onTimePayment: { pct: number | null; onTime: number; measured: number };
  };
}
interface VendorRow {
  vendorId: string | null; vendorName: string; docCount: number;
  totalOrdered: number; totalPaid: number; totalOutstanding: number; dueNow: number; overdueMilestones: number;
  paymentTerms: { advance: number; beforeDelivery: number; running: number; postDelivery: number; postCompletion: number; retention: number };
  onTimeDelivery: { pct: number | null; onTime: number; measured: number };
  nextDue: { docNumber: string; name: string; inrAmount: number; expectedDate: string | null } | null;
}

const PAY_PILL: Record<string, string> = {
  PAID: 'bg-green-100 text-green-700',
  TRIGGERED: 'bg-amber-100 text-amber-700',
  PENDING: 'bg-slate-100 text-slate-600',
};
const PUNCT_PILL: Record<string, string> = {
  ON_TIME: 'bg-green-100 text-green-700',
  LATE: 'bg-red-100 text-red-700',
  OVERDUE: 'bg-red-100 text-red-700',
  PENDING: 'bg-slate-100 text-slate-500',
  UNKNOWN: 'bg-slate-100 text-slate-400',
};

const pct = (p: number | null) => (p == null ? '—' : `${Math.round(p * 100)}%`);

export default function ReportsTab({ projectId }: { projectId: string }) {
  const { hideFinancials } = useAuth();
  const [view, setView] = useState<'register' | 'vendors'>('register');

  if (hideFinancials) {
    return <EmptyState title="Reports are hidden for your role" hint="The procurement register is built entirely from ₹ amounts, so it is not shown to users with financial data hidden." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-navy">Reports &amp; Registers</h2>
          <p className="text-xs text-slate-400">PO → GRN → Invoice → Payment, and what each vendor is still owed.</p>
        </div>
        <div className="flex overflow-hidden rounded-lg border border-slate-200">
          {(['register', 'vendors'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 text-xs font-semibold ${view === v ? 'bg-navy text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
              {v === 'register' ? 'Procurement Register' : 'Vendor Outstanding'}
            </button>
          ))}
        </div>
      </div>

      {view === 'register' ? <RegisterView projectId={projectId} /> : <VendorsView projectId={projectId} />}
    </div>
  );
}

function RegisterView({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { data, isLoading } = useQuery({
    queryKey: ['proc-register', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/reports/procurement-register`)).data as Register,
  });

  if (isLoading || !data) return <Spinner label="Building the register…" />;
  if (data.rows.length === 0) return <EmptyState title="No purchase orders yet" hint="Raise a PO or WO and it will appear here with its GRNs, invoices and payments." />;

  const s = data.summary;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPI label="Total Ordered" value={inr(s.totalOrdered)} sub={`${s.docs} documents`} />
        <KPI label="Paid" value={inr(s.totalPaid)} accent="#16a34a" />
        <KPI label="Outstanding" value={inr(s.totalPending)} accent="#dc2626" sub={s.totalDueNow ? `${inr(s.totalDueNow)} due now` : undefined} />
        <KPI
          label="On-time Delivery"
          value={pct(s.onTimeDelivery.pct)}
          sub={s.onTimeDelivery.measured ? `${s.onTimeDelivery.onTime} of ${s.onTimeDelivery.measured} measured` : 'nothing measurable yet'}
        />
      </div>

      {s.docsWithoutDeliveryDate > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {s.docsWithoutDeliveryDate} approved document{s.docsWithoutDeliveryDate === 1 ? ' has' : 's have'} no promised delivery date, so they are
          excluded from the on-time figure. Set it on the PO’s <strong>Delivery Schedule</strong>.
        </div>
      )}

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1050px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2">Document</th>
                <th className="px-2">Vendor</th>
                <th className="px-2">Date</th>
                <th className="px-2">Status</th>
                <th className="px-2 text-right">Order Value</th>
                <th className="px-2 text-right">Invoiced</th>
                <th className="px-2 text-right">Paid</th>
                <th className="px-2 text-right">Outstanding</th>
                <th className="px-2">Delivery</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const isOpen = !!open[r.docId];
                return (
                  <FragmentRow key={r.docId}>
                    <tr className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setOpen((c) => ({ ...c, [r.docId]: !c[r.docId] }))}>
                      <td className="px-3 py-2 font-medium text-navy">
                        <span className="mr-1.5 inline-block w-3 text-slate-400">{isOpen ? '▼' : '▶'}</span>
                        {r.docNumber}
                        <span className="ml-1.5 badge bg-slate-100 text-slate-600">{r.docType}</span>
                      </td>
                      <td className="px-2 text-slate-600">{r.vendorName || '—'}</td>
                      <td className="px-2 text-slate-500">{fmtDate(r.docDate)}</td>
                      <td className="px-2"><span className={`badge ${docStatusPill(r.status)}`}>{r.status}</span></td>
                      <td className="px-2 text-right font-medium">{inr(r.finalAmount)}</td>
                      <td className="px-2 text-right">{r.invoicedValue ? inr(r.invoicedValue) : '—'}</td>
                      <td className="px-2 text-right text-green-700">{r.amountPaid ? inr(r.amountPaid) : '—'}</td>
                      <td className="px-2 text-right">
                        {inr(r.amountPending)}
                        {r.amountDueNow > 0 && <div className="text-[11px] font-medium text-amber-600">{inr(r.amountDueNow)} due now</div>}
                      </td>
                      <td className="px-2"><DeliveryPill delivery={r.delivery} /></td>
                    </tr>

                    {isOpen && (
                      <tr className="border-b border-slate-100 bg-slate-50/60">
                        <td colSpan={9} className="px-6 py-3">
                          <div className="grid gap-4 lg:grid-cols-2">
                            <Drill title={`Goods Receipt & Invoices (${r.grns.length})`}>
                              {r.grns.length === 0 ? <Empty>No GRN raised against this document.</Empty> : (
                                <table className="w-full text-xs">
                                  <thead className="text-left uppercase text-slate-400">
                                    <tr><th className="py-1">GRN</th><th>Date</th><th>Status</th><th>Invoice</th><th className="text-right">Value</th><th className="text-right">Accepted</th></tr>
                                  </thead>
                                  <tbody>
                                    {r.grns.map((g) => (
                                      <tr key={g.id} className="border-t border-slate-200">
                                        <td className="py-1 font-medium text-navy">{g.grnNumber}</td>
                                        <td className="text-slate-500">{fmtDate(g.grnDate)}</td>
                                        <td><span className={`badge ${docStatusPill(g.status)}`}>{g.status}</span></td>
                                        <td>
                                          {g.invoiceNumber ? (
                                            g.invoicePdfUrl
                                              ? <button className="text-navy hover:underline" onClick={() => window.open(g.invoicePdfUrl!, '_blank')}>🧾 {g.invoiceNumber}</button>
                                              : <span>🧾 {g.invoiceNumber}</span>
                                          ) : <span className="text-slate-400">—</span>}
                                        </td>
                                        <td className="text-right">{g.invoiceValue != null ? inr(g.invoiceValue) : '—'}</td>
                                        <td className="text-right">
                                          {g.acceptedQty}
                                          {g.defectQty > 0 && <span className="ml-1 text-red-500" title="Defective quantity">({g.defectQty} rej.)</span>}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              <div className="mt-1.5">
                                <button className="text-xs text-navy hover:underline" onClick={() => openAuthedFile(`/projects/${projectId}/procurement/docs/${r.docId}/pdf`)}>
                                  📄 Open the {r.docType} PDF
                                </button>
                              </div>
                            </Drill>

                            <Drill title={`Payment Milestones (${r.milestones.length})`}>
                              {r.milestones.length === 0 ? <Empty>Milestones are generated when the document is approved.</Empty> : (
                                <table className="w-full text-xs">
                                  <thead className="text-left uppercase text-slate-400">
                                    <tr><th className="py-1">Milestone</th><th className="text-right">%</th><th className="text-right">Amount</th><th>Expected</th><th>Status</th><th>Paid / UTR</th></tr>
                                  </thead>
                                  <tbody>
                                    {r.milestones.map((m) => (
                                      <tr key={m.id} className="border-t border-slate-200">
                                        <td className="py-1 text-slate-700">{m.name}</td>
                                        <td className="text-right">{m.percentage}%</td>
                                        <td className="text-right">{inr(m.inrAmount)}</td>
                                        <td className="text-slate-500">{fmtDate(m.expectedDate)}</td>
                                        <td><span className={`badge ${PAY_PILL[m.status] ?? 'bg-slate-100'}`}>{m.status}</span></td>
                                        <td>
                                          {m.status === 'PAID' ? (
                                            <div>
                                              <div className="text-slate-600">{fmtDate(m.paymentDate)}</div>
                                              {m.utrNumber && <div className="text-[10px] text-slate-400">UTR {m.utrNumber}</div>}
                                            </div>
                                          ) : <span className="text-slate-400">—</span>}
                                          {m.punctuality !== 'UNKNOWN' && m.punctuality !== 'PENDING' && (
                                            <span className={`badge mt-0.5 ${PUNCT_PILL[m.punctuality]}`}>
                                              {m.punctuality === 'ON_TIME' ? 'On time' : m.punctuality === 'LATE' ? `Late +${m.punctualityDelayDays}d` : `Overdue +${m.punctualityDelayDays}d`}
                                            </span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </Drill>
                          </div>
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function VendorsView({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['vendor-outstanding', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/reports/vendor-outstanding`)).data.vendors as VendorRow[],
  });

  if (isLoading || !data) return <Spinner label="Computing vendor balances…" />;
  if (data.length === 0) return <EmptyState title="No approved documents yet" hint="Vendor balances appear once a PO or WO is approved." />;

  const terms = (t: VendorRow['paymentTerms']) =>
    ([['Adv', t.advance], ['Before Dly', t.beforeDelivery], ['Running', t.running], ['Post Dly', t.postDelivery], ['Post Compl', t.postCompletion], ['Retention', t.retention]] as const)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${v}%`)
      .join(' · ') || '—';

  return (
    <div className="card overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-2 text-right">Docs</th>
              <th className="px-2 text-right">Ordered</th>
              <th className="px-2 text-right">Paid</th>
              <th className="px-2 text-right">Outstanding</th>
              <th className="px-2 text-right">Due Now</th>
              <th className="px-2">Payment Terms (weighted)</th>
              <th className="px-2">Next Due</th>
              <th className="px-2 text-right">On-time Dly</th>
            </tr>
          </thead>
          <tbody>
            {data.map((v) => (
              <tr key={v.vendorId ?? v.vendorName} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2 font-medium text-navy">
                  {v.vendorName}
                  {v.overdueMilestones > 0 && (
                    <span className="ml-2 badge bg-red-100 text-red-700">{v.overdueMilestones} overdue</span>
                  )}
                </td>
                <td className="px-2 text-right text-slate-500">{v.docCount}</td>
                <td className="px-2 text-right">{inr(v.totalOrdered)}</td>
                <td className="px-2 text-right text-green-700">{inr(v.totalPaid)}</td>
                <td className="px-2 text-right font-semibold text-red-600">{inr(v.totalOutstanding)}</td>
                <td className="px-2 text-right">{v.dueNow ? <span className="font-medium text-amber-600">{inr(v.dueNow)}</span> : '—'}</td>
                <td className="px-2 text-xs text-slate-500">{terms(v.paymentTerms)}</td>
                <td className="px-2 text-xs text-slate-500">
                  {v.nextDue ? (
                    <div>
                      <div className="text-slate-700">{inr(v.nextDue.inrAmount)} · {v.nextDue.name}</div>
                      <div className="text-slate-400">{v.nextDue.docNumber} · {fmtDate(v.nextDue.expectedDate)}</div>
                    </div>
                  ) : '—'}
                </td>
                <td className="px-2 text-right">{pct(v.onTimeDelivery.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Drill({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="rounded-lg border border-slate-200 bg-white p-2.5">{children}</div>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-center text-xs text-slate-400">{children}</div>;
}
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
