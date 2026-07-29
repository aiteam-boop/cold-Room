import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, openAuthedFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Spinner, EmptyState } from '../components/ui';
import { docStatusPill, fmtDate, inr } from '../lib/format';

interface Milestone {
  id: string; name: string; percentage: number; inrAmount: number;
  status: string; expectedDate: string | null; paymentDate: string | null; utrNumber: string | null;
}
interface RegGRN {
  id: string; grnNumber: string; grnDate: string; status: string;
  invoiceNumber: string | null; invoiceValue: number | null; invoicePdfUrl: string | null;
  acceptedQty: number; defectQty: number;
}
interface Row {
  docId: string; docNumber: string; docType: string; status: string; docDate: string;
  projectId: string; projectName: string | null;
  vendorName: string | null; finalAmount: number;
  invoicedValue: number; amountPaid: number; amountPending: number; amountDueNow: number;
  grns: RegGRN[]; milestones: Milestone[];
}
const PAY_PILL: Record<string, string> = { PAID: 'bg-green-100 text-green-700', TRIGGERED: 'bg-amber-100 text-amber-700', PENDING: 'bg-slate-100 text-slate-600' };
interface Register {
  rows: Row[];
  summary: { docs: number; totalOrdered: number; totalInvoiced: number; totalPaid: number; totalPending: number; totalDueNow: number };
}

const STATUS_PILL: Record<string, string> = {
  APPROVED: 'bg-green-100 text-green-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-700',
  DRAFT: 'bg-slate-100 text-slate-600',
  ON_HOLD: 'bg-orange-100 text-orange-700',
};

// Cross-project "master" procurement register — every project's PO/WO in one
// place, each row clickable to open that document in its own project.
export default function MasterReports() {
  const { hideFinancials } = useAuth();
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const [q, setQ] = useState('');
  const [project, setProject] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<'register' | 'vendors'>('register');

  const { data, isLoading, error } = useQuery({
    queryKey: ['master-register'],
    queryFn: async () => (await api.get('/reports/master/procurement-register')).data as Register,
  });

  const projects = useMemo(() => {
    const set = new Map<string, string>();
    (data?.rows ?? []).forEach((r) => { if (r.projectName) set.set(r.projectId, r.projectName); });
    return [...set.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) =>
      (!project || r.projectId === project) &&
      (!term || r.docNumber.toLowerCase().includes(term) || (r.vendorName || '').toLowerCase().includes(term) || (r.projectName || '').toLowerCase().includes(term)),
    );
  }, [data, q, project]);

  if (isLoading) return <Spinner label="Loading master register…" />;
  if (error) return <div className="card p-6 text-red-600">Could not load the master register.</div>;
  const s = data!.summary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Master Reports &amp; Registers</h1>
          <p className="text-sm text-slate-500">Every project's data in one place — PO → GRN → Invoice → Payment, and what each vendor is owed group-wide.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(['register', 'vendors'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`rounded px-3 py-1 font-medium ${view === v ? 'bg-white text-navy shadow-sm' : 'text-slate-500'}`}>
              {v === 'register' ? 'Procurement Register' : 'Vendor Outstanding'}
            </button>
          ))}
        </div>
      </div>

      {view === 'register' && (<>
      <div className="grid gap-3 sm:grid-cols-4">
        <KPI label="Total Ordered" value={money(s.totalOrdered)} sub={`${s.docs} documents`} />
        <KPI label="Invoiced" value={money(s.totalInvoiced)} accent="text-blue-600" />
        <KPI label="Paid" value={money(s.totalPaid)} accent="text-green-600" />
        <KPI label="Outstanding" value={money(s.totalPending)} accent="text-red-600" sub={s.totalDueNow ? `${money(s.totalDueNow)} due now` : undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="Search PO/WO, vendor, project…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-xs" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects ({projects.length})</option>
          {projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <span className="text-xs text-slate-400">{rows.length} document{rows.length === 1 ? '' : 's'}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No documents" hint="No procurement documents match your filters." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-4 py-2">Document</th><th>Project</th><th>Vendor</th><th>Date</th><th>Status</th>
                <th className="text-right">Order Value</th><th className="text-right">Invoiced</th><th className="text-right">Paid</th><th className="text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = !!open[r.docId];
                return (
                  <Fragment key={r.docId}>
                    <tr className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setOpen((c) => ({ ...c, [r.docId]: !c[r.docId] }))}>
                      <td className="px-4 py-2">
                        <span className="mr-1 inline-block w-3 text-slate-400">{isOpen ? '▼' : '▶'}</span>
                        <Link to={`/projects/${r.projectId}?open=${r.docType.toLowerCase()}:${r.docId}`} onClick={(e) => e.stopPropagation()} className="font-medium text-navy hover:underline" title="Open in its project">
                          {r.docNumber}
                        </Link>{' '}
                        <span className="badge bg-slate-100 text-slate-600">{r.docType}</span>
                      </td>
                      <td className="text-slate-600">
                        <Link to={`/projects/${r.projectId}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{r.projectName || '—'}</Link>
                      </td>
                      <td className="text-slate-600">{r.vendorName || '—'}</td>
                      <td className="text-slate-500">{fmtDate(r.docDate)}</td>
                      <td><span className={`badge ${STATUS_PILL[r.status] || 'bg-slate-100 text-slate-600'}`}>{r.status.replace(/_/g, ' ')}</span></td>
                      <td className="text-right font-medium">{money(r.finalAmount)}</td>
                      <td className="text-right text-blue-600">{r.invoicedValue ? money(r.invoicedValue) : '—'}</td>
                      <td className="text-right text-green-600">{r.amountPaid ? money(r.amountPaid) : '—'}</td>
                      <td className="text-right font-medium text-red-600">
                        {money(r.amountPending)}
                        {r.amountDueNow > 0 && <div className="text-[10px] font-normal text-amber-600">{money(r.amountDueNow)} due now</div>}
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="border-b border-slate-100 bg-slate-50/60">
                        <td colSpan={9} className="px-6 py-3">
                          <div className="grid gap-4 lg:grid-cols-2">
                            {/* Goods Receipt & Invoices */}
                            <Drill title={`Goods Receipt & Invoices (${r.grns.length})`}>
                              {r.grns.length === 0 ? <Empty>No GRN raised against this document.</Empty> : (
                                <table className="w-full text-xs">
                                  <thead className="text-left uppercase text-slate-400"><tr><th className="py-1">GRN</th><th>Date</th><th>Status</th><th>Invoice</th><th className="text-right">Value</th><th className="text-right">Accepted</th></tr></thead>
                                  <tbody>
                                    {r.grns.map((g) => (
                                      <tr key={g.id} className="border-t border-slate-200">
                                        <td className="py-1 font-medium text-navy">{g.grnNumber}</td>
                                        <td className="text-slate-500">{fmtDate(g.grnDate)}</td>
                                        <td><span className={`badge ${docStatusPill(g.status)}`}>{g.status}</span></td>
                                        <td>{g.invoiceNumber ? (g.invoicePdfUrl ? <button className="text-navy hover:underline" onClick={() => window.open(g.invoicePdfUrl!, '_blank')}>🧾 {g.invoiceNumber}</button> : <span>🧾 {g.invoiceNumber}</span>) : <span className="text-slate-400">—</span>}</td>
                                        <td className="text-right">{g.invoiceValue != null ? money(g.invoiceValue) : '—'}</td>
                                        <td className="text-right">{g.acceptedQty}{g.defectQty > 0 && <span className="ml-1 text-red-500" title="Defective">({g.defectQty} rej.)</span>}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              <div className="mt-1.5"><button className="text-xs text-navy hover:underline" onClick={() => openAuthedFile(`/projects/${r.projectId}/procurement/docs/${r.docId}/pdf`)}>📄 Open the {r.docType} PDF</button></div>
                            </Drill>

                            {/* Payment Milestones */}
                            <Drill title={`Payment Milestones (${r.milestones.length})`}>
                              {r.milestones.length === 0 ? <Empty>Milestones are generated when the document is approved.</Empty> : (
                                <table className="w-full text-xs">
                                  <thead className="text-left uppercase text-slate-400"><tr><th className="py-1">Milestone</th><th className="text-right">%</th><th className="text-right">Amount</th><th>Expected</th><th>Status</th><th>Paid / UTR</th></tr></thead>
                                  <tbody>
                                    {r.milestones.map((mm) => (
                                      <tr key={mm.id} className="border-t border-slate-200">
                                        <td className="py-1 text-slate-700">{mm.name}</td>
                                        <td className="text-right">{mm.percentage}%</td>
                                        <td className="text-right">{money(mm.inrAmount)}</td>
                                        <td className="text-slate-500">{fmtDate(mm.expectedDate)}</td>
                                        <td><span className={`badge ${PAY_PILL[mm.status] ?? 'bg-slate-100 text-slate-600'}`}>{mm.status}</span></td>
                                        <td>{mm.status === 'PAID' ? <div><div className="text-slate-600">{fmtDate(mm.paymentDate)}</div>{mm.utrNumber && <div className="text-[10px] text-slate-400">UTR {mm.utrNumber}</div>}</div> : <span className="text-slate-400">—</span>}</td>
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
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </>)}

      {view === 'vendors' && <MasterVendors money={money} />}
    </div>
  );
}

// Vendor Outstanding across ALL accessible projects — same vendor aggregated group-wide.
interface VendorRow {
  vendorId: string | null; vendorName: string; docCount: number;
  totalOrdered: number; totalPaid: number; totalOutstanding: number; dueNow: number; overdueMilestones: number;
  paymentTerms: { advance: number; beforeDelivery: number; running: number; postDelivery: number; postCompletion: number; retention: number };
  nextDue: { docNumber: string; name: string; inrAmount: number; expectedDate: string | null } | null;
}
function MasterVendors({ money }: { money: (n: number | null | undefined) => string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['master-vendor-outstanding'],
    queryFn: async () => (await api.get('/reports/master/vendor-outstanding')).data.vendors as VendorRow[],
  });
  if (isLoading || !data) return <Spinner label="Computing vendor balances…" />;
  if (data.length === 0) return <EmptyState title="No approved documents yet" hint="Vendor balances appear once a PO or WO is approved." />;
  const terms = (t: VendorRow['paymentTerms']) =>
    ([['Adv', t.advance], ['Before Dly', t.beforeDelivery], ['Running', t.running], ['Post Dly', t.postDelivery], ['Post Compl', t.postCompletion], ['Retention', t.retention]] as const)
      .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}%`).join(' · ') || '—';
  return (
    <div className="card overflow-x-auto p-0">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
          <tr>
            <th className="px-3 py-2">Vendor</th><th className="px-2 text-right">Docs</th><th className="px-2 text-right">Ordered</th>
            <th className="px-2 text-right">Paid</th><th className="px-2 text-right">Outstanding</th><th className="px-2 text-right">Due Now</th>
            <th className="px-2">Payment Terms (weighted)</th><th className="px-2">Next Due</th>
          </tr>
        </thead>
        <tbody>
          {data.map((v) => (
            <tr key={v.vendorId ?? v.vendorName} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-3 py-2 font-medium text-navy">
                {v.vendorName}
                {v.overdueMilestones > 0 && <span className="ml-2 badge bg-red-100 text-red-700">{v.overdueMilestones} overdue</span>}
              </td>
              <td className="px-2 text-right text-slate-500">{v.docCount}</td>
              <td className="px-2 text-right">{money(v.totalOrdered)}</td>
              <td className="px-2 text-right text-green-700">{money(v.totalPaid)}</td>
              <td className="px-2 text-right font-semibold text-red-600">{money(v.totalOutstanding)}</td>
              <td className="px-2 text-right">{v.dueNow ? <span className="font-medium text-amber-600">{money(v.dueNow)}</span> : '—'}</td>
              <td className="px-2 text-xs text-slate-500">{terms(v.paymentTerms)}</td>
              <td className="px-2 text-xs text-slate-500">
                {v.nextDue ? <div><div className="text-slate-700">{money(v.nextDue.inrAmount)} · {v.nextDue.name}</div><div className="text-slate-400">{v.nextDue.docNumber} · {fmtDate(v.nextDue.expectedDate)}</div></div> : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KPI({ label, value, sub, accent = 'text-navy' }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-bold ${accent}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Drill({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-2 text-center text-xs text-slate-400">{children}</div>;
}
