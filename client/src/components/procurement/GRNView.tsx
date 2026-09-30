import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { docStatusPill, fmtDate, inr, titleize } from '../../lib/format';
import ApprovalTimeline from './ApprovalTimeline';
import ChainBuilder from './ChainBuilder';
import FmsTimeline from './FmsTimeline';

// Parse a money field the user may have typed WITH commas (e.g. "55,401" — Indian
// formatting). Plain Number("55,401") is NaN → saved as null; strip commas first.
// Returns null for empty/invalid so a blank field clears rather than saving NaN.
const toNum = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

export default function GRNView({ projectId, focusId }: { projectId: string; role: string; focusId?: string }) {
  const qc = useQueryClient();
  const { canEdit, can } = useAuth();
  const canRaise = canEdit('grn');
  const canApprove = can('canApprove');
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [raising, setRaising] = useState(false);
  // Payments list vs the Invoices tab (payments still awaiting their tax invoice).
  const [listTab, setListTab] = useState<'payments' | 'invoices'>('payments');
  // When a payment is opened from the Invoices tab, the form shows the Tax Invoice
  // block so the invoice is filled in right there on the page.
  const [openForInvoice, setOpenForInvoice] = useState(false);

  const grnsQ = useQuery({ queryKey: ['grns', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/grns`)).data.grns as any[] });
  // Dedicated endpoint gated on the GRN page (not pay/po/wo) and carrying no
  // rupee values — a site engineer with only the GRN grant can still pick a PO.
  const posQ = useQuery({ queryKey: ['grn-available-docs', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/grns/available-docs`)).data.docs as any[] });

  const raise = useMutation({
    mutationFn: (docId: string) => api.post(`/projects/${projectId}/procurement/grns`, { docId }),
    onSuccess: (r) => { setRaising(false); qc.invalidateQueries({ queryKey: ['grns', projectId] }); setOpenId(r.data.grn.id); },
    onError: (e) => alert(errMsg(e)),
  });
  // Draft GRNs can be deleted; approved/submitted ones are records.
  const delGrn = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/procurement/grns/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['grns', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (openId) return <GRNForm projectId={projectId} grnId={openId} canApprove={canApprove} showTaxInvoice={openForInvoice} onClose={() => { setOpenId(null); setOpenForInvoice(false); qc.invalidateQueries({ queryKey: ['grns', projectId] }); }} />;
  if (grnsQ.isLoading) return <Spinner label="Loading GRNs…" />;
  const grns = grnsQ.data ?? [];
  // Payments needing invoice ACTION — either the tax invoice isn't uploaded yet,
  // OR it's uploaded but its approval isn't done (so it can be submitted / reviewed
  // here). A payment drops off once its invoice is APPROVED.
  const invoicePending = grns.filter((g) => {
    if (!(g.milestoneId || g.piValue != null)) return false;
    const hasInvoice = !!(g.invoiceNumber || g.invoiceValue != null || g.invoicePdfUrl);
    return !hasInvoice || (!!g.invoicePdfUrl && g.invoiceReleaseStatus !== 'APPROVED');
  });
  // The FULL invoice list — every PAID payment (pending AND already-approved), so an
  // approved invoice stays visible here to view / re-fill. The badge counts only the
  // pending ones (invoicePending); the list itself shows all.
  const invoiceAll = grns.filter((g) => (g.milestoneId || g.piValue != null)
    && (g.paymentStatus === 'PAID' || g.paymentStatus === 'CLOSED' || g.invoicePdfUrl || g.invoiceNumber || g.invoiceValue != null))
    // Pending (needs upload / approval) on TOP; already-approved invoices at the BOTTOM.
    .sort((a, b) => (a.invoiceReleaseStatus === 'APPROVED' ? 1 : 0) - (b.invoiceReleaseStatus === 'APPROVED' ? 1 : 0));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          <button onClick={() => setListTab('payments')} className={`rounded-md px-3 py-1 font-medium ${listTab === 'payments' ? 'bg-navy text-white' : 'text-slate-500 hover:text-slate-700'}`}>Payments ({grns.length})</button>
          {/* Invoices tab: every payment still waiting for its tax invoice, with the count. */}
          <button onClick={() => setListTab('invoices')} className={`rounded-md px-3 py-1 font-medium ${listTab === 'invoices' ? 'bg-navy text-white' : 'text-slate-500 hover:text-slate-700'}`}>
            Invoices{invoicePending.length ? <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${listTab === 'invoices' ? 'bg-white/25 text-white' : 'bg-orange-100 text-orange-700'}`}>{invoicePending.length}</span> : ''}
          </button>
        </div>
        {canRaise && listTab === 'payments' && <button className="btn-primary text-sm" onClick={() => setRaising(true)}>+ New Payment</button>}
      </div>

      {raising && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-medium text-slate-600">New payment against an approved PO/WO</div>
          {posQ.data?.length ? (
            <div className="space-y-2">
              {/* No PO value here by design — the engineer sees items and quantities,
                  never the commercial amount (Sprint PRD §7.2). */}
              {posQ.data.map((d: any) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-2 text-sm">
                  <span>
                    <span className="font-medium text-navy">{d.docNumber}</span>
                    <span className="badge ml-1 bg-slate-100 text-slate-600">{d.type}</span>
                    <span className="text-slate-500"> · {d.vendorName || '—'}</span>
                    {d.grnCount > 0 && <span className="text-xs text-slate-400"> · {d.grnCount} GRN{d.grnCount > 1 ? 's' : ''} already raised</span>}
                  </span>
                  <button className="btn-outline text-xs" onClick={() => raise.mutate(d.id)}>Select</button>
                </div>
              ))}
            </div>
          ) : <div className="text-sm text-slate-400">No approved POs/WOs to receive against.</div>}
          <button className="btn-outline mt-2 text-xs" onClick={() => setRaising(false)}>Cancel</button>
        </div>
      )}

      {listTab === 'invoices' ? (
        <InvoicesPanel grns={invoiceAll} pendingCount={invoicePending.length} onOpenInvoice={(id) => { setOpenId(id); setOpenForInvoice(true); }} />
      ) : grns.length === 0 ? (
        <EmptyState title="No payments yet" hint="Raise a payment against an approved PO/WO — pick the payment term, upload the PI, and send it for approval. Physical delivery is recorded separately on the Goods Receipt (GRN) page." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">Payment No.</th><th>Against</th><th>Vendor</th><th>Raised by</th><th>Date</th><th className="text-right">PI Value</th><th className="pr-8 text-right">Invoice Value</th><th className="pl-2">Status</th><th></th></tr></thead>
            <tbody>
              {grns.map((g) => (
                <tr key={g.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-navy">{g.grnNumber}</td>
                  <td className="text-slate-600">{g.doc?.docNumber}</td>
                  <td className="text-slate-600">{g.vendorName}</td>
                  {/* Who raised it — the email, so it is obvious who to go back to. */}
                  <td className="text-slate-500">
                    {g.createdBy
                      ? <span title={g.createdBy.name} className="text-xs">{g.createdBy.email}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="text-slate-500">{fmtDate(g.grnDate)}</td>
                  {/* PI value drives the payment (arrives first); the invoice value
                      is the engineer's own transcription of the vendor tax invoice,
                      not PO pricing — everyone on the GRN sees both. */}
                  <td className="text-right">{g.piValue != null ? inr(g.piValue) : '—'}</td>
                  <td className="pr-8 text-right">{g.invoiceValue != null ? inr(g.invoiceValue) : '—'}</td>
                  {/* A payment GRN is paid on the PI; the tax invoice arrives later and
                      closes it — so flag the ones still waiting for it (§6). */}
                  <td className="pl-2">
                    {/* No approval step for payments — a submitted payment shows its
                        lifecycle (Triggered → Paid → Closed), never "Approved". */}
                    {g.paymentStatus
                      ? <span className={`badge ${g.paymentStatus === 'TRIGGERED' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{g.paymentStatus === 'TRIGGERED' ? 'Triggered' : g.paymentStatus === 'PAID' ? 'Paid' : 'Closed'}</span>
                      : <span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>}
                    {/* Management release decision from the FMS "Approval Form" link,
                        shown right next to the payment status (Approved / On Hold). */}
                    {g.releaseStatus
                      ? <span className={`badge ml-1 ${g.releaseStatus === 'APPROVED' ? 'bg-green-100 text-green-700' : g.releaseStatus === 'RESUBMITTED' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>{g.releaseStatus === 'APPROVED' ? '✓ Approved' : g.releaseStatus === 'RESUBMITTED' ? '↻ Re-submitted' : '⏸ On Hold'}</span>
                      : g.status === 'APPROVED' && (g.milestoneId || g.piValue != null) && <span className="badge ml-1 bg-amber-100 text-amber-700">⏳ Awaiting approval</span>}
                    {(g.milestoneId || g.piValue != null) && !(g.invoiceNumber || g.invoiceValue != null || g.invoicePdfUrl) && (
                      <div className="mt-0.5 text-[10px] leading-tight text-orange-600">tax invoice pending</div>
                    )}
                  </td>
                  <td className="px-2 text-right">
                    {canRaise && g.status === 'DRAFT' && <button className="mr-3 text-xs font-medium text-rose-500 hover:underline" onClick={() => confirm(`Delete draft ${g.grnNumber}? This can't be undone.`) && delGrn.mutate(g.id)}>Delete</button>}
                    <button className="text-xs font-medium text-navy hover:underline" onClick={() => setOpenId(g.id)}>Open →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}

// The "Invoices" tab — every payment still waiting for its tax invoice. Opening
// one goes to its payment page with the Tax Invoice block shown, where the
// invoice is filled in and uploaded (the block is hidden on the normal view).
function InvoicesPanel({ grns, pendingCount, onOpenInvoice }: { grns: any[]; pendingCount: number; onOpenInvoice: (id: string) => void }) {
  if (grns.length === 0) {
    return <EmptyState title="No invoices yet" hint="Paid payments show here — pending ones to upload / approve, and already-approved invoices to view or re-fill." />;
  }
  return (
    <div className="card overflow-hidden">
      <div className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500">{grns.length} payment{grns.length > 1 ? 's' : ''} — tax invoices{pendingCount ? ` · ${pendingCount} pending` : ' · all done'}.</div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">Payment No.</th><th>Against</th><th>Vendor</th><th>Date</th><th className="text-right">PI Value</th><th className="text-right">Invoice Value</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {grns.map((g) => {
            // What this payment needs on the invoice side:
            // 'upload'   — no tax invoice PDF yet.
            // 'ready'    — invoice uploaded, not yet submitted for approval.
            // 'awaiting' — invoice submitted, decision still pending.
            // 'hold'     — invoice approval was put on hold.
            const stage = g.invoiceReleaseStatus === 'APPROVED' ? 'done'
              : !g.invoicePdfUrl ? 'upload'
              : g.invoiceReleaseStatus === 'ON_HOLD' ? 'hold'
              : g.invoiceReleaseToken ? 'awaiting'
              : 'ready';
            const stageBadge = stage === 'done' ? <span className="ml-1 rounded bg-green-50 px-1 text-[10px] font-medium text-green-700">invoice approved</span>
              : stage === 'upload' ? <span className="ml-1 text-[10px] font-medium text-orange-600">invoice pending</span>
              : stage === 'ready' ? <span className="ml-1 rounded bg-blue-50 px-1 text-[10px] font-medium text-blue-700">ready to submit</span>
              : stage === 'awaiting' ? <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] font-medium text-amber-700">approval pending</span>
              : <span className="ml-1 rounded bg-orange-50 px-1 text-[10px] font-medium text-orange-700">invoice on hold</span>;
            const actionLabel = stage === 'done' ? 'Open →' : stage === 'upload' ? 'Upload Invoice →' : stage === 'ready' ? 'Submit for Approval →' : 'Review →';
            return (
            <tr key={g.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => onOpenInvoice(g.id)}>
              <td className="px-4 py-2 font-medium text-navy">{g.grnNumber}</td>
              <td className="text-slate-600">{g.doc?.docNumber}</td>
              <td className="text-slate-600">{g.vendorName}</td>
              <td className="text-slate-500">{fmtDate(g.grnDate)}</td>
              <td className="text-right">{g.piValue != null ? inr(g.piValue) : '—'}</td>
              <td className="text-right">{g.invoiceValue != null ? inr(g.invoiceValue) : <span className="text-orange-500">—</span>}</td>
              <td>
                {g.paymentStatus
                  ? <span className={`badge ${g.paymentStatus === 'TRIGGERED' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{g.paymentStatus === 'TRIGGERED' ? 'Triggered' : g.paymentStatus === 'PAID' ? 'Paid' : 'Closed'}</span>
                  : <span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>}
                {stageBadge}
              </td>
              <td className="px-2 text-right">
                <button className="btn-primary text-xs" onClick={(e) => { e.stopPropagation(); onOpenInvoice(g.id); }}>{actionLabel}</button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GRNForm({ projectId, grnId, canApprove, onClose, showTaxInvoice = false }: { projectId: string; grnId: string; canApprove: boolean; onClose: () => void; showTaxInvoice?: boolean }) {
  const qc = useQueryClient();
  const { user, canEdit, can } = useAuth();
  const canMarkPaid = can('canMarkPaid');
  // PO pricing arrives already nulled for anyone who may not see it, so a plain
  // null-check is the whole rule here.
  const money = (n: number | null | undefined) => (n == null ? '—' : inr(n));
  const [g, setG] = useState<any>(null);
  // True while piValue is just the PO's default (not typed) — a PI upload may replace it.
  const piValueFromPo = useRef(false);
  // When opened from the Invoices tab, scroll the Tax Invoice block into view.
  const taxInvoiceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showTaxInvoice && g && taxInvoiceRef.current) taxInvoiceRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [showTaxInvoice, g]);
  const [msg, setMsg] = useState('');
  const [showChain, setShowChain] = useState(false);
  const [amending, setAmending] = useState(false);
  const [amendRemark, setAmendRemark] = useState('');
  const [askResubmit, setAskResubmit] = useState(false);
  const [resubmitMode, setResubmitMode] = useState(false);
  const grnQ = useQuery({
    queryKey: ['grn', grnId],
    queryFn: async () => {
      const res = (await api.get(`/projects/${projectId}/procurement/grns/${grnId}`)).data;
      const grn = structuredClone(res.grn);
      // Auto-fetch the PI value from the PO's final amount, exactly as the
      // vendor-payment (FMS) form does — still editable if the vendor's actual
      // proforma differs. Never overwrite a value already entered. The flag lets a
      // PI upload replace this default (the PI is the authority) without ever
      // replacing a figure the user typed.
      if ((grn.piValue == null || grn.piValue === '') && grn.doc?.finalAmount != null) {
        grn.piValue = grn.doc.finalAmount;
        piValueFromPo.current = true;
      }
      setG(grn);
      return res as { grn: any; approval?: any; milestones?: any[]; advanceOnPo?: number };
    },
  });
  const isLoading = grnQ.isLoading;

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/grns/${grnId}`, {
      vehicleNumber: g.vehicleNumber, driverName: g.driverName, deliveryChallanNumber: g.deliveryChallanNumber,
      invoiceNumber: g.invoiceNumber, invoiceDate: g.invoiceDate?.slice?.(0, 10), invoiceValue: toNum(g.invoiceValue) ?? undefined, ewayBillNumber: g.ewayBillNumber,
      // Payment (GRN/Payment PRD v3 §3) — the milestone being paid, the PI, and the amount.
      milestoneId: g.milestoneId ?? null, milestoneKey: g.milestoneKey ?? null, milestoneName: g.milestoneName ?? null,
      piNumber: g.piNumber ?? null, piDate: g.piDate?.slice?.(0, 10) || null, paymentDueDate: g.paymentDueDate?.slice?.(0, 10) || null, piValue: toNum(g.piValue),
      amountToPay: toNum(g.amountToPay),
      ledgerHead: g.ledgerHead ?? null,
      lrNumber: g.lrNumber ?? null,
      lineItems: g.lineItems.map((l: any) => ({ id: l.id, receiptQty: Number(l.receiptQty), defectQty: Number(l.defectQty || 0), remarks: l.remarks })),
      ...(amending ? { amendmentRemark: amendRemark } : {}),
    })).data.grn,
    onSuccess: (grn) => {
      const wasAmending = amending;
      setG(structuredClone(grn));
      setMsg(wasAmending ? 'Amendment saved and logged.' : 'Saved.');
      setAmending(false); setAmendRemark('');
      // Approval removed for payments — amending just saves; no resubmit prompt.
      qc.invalidateQueries({ queryKey: ['grns', projectId] });
    },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Read the uploaded tax-invoice PDF and PRE-FILL Number/Date/Value — runs
  // AUTOMATICALLY right after an upload, and the user can still correct any field
  // before saving. Only fills what it read; never wipes something already typed.
  const extractInvoice = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/grns/${grnId}/invoice-extract`, {})).data as { invoiceNumber: string | null; invoiceDate: string | null; invoiceValue: number | null; source: string; note?: string },
    onSuccess: (r) => {
      setG((prev: any) => ({ ...prev, invoiceNumber: r.invoiceNumber ?? prev.invoiceNumber, invoiceDate: r.invoiceDate ?? prev.invoiceDate, invoiceValue: r.invoiceValue != null ? r.invoiceValue : prev.invoiceValue }));
      const got = [r.invoiceNumber && 'number', r.invoiceValue != null && 'value', r.invoiceDate && 'date'].filter(Boolean);
      setMsg(got.length ? `Auto-filled from the PDF: ${got.join(', ')}. Review & correct if needed, then Save tax invoice.` : (r.note || 'Could not read the invoice from the PDF — enter the details manually.'));
    },
    onError: () => { /* silent — auto-fetch is best-effort; user can fill manually */ },
  });
  const uploadInvoice = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/invoice`, fd); },
    // Merge ONLY the new PDF url into the form (never refetch — that would wipe an
    // unsaved typed value), then AUTO-READ the PDF to pre-fill the fields.
    onSuccess: (r) => { setG((prev: any) => ({ ...prev, invoicePdfUrl: r?.data?.invoicePdfUrl ?? prev?.invoicePdfUrl })); setMsg('Invoice uploaded — reading details…'); qc.invalidateQueries({ queryKey: ['grns', projectId] }); extractInvoice.mutate(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadPI = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/pi`, fd); },
    onSuccess: (r) => {
      // The PI was read on upload. Fill what it told us — it may override the PO's
      // default PI value (the PI itself is the authority on that), but never a
      // value the user actually typed. No refetch: the server hasn't been told
      // these yet, so a refetch would wipe them before the user can Save.
      const x = r?.data?.extracted as { piNumber?: string; piDate?: string; piValue?: number; source?: string } | undefined;
      const patch: Record<string, unknown> = {};
      const got: string[] = [];
      if (r?.data?.piPdfUrl) patch.piPdfUrl = r.data.piPdfUrl;
      if (x && x.source !== 'none') {
        if (x.piNumber && !g.piNumber) { patch.piNumber = x.piNumber; got.push('number'); }
        if (x.piDate && !g.piDate) { patch.piDate = x.piDate; got.push('date'); }
        const piUntouched = g.piValue == null || g.piValue === '' || piValueFromPo.current;
        if (x.piValue != null && piUntouched) { patch.piValue = x.piValue; piValueFromPo.current = false; got.push('value'); }
      }
      setG({ ...g, ...patch });
      setMsg(got.length ? `PI uploaded — read its ${got.join(', ')}. Check them, then Save.` : 'PI uploaded.');
    },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/photo`, fd); },
    onSuccess: () => { setMsg('Photo uploaded.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // LR (Lorry Receipt) — only shown for a Transport Order payment (see below).
  const uploadLr = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/lr`, fd); },
    onSuccess: (r) => { setG({ ...g, lrPdfUrl: r?.data?.lrPdfUrl ?? g.lrPdfUrl }); setMsg('LR uploaded.'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Vendor-signed & stamped copy of the order (PO/WO/TO) — proof the vendor accepted it.
  const uploadSignedPo = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/signed-po`, fd); },
    onSuccess: (r) => { setG({ ...g, signedPoUrl: r?.data?.signedPoUrl ?? g.signedPoUrl }); setMsg('Signed PO uploaded.'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const act = useMutation({ mutationFn: (v: { verb: string; body?: any }) => api.post(`/projects/${projectId}/procurement/grns/${grnId}/${v.verb}`, v.body ?? {}), onSuccess: () => { qc.invalidateQueries({ queryKey: ['grn', grnId] }); qc.invalidateQueries({ queryKey: ['grns', projectId] }); }, onError: (e) => setMsg(errMsg(e)) });
  // Accounts record the UTR (§5–§6). Marking paid does NOT close the entry — the
  // tax invoice does — so a "paid but open" GRN is a real state.
  const markPaid = useMutation({
    mutationFn: async (utr: string) => (await api.post(`/projects/${projectId}/procurement/grns/${grnId}/mark-paid`, { utrNumber: utr })).data.grn,
    onSuccess: () => { setMsg('Marked paid — the entry stays open until the tax invoice is uploaded.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); qc.invalidateQueries({ queryKey: ['grns', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Management put this payment On Hold from the FMS Approval Form; after the
  // correction, re-submit clears the hold so it goes back to the approver.
  const resubmitRelease = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/grns/${grnId}/resubmit-approval`, {})).data.grn,
    onSuccess: (grn) => { setG(structuredClone(grn)); setMsg('Re-submitted for approval — sent back to the approver as Pending.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); qc.invalidateQueries({ queryKey: ['grns', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Resend the Approval Form email to the payment approver(s) — manual reminder.
  const remindApproval = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/grns/${grnId}/remind-approval`, {})).data,
    onSuccess: () => setMsg('Approval reminder email sent to the payment approver(s).'),
    onError: (e) => setMsg(errMsg(e)),
  });
  // Submit the uploaded TAX INVOICE for approval — mails the SAME payment approval
  // chain a no-login page to Approve / Hold the invoice (with invoice PDF + payment
  // status + UTR). Runs alongside the payment release; never changes the payment.
  const submitInvoiceApproval = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/grns/${grnId}/submit-invoice-approval`, {})).data.grn,
    onSuccess: (grn) => { setG(structuredClone(grn)); setMsg('Invoice sent for approval — the payment approver(s) got the email.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); qc.invalidateQueries({ queryKey: ['grns', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const remindInvoiceApproval = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/grns/${grnId}/remind-invoice-approval`, {})).data,
    onSuccess: () => setMsg('Invoice approval reminder email sent.'),
    onError: (e) => setMsg(errMsg(e)),
  });
  // The tax invoice arrives AFTER approval on a payment GRN (§6), so recording its
  // number/date/value is the closing step — not an amendment. This patches ONLY
  // those fields, which the server accepts without an amendment reason.
  const saveTaxInvoice = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/grns/${grnId}`, {
      invoiceNumber: g.invoiceNumber ?? null,
      invoiceDate: g.invoiceDate?.slice?.(0, 10) || null,
      invoiceValue: toNum(g.invoiceValue),
      ewayBillNumber: g.ewayBillNumber ?? null,
    })).data.grn,
    onSuccess: (grn) => { setG(structuredClone(grn)); setMsg('Tax invoice details saved.'); qc.invalidateQueries({ queryKey: ['grns', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadProof = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/payment-proof`, fd); },
    onSuccess: () => { setMsg('Payment proof uploaded.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  // Approval flow removed for payments (user request): Submit saves the form and
  // finalises the payment directly — no approval chain popup, no approval emails.
  // The server marks it approved, triggers the term, and pushes it to the sheet.
  const submitDirect = async () => {
    try {
      await save.mutateAsync();
      await act.mutateAsync({ verb: 'submit' });
      setMsg('Payment submitted — the term is triggered and it has gone to the payment sheet.');
    } catch (e) { setMsg(errMsg(e)); }
  };

  if (isLoading || !g) return <Spinner label="Loading GRN…" />;
  const approved = g.status === 'APPROVED';
  const canEditGrn = canEdit('grn');
  // Draft is freely editable; an approved GRN only while amending (with a reason).
  // ON_HOLD came back from an approver with a note — it must be editable so the
  // raiser can correct it and resubmit.
  const editable = g.status === 'DRAFT' || g.status === 'ON_HOLD' || (approved && amending);
  const amendments: { at: string; byName: string; byEmail: string; remark: string }[] = g.amendments ?? [];

  // Approval-chain state (mirrors DocBuilder).
  const approval = grnQ.data?.approval as { steps: any[]; total: number; currentApproverId?: string | null; currentApproverIds?: string[] } | undefined;
  const hasChain = (approval?.total ?? 0) > 0;
  const currentApprovers = approval?.currentApproverIds ?? (approval?.currentApproverId ? [approval.currentApproverId] : []);
  const myTurn = !!user?.id && currentApprovers.includes(user.id);
  const canAct = g.status === 'OPEN' && (hasChain ? (myTurn || canApprove) : canApprove);
  // Payment (§3): PO milestones for the term dropdown + the advance already paid,
  // which auto-captures so the balance can compute.
  const milestones: any[] = grnQ.data?.milestones ?? [];
  const advanceOnPo: number = grnQ.data?.advanceOnPo ?? 0;
  // The vendor's KYC set (GST certificate, PAN, cancelled cheque, …), resolved
  // from the vendor master — shown here, never uploaded here.
  const kycDocs: { id: string; kind: string; fileName: string; fileUrl: string }[] = (grnQ.data as any)?.kycDocs ?? [];
  // Accounts (FMS) stage timeline for this payment — read-only, may be null (no match).
  const fmsStages = (grnQ.data as any)?.fmsStages ?? null;
  const piValueNum = Number(g.piValue) || 0;
  // Live balance, same formula as the vendor-payment (FMS) form:
  // PI value − (advance already on the PO + what this entry pays).
  const balanceToPay = Math.round((piValueNum - advanceOnPo - (Number(g.amountToPay) || 0)) * 100) / 100;
  // A term is locked only once it is fully paid/committed. A partly-paid term
  // (remaining > 0) stays selectable so its balance can be paid (Amisha A1/A3).
  const isMilestoneLocked = (m: any) => m.status === 'PAID' || (m.remaining != null ? m.remaining <= 0.01 : m.status === 'TRIGGERED');
  // Payment lifecycle (§6): TRIGGERED → PAID → CLOSED, running alongside the
  // goods/approval status. A GRN can be PAID but still OPEN (tax invoice pending).
  const payStatus: string | null = g.paymentStatus ?? null;
  // Every record in this (GRN) collection is a Vendor Payment (PAY-QAS-###) — the
  // real goods-receipt register is a separate entity now. So a payment must be
  // recognised even when its term (milestoneId) wasn't captured; keying only off
  // milestoneId used to misfire and fall back to the old goods-receipt layout
  // (Delivery Details / Receipt Line Items) and skip the payment approval chain.
  const isPaymentGrn = !!g.milestoneId || g.piValue != null || !!g.piNumber || /^PAY-/i.test(g.grnNumber || '');
  // A payment raised against a Transport Order (TO) — the transporter's Lorry
  // Receipt (LR) applies here (and ONLY here, never for a PO/WO payment).
  const isTransportPayment = g.doc?.type === 'TO';
  const canRecordPaid = canMarkPaid && approved && payStatus === 'TRIGGERED';
  const paidButOpen = payStatus === 'PAID';
  const paymentClosed = payStatus === 'CLOSED';
  // The tax invoice closes a payment GRN, so it can be filled in and uploaded
  // AFTER approval (not amend-gated). A goods-receipt GRN keeps the original rule.
  const canUploadTaxInvoice = isPaymentGrn ? (!paymentClosed && canEditGrn) : editable;
  const taxInvoiceEditable = isPaymentGrn ? canEditGrn : editable;
  // Show a dedicated save for the tax-invoice block when the normal Save is hidden
  // (i.e. an approved payment GRN that is not being amended).
  const showTaxInvoiceSave = taxInvoiceEditable && !editable;
  const doMarkPaid = () => {
    const utr = window.prompt('UTR / payment reference (from FMS/bank)');
    if (!utr || !utr.trim()) return;
    markPaid.mutate(utr.trim());
  };
  // Approvers never reject: they put the GRN ON HOLD with a note saying what to
  // correct, and the raiser fixes it and resubmits.
  const promptRemarks = (verb: 'approve' | 'hold') => {
    const r = window.prompt(verb === 'hold' ? 'What needs to be corrected? (required)' : 'Remarks (optional)') ?? (verb === 'approve' ? '' : null);
    if (verb === 'hold' && !r?.trim()) return;
    act.mutate({ verb, body: verb === 'hold' ? { reason: r } : { remarks: r } });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><button className="btn-outline text-sm" onClick={onClose}>← Back</button><h2 className="text-lg font-bold text-navy">{g.grnNumber}</h2>
          {/* For a payment we DON'T show the record's own green "Approved" pill —
              it confuses (the record locks on submit, but the vendor-payment
              sign-off is still pending). We show the sign-off state instead. The
              plain doc pill stays for a Draft payment and for non-payment GRNs. */}
          {!payStatus && !(isPaymentGrn && approved) && <span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>}
          {payStatus && <span className={`badge ${paymentClosed ? 'bg-slate-100 text-slate-600' : paidButOpen ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{paymentClosed ? 'Payment Closed' : paidButOpen ? (g.invoicePdfUrl ? 'Paid · invoice awaiting approval' : 'Paid · tax invoice pending') : 'Payment Triggered'}</span>}
          {/* Vendor-payment approval sign-off — the decision the email drives. A
              submitted payment reads "Awaiting approval" until an approver signs
              off (then "Approved"), or "On Hold" / "Re-submitted" in between. */}
          {isPaymentGrn && approved && (
            g.releaseStatus === 'APPROVED'
              ? <span className="badge bg-emerald-100 text-emerald-700">✓ Approved</span>
              : g.releaseStatus === 'ON_HOLD'
                ? <span className="badge bg-orange-100 text-orange-700">⏸ On Hold</span>
                : g.releaseStatus === 'RESUBMITTED'
                  ? <span className="badge bg-blue-100 text-blue-700">↻ Re-submitted</span>
                  : <span className="badge bg-amber-100 text-amber-700">⏳ Awaiting approval</span>
          )}
        </div>
        <div className="flex gap-2">
          {canRecordPaid && <button className="btn-primary text-sm" disabled={markPaid.isPending} onClick={doMarkPaid}>💳 Mark Paid</button>}
          {g.status === 'APPROVED' && <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${grnId}/pdf`, `${g?.grnNumber || 'GRN'}.pdf`)}>📄 Download PDF</button>}
          {/* Internal copy with the FINAL APPROVAL stamp; clean one goes to the vendor. */}
          {g.status === 'APPROVED' && <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${grnId}/pdf?approvals=1`, `${g?.grnNumber || 'GRN'} - Approved.pdf`)}>🕒 With Approval</button>}
          {/* Resend the Approval Form email to the payment approver(s) while the
              decision is still pending / on hold. */}
          {isPaymentGrn && canEditGrn && g.releaseStatus !== 'APPROVED' && <button className="btn-outline text-sm" disabled={remindApproval.isPending} onClick={() => remindApproval.mutate()}>📧 Send Reminder</button>}
          {approved && canEditGrn && !amending && <button className="btn-outline text-sm" onClick={() => { setAmending(true); setMsg(''); }}>✎ Amend</button>}
          {amending && <button className="btn-outline text-sm" onClick={() => { setAmending(false); setAmendRemark(''); setG(structuredClone(grnQ.data!.grn)); }}>Cancel amend</button>}
          {editable && (
            <button className="btn-primary text-sm" disabled={save.isPending || (amending && amendRemark.trim().length < 3)} onClick={() => save.mutate()}>
              {amending ? 'Save amendment' : 'Save'}
            </button>
          )}
          {(g.status === 'DRAFT' || g.status === 'ON_HOLD') && <button className="btn-primary text-sm" disabled={save.isPending || act.isPending} onClick={submitDirect}>{g.status === 'ON_HOLD' ? 'Resubmit' : 'Submit'}</button>}
          {g.status === 'OPEN' && hasChain && <button className="btn-outline text-sm" disabled={act.isPending} onClick={() => act.mutate({ verb: 'remind' })}>Send Reminder</button>}
          {/* Approvers see the document itself before deciding. */}
          {canAct && <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${grnId}/pdf`, `${g?.grnNumber || 'GRN'}.pdf`)}>📄 Download GRN</button>}
          {canAct && <button className="btn-primary text-sm" onClick={() => promptRemarks('approve')}>✓ Approve</button>}
          {canAct && <button className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600" onClick={() => promptRemarks('hold')}>⏸ Put On Hold</button>}
        </div>
      </div>
      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}

      {/* Where this payment stands in Accounts (FMS) — a horizontal progress timeline:
          Payment raised → Approved → Processed by AP (Shivani) → Approved by Alok Ji
          → Paid by Finance (Taraji). Shown once the payment is actually submitted (not
          a DRAFT — a draft hasn't started its journey). The last three stages fill in
          from the FMS sheet as Accounts processes it; until then they read "pending". */}
      {isPaymentGrn && g.status !== 'DRAFT' && (
        <div className="rounded-xl border border-sky-200 bg-sky-50/60 p-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sky-700">Payment progress (Accounts / FMS)</div>
          <FmsTimeline
            fmsStages={fmsStages}
            approved={g.releaseStatus === 'APPROVED'}
            approvedAt={g.releaseStatus === 'APPROVED' ? g.releaseAt : null}
            paid={payStatus === 'PAID' || payStatus === 'CLOSED' || !!g.utrNumber}
            utr={g.utrNumber ?? null}
          />
        </div>
      )}

      {approved && !amending && (
        <div className={`rounded-lg px-3 py-2 text-sm ${isPaymentGrn && g.releaseStatus !== 'APPROVED' ? 'bg-amber-50 text-amber-800' : 'bg-blue-50 text-blue-700'}`}>
          {isPaymentGrn && g.releaseStatus !== 'APPROVED'
            ? <>This payment is submitted and <strong>awaiting approval</strong> from the payment approver(s) — an email has been sent. It becomes final once they sign off.{canEditGrn ? ' Use “Amend” above to change it — a reason is required and every change is logged below.' : ''}</>
            : <>This payment is approved and locked.{canEditGrn ? ' Use “Amend” above to change it — a reason is required and every change is logged below.' : ''}</>}
        </div>
      )}
      {/* Sent back by an approver: show exactly what they asked to be corrected. */}
      {g.status === 'ON_HOLD' && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5">
          <div className="text-sm font-semibold text-orange-800">⏸ On hold — correct this and resubmit</div>
          {g.rejectionReason && <div className="mt-1 text-sm text-orange-900">{g.rejectionReason}</div>}
          <div className="mt-1 text-[11px] text-orange-700">Fix the points above, Save, then Submit again for approval.</div>
        </div>
      )}
      {/* Management put the PAYMENT on hold from the FMS Approval Form — show what
          to correct, and let the creator re-submit once fixed. */}
      {g.releaseStatus === 'ON_HOLD' && (
        <div className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-orange-800">⏸ Payment put On Hold by management{g.releaseBy ? ` · ${g.releaseBy}` : ''}{g.releaseAt ? ` · ${fmtDate(g.releaseAt)}` : ''}</div>
            {canEditGrn && <button className="btn-primary text-sm" disabled={resubmitRelease.isPending} onClick={() => { if (confirm('Re-submit this payment for approval? The On Hold is cleared and it goes back to the approver as Pending.')) resubmitRelease.mutate(); }}>↻ Re-submit for approval</button>}
          </div>
          {g.releaseRemark && <div className="mt-1 text-sm text-orange-900"><span className="font-semibold">What to correct:</span> {g.releaseRemark}</div>}
          <div className="mt-1 text-[11px] text-orange-700">Correct the above, Save your changes, then re-submit — it returns to the approver as Pending.</div>
        </div>
      )}
      {/* After the creator re-submits a held payment — awaiting the approver again. */}
      {g.releaseStatus === 'RESUBMITTED' && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm text-blue-800">
          ↻ Re-submitted for approval{g.releaseAt ? ` on ${fmtDate(g.releaseAt)}` : ''} — awaiting management’s decision on the Approval Form.
        </div>
      )}
      {askResubmit && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-navy/20 bg-navy/5 px-3 py-2.5">
          <div className="text-sm text-navy">Amendment saved. Do you want to <strong>resubmit this GRN for approval</strong>?</div>
          <div className="flex gap-2">
            <button className="btn-primary text-sm" onClick={() => { setAskResubmit(false); setResubmitMode(true); setShowChain(true); }}>Resubmit for approval</button>
            <button className="btn-outline text-sm" onClick={() => setAskResubmit(false)}>No, keep as amended</button>
          </div>
        </div>
      )}
      {amending && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-amber-700">Reason for amending this approved GRN *</label>
          <textarea className="input text-sm" rows={2} value={amendRemark} onChange={(e) => setAmendRemark(e.target.value)} placeholder="e.g. Corrected accepted quantity for line 2 after re-inspection" />
          <div className="mt-1 text-[11px] text-amber-700">This reason and your name &amp; email are saved to the amendment history and shown to everyone.</div>
        </div>
      )}
      {amendments.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Amendments after approval ({amendments.length})</div>
          <ol className="divide-y divide-slate-100">
            {[...amendments].reverse().map((a, i) => (
              <li key={i} className="px-3 py-2 text-sm">
                <div className="text-slate-700">{a.remark}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{a.byName}{a.byEmail ? ` · ${a.byEmail}` : ''} · {new Date(a.at).toLocaleString('en-GB')}</div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {hasChain && <ApprovalTimeline approval={approval as any} />}
      {showChain && (
        <ChainBuilder
          docType="GRN"
          projectId={projectId}
          // A payment GRN's value is the amount being released; a goods-receipt
          // GRN's value is the tax invoice it certifies.
          amount={isPaymentGrn ? (Number(g.amountToPay) || Number(g.piValue) || 0) : (Number(g.invoiceValue) || 0)}
          busy={act.isPending || save.isPending}
          onClose={() => { setShowChain(false); setResubmitMode(false); }}
          onConfirm={async (chain) => {
            if (!resubmitMode) await save.mutateAsync();
            act.mutate({ verb: 'submit', body: { chain } });
            setShowChain(false); setResubmitMode(false);
          }}
        />
      )}

      {/* Delivery + receipt are goods-receipt concerns, recorded on the Goods
          Receipt (GRN) page — not relevant to a payment, so hidden on a payment. */}
      {!isPaymentGrn && (
      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Delivery Details</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <G label="Vehicle Number" v={g.vehicleNumber} on={(x) => setG({ ...g, vehicleNumber: x })} ed={editable} />
          <G label="Driver Name" v={g.driverName} on={(x) => setG({ ...g, driverName: x })} ed={editable} />
          <G label="Delivery Challan No." v={g.deliveryChallanNumber} on={(x) => setG({ ...g, deliveryChallanNumber: x })} ed={editable} />
        </div>
      </div>
      )}

      {!isPaymentGrn && (
      <div className="card p-4">
        <div className="mb-1 text-sm font-semibold text-slate-600">Receipt Line Items</div>
        {/* PO unit price / total value are only rendered for approvers (Procurement,
            Site Manager, Admin). `poVisible` comes straight from the server, which
            also nulls the values themselves — the engineer never receives them. */}
        <p className="mb-3 text-xs text-slate-400">
          {g.poVisible ? 'PO pricing is shown because you can approve this GRN.' : 'PO unit prices and total value are not shown for your role.'}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            {/* Quantity columns are centre-aligned — AA sir asked for this explicitly. */}
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="text-left">Description</th>
                <th className="w-20 text-center">PO Qty</th>
                <th className="w-24 text-center">Prev Recd</th>
                <th className="w-24 text-center">Remaining</th>
                <th className="w-24 text-center">Receipt</th>
                <th className="w-20 text-center">Defect</th>
                <th className="w-20 text-center">Accepted</th>
                {g.poVisible && <th className="w-24 text-right">PO Unit Price</th>}
                {g.poVisible && <th className="w-24 text-right">PO Total</th>}
              </tr>
            </thead>
            <tbody>
              {g.lineItems.map((l: any, i: number) => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="py-1 text-xs">{l.description}</td>
                  <td className="text-center">{l.poQty}</td>
                  <td className="text-center">{l.previouslyReceivedQty}</td>
                  <td className="text-center text-slate-500">{l.remainingToReceive ?? Math.max(l.poQty - l.previouslyReceivedQty, 0)}</td>
                  <td><input className="input text-center" type="number" disabled={!editable} value={l.receiptQty} onChange={(e) => { const li = [...g.lineItems]; li[i] = { ...li[i], receiptQty: e.target.value }; setG({ ...g, lineItems: li }); }} /></td>
                  <td><input className="input text-center" type="number" disabled={!editable} value={l.defectQty} onChange={(e) => { const li = [...g.lineItems]; li[i] = { ...li[i], defectQty: e.target.value }; setG({ ...g, lineItems: li }); }} /></td>
                  <td className="text-center font-medium">{Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0)}</td>
                  {g.poVisible && <td className="text-right">{money(l.poUnitPrice)}</td>}
                  {g.poVisible && <td className="text-right">{money(l.poTotalPrice)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* On the normal payment view the tax invoice is hidden (it lives in the
          Payments → Invoices tab). It appears here when the payment is opened FROM
          that tab to upload the invoice, and always for a pure goods-receipt GRN. */}
      {(!isPaymentGrn || showTaxInvoice) && (
      <div ref={taxInvoiceRef} className={`card p-4 ${showTaxInvoice && isPaymentGrn ? 'ring-2 ring-navy/30' : ''}`}>
        <div className="mb-1 text-sm font-semibold text-slate-600">Tax Invoice {isPaymentGrn ? '(arrives later — closes the entry)' : '(mandatory before submit)'}</div>
        <p className="mb-3 text-xs text-slate-400">{isPaymentGrn ? 'The tax invoice comes AFTER payment. Uploading it on a paid GRN closes the entry and it leaves the bucket. Not required to submit — payment runs on the PI above.' : "Enter the value from the vendor's actual tax invoice — an invoice may cover only part of the PO. This is what flows into the payment pipeline as “Amount Invoiced”."}</p>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <G label={`Invoice Number${isPaymentGrn ? '' : ' *'}`} v={g.invoiceNumber} on={(x) => setG({ ...g, invoiceNumber: x })} ed={taxInvoiceEditable} />
            <F label={`Invoice Date${isPaymentGrn ? '' : ' *'}`}><input className="input" type="date" disabled={!taxInvoiceEditable} value={g.invoiceDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, invoiceDate: e.target.value })} /></F>
            <G label={`Invoice Value (INR)${isPaymentGrn ? '' : ' *'}`} v={g.invoiceValue} on={(x) => setG({ ...g, invoiceValue: x })} ed={taxInvoiceEditable} />
            <G label="E-Way Bill Number" v={g.ewayBillNumber} on={(x) => setG({ ...g, ewayBillNumber: x })} ed={taxInvoiceEditable} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <F label={`Tax Invoice PDF${isPaymentGrn ? ' (closes the entry)' : ' *'}`}>
              {g.invoicePdfUrl
                ? <a className="text-sm text-navy hover:underline" href={g.invoicePdfUrl} target="_blank" rel="noreferrer">📄 View invoice</a>
                : <span className="text-xs text-slate-400">{isPaymentGrn ? 'Comes after payment' : 'Not uploaded'}</span>}
              {canUploadTaxInvoice && <input className="input mt-1 text-xs" type="file" accept=".pdf,application/pdf" onChange={(e) => e.target.files?.[0] && uploadInvoice.mutate(e.target.files[0])} />}
              {extractInvoice.isPending && <div className="mt-1 text-[11px] text-slate-400">⏳ Reading the invoice PDF…</div>}
            </F>
            <F label="Material Photo">
              {g.photoUrl
                ? <a className="text-sm text-navy hover:underline" href={g.photoUrl} target="_blank" rel="noreferrer">🖼 View photo</a>
                : <span className="text-xs text-slate-400">Not uploaded</span>}
              {editable && <input className="input mt-1 text-xs" type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && uploadPhoto.mutate(e.target.files[0])} />}
            </F>
          </div>
        </div>
        {/* On an approved payment GRN the main Save is hidden (it would demand an
            amendment reason), so the tax invoice gets its own save — no reason needed. */}
        {showTaxInvoiceSave && (
          <div className="mt-3 flex items-center gap-2">
            <button className="btn-primary text-sm" disabled={saveTaxInvoice.isPending} onClick={() => saveTaxInvoice.mutate()}>Save tax invoice</button>
            <span className="text-[11px] text-slate-400">Recording the tax invoice is the closing step — no amendment reason needed.</span>
          </div>
        )}
        {/* Invoice approval — mails the SAME payment approval chain a link to
            Approve / Hold the invoice (with invoice PDF + payment status + UTR). */}
        {isPaymentGrn && g.invoicePdfUrl && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-600">Invoice approval:</span>
              {g.invoiceReleaseStatus === 'APPROVED'
                ? <span className="badge bg-green-100 text-green-700">✓ Approved{g.invoiceReleaseBy ? ` · ${g.invoiceReleaseBy}` : ''}</span>
                : g.invoiceReleaseStatus === 'ON_HOLD'
                  ? <span className="badge bg-orange-100 text-orange-700">⏸ On Hold</span>
                  : g.invoiceReleaseToken
                    ? <span className="badge bg-amber-100 text-amber-700">Awaiting approval</span>
                    : <span className="badge bg-slate-100 text-slate-500">Not submitted</span>}
              {canEditGrn && g.invoiceReleaseStatus !== 'APPROVED' && (
                <button className="btn-outline text-xs" disabled={submitInvoiceApproval.isPending} onClick={() => submitInvoiceApproval.mutate()}>
                  {g.invoiceReleaseToken ? '↻ Re-submit for approval' : '📤 Submit Invoice for Approval'}
                </button>
              )}
              {canEditGrn && g.invoiceReleaseToken && g.invoiceReleaseStatus !== 'APPROVED' && (
                <button className="text-xs font-medium text-navy hover:underline" disabled={remindInvoiceApproval.isPending} onClick={() => remindInvoiceApproval.mutate()}>Send reminder</button>
              )}
            </div>
            {g.invoiceReleaseStatus === 'ON_HOLD' && g.invoiceReleaseRemark && <div className="mt-1 text-[11px] text-orange-600">On hold: {g.invoiceReleaseRemark}</div>}
            <div className="mt-1 text-[10px] text-slate-400">Emails the payment approval chain a link to Approve / Hold the invoice — with the invoice PDF, payment status &amp; UTR.</div>
          </div>
        )}
      </div>
      )}

      {/* Payment sits BELOW the tax invoice and mirrors the vendor-payment (FMS)
          form field-for-field, so both payment screens read identically. The flow
          itself is unchanged: pick the term, upload the PI (which drives the
          payment), and on GRN approval the milestone triggers into the Payment
          Pipeline. (GRN/Payment PRD v3 §3) */}
      <div className="card p-4">
        <div className="mb-1 text-sm font-semibold text-slate-600">Vendor Payment</div>
        <p className="mb-3 text-xs text-slate-400">Pick which payment term is being paid, upload the vendor's Proforma Invoice (PI), and enter the amount. Already-paid terms are greyed out. The advance already paid on this PO is captured automatically; the balance is editable so you can pay partially.</p>
        <div className="space-y-4">
          {/* Who / PI — the PO and vendor are fixed: this GRN is raised against them. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <F label="Department"><input className="input bg-slate-50 text-slate-600" value="Cold Room" disabled readOnly /></F>
            <G label="PI Number" v={g.piNumber} on={(x) => setG({ ...g, piNumber: x })} ed={editable} />
            <F label="PI Date"><input className="input" type="date" disabled={!editable} value={g.piDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, piDate: e.target.value })} /></F>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {/* When Accounts must pay by — carried straight to the FMS sheet. */}
            <F label="Payment Due Date"><input className="input" type="date" disabled={!editable} value={g.paymentDueDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, paymentDueDate: e.target.value })} /></F>
            <F label="PO Number (terms fetched)"><input className="input bg-slate-50 text-slate-600" value={g.doc?.docNumber ?? '—'} disabled readOnly /></F>
            <F label="Vendor"><input className="input bg-slate-50 text-slate-600" value={g.vendorName ?? '—'} disabled readOnly /></F>
            <F label="Which payment (term)">
              <select
                className="input"
                disabled={!editable}
                value={g.milestoneId || ''}
                onChange={(e) => {
                  const m = milestones.find((x) => x.id === e.target.value);
                  const pi = m?.pi; // PI uploaded on the PO for this term (auto-fetch)
                  // Picking a term pre-fills what it's worth (still editable for a
                  // partial payment) — same behaviour as the vendor-payment form —
                  // and auto-fetches the PO's PI for that term.
                  setG({
                    ...g, milestoneId: m?.id ?? null, milestoneKey: m?.fieldKey ?? null, milestoneName: m?.name ?? null,
                    // Default to this term's REMAINING balance (part-payments), not
                    // the full term value — still editable for a smaller amount.
                    amountToPay: m ? (m.remaining != null ? m.remaining : m.inrAmount) : g.amountToPay,
                    ...(pi ? {
                      piNumber: pi.piNumber ?? g.piNumber,
                      piDate: pi.piDate ?? g.piDate,
                      piValue: pi.piValue ?? g.piValue,
                      piPdfUrl: pi.piPdfUrl ?? g.piPdfUrl,
                    } : {}),
                  });
                }}
              >
                <option value="">Select a payment term…</option>
                {milestones.map((m) => {
                  const partlyPaid = m.remaining != null && m.remaining > 0.01 && m.remaining < m.inrAmount - 0.01;
                  return (
                    <option key={m.id} value={m.id} disabled={isMilestoneLocked(m) && m.id !== g.milestoneId}>
                      {m.name}{m.percentage ? ` (${m.percentage}%)` : ''}{m.inrAmount != null ? ` — ${inr(m.inrAmount)}` : ''}
                      {isMilestoneLocked(m) ? ` · ${titleize(m.status)}` : partlyPaid ? ` · ${inr(m.remaining)} pending` : ''}
                    </option>
                  );
                })}
              </select>
              {milestones.length === 0 && <div className="mt-1 text-[11px] text-slate-400">This PO has no payment terms defined.</div>}
              {/* Selected term's remaining balance — how much of e.g. the Advance is
                  still open to pay across part-payments (Amisha A1/A3). */}
              {(() => {
                const sel = milestones.find((x) => x.id === g.milestoneId);
                if (!sel || sel.remaining == null || sel.inrAmount == null) return null;
                const committed = Math.round((sel.inrAmount - sel.remaining) * 100) / 100;
                if (committed <= 0.01) return null;
                const pctLeft = sel.inrAmount > 0 ? Math.round((sel.remaining / sel.inrAmount) * 1000) / 10 : 0;
                return (
                  <div className="mt-1 text-[11px] text-slate-500">
                    {sel.name}: already paid <span className="font-medium">{inr(committed)}</span> ·{' '}
                    <span className="font-medium text-rose-600">{inr(sel.remaining)} remaining ({pctLeft}% of this term left)</span>
                  </div>
                );
              })()}
            </F>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <G label="PI / Invoice Value (final)" v={g.piValue} on={(x) => setG({ ...g, piValue: x })} ed={editable} />
            <F label="Advance already paid (on PO)"><input className="input bg-slate-50 text-slate-600" disabled value={inr(advanceOnPo)} readOnly /></F>
            <F label="Amount to Pay (editable — can be partial)">
              <input className="input" type="number" disabled={!editable} value={g.amountToPay ?? ''} placeholder={String(balanceToPay)} onChange={(e) => setG({ ...g, amountToPay: e.target.value })} />
            </F>
            <F label="Balance to Pay (auto)"><input className="input bg-slate-50 font-semibold text-navy" disabled value={inr(balanceToPay)} readOnly /></F>
          </div>

          {/* PO value breakup — for reference only, so the raiser can compare the
              Basic vs GST vs Final PO value against what's being paid. This does NOT
              change the amount actually being paid (that stays "Amount to Pay"). */}
          {g.doc?.basicAmount != null && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
              <span className="font-semibold text-slate-600">PO value (for reference):</span>
              <span className="text-slate-500">Basic Amount: <span className="font-medium text-slate-700">{inr(g.doc.basicAmount)}</span></span>
              {g.doc.gstEnabled && g.doc.gstPct != null && (
                <span className="text-slate-500">GST ({g.doc.gstPct}%): <span className="font-medium text-slate-700">{inr(Math.round(((g.doc.finalAmount ?? 0) - (g.doc.basicAmount ?? 0)) * 100) / 100)}</span></span>
              )}
              {g.doc.finalAmount != null && <span className="text-slate-500">Final Amount (with GST): <span className="font-semibold text-navy">{inr(g.doc.finalAmount)}</span></span>}
              <span className="text-[11px] text-slate-400">Only "Amount to Pay" above is actually paid.</span>
            </div>
          )}

          {/* The PO's terms, same strip as the FMS form. */}
          {milestones.length > 0 && (
            <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-600">Payment terms (from PO): </span>
              {milestones.filter((m) => m.percentage).map((m) => `${m.name} ${m.percentage}%`).join(' · ') || '—'}
            </div>
          )}

          {/* Ledger Head — a free-text remark the raiser types; it flows to the FMS
              sheet (its own column) and the payment approval email / form. */}
          <F label="Ledger Head (remark)">
            <input className="input" disabled={!editable} value={g.ledgerHead ?? ''} placeholder="e.g. Blast & Freezer (BOQ 1.1A) — note for accounts / approver" onChange={(e) => setG({ ...g, ledgerHead: e.target.value })} />
          </F>

          {/* Lorry Receipt (LR) — ONLY for a Transport Order (TO) payment. The
              transporter's consignment document; uploaded like the PI (PDF only).
              Never shown for a PO/WO payment. */}
          {isTransportPayment && (
            <div className="grid gap-3 sm:grid-cols-2">
              <G label="LR (Lorry Receipt) Number" v={g.lrNumber} on={(x) => setG({ ...g, lrNumber: x })} ed={editable} />
              <F label="LR (Lorry Receipt) PDF *">
                {g.lrPdfUrl
                  ? <a className="text-sm text-navy hover:underline" href={g.lrPdfUrl} target="_blank" rel="noreferrer">📄 View LR</a>
                  : <span className="text-xs text-slate-400">Not uploaded</span>}
                {editable && <input className="input mt-1 text-xs" type="file" accept=".pdf,application/pdf" onChange={(e) => e.target.files?.[0] && uploadLr.mutate(e.target.files[0])} />}
              </F>
            </div>
          )}

          {/* Attachments — the PI drives the payment; the tax invoice lives in its
              own card above; the PO this GRN is against is one click away. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <F label="PI (Proforma Invoice) PDF *">
              {g.piPdfUrl
                ? <a className="text-sm text-navy hover:underline" href={g.piPdfUrl} target="_blank" rel="noreferrer">📄 View PI</a>
                : <span className="text-xs text-slate-400">Not uploaded</span>}
              {editable && <input className="input mt-1 text-xs" type="file" accept=".pdf,application/pdf" onChange={(e) => e.target.files?.[0] && uploadPI.mutate(e.target.files[0])} />}
            </F>
            <F label="Tax Invoice PDF (closes the entry)">
              {g.invoicePdfUrl
                ? <a className="text-sm text-navy hover:underline" href={g.invoicePdfUrl} target="_blank" rel="noreferrer">📄 View invoice</a>
                : <span className="text-xs text-slate-400">{isPaymentGrn ? 'Comes after payment' : 'Recorded in the Tax Invoice card above'}</span>}
            </F>
            {/* The PO PDF is a bearer-authed endpoint, so it can't be a plain link
                (a new tab sends no token) — fetch it as a blob and open that. */}
            <F label="PO (attached)">
              {g.doc?.docNumber
                ? <button className="text-sm text-navy hover:underline" onClick={() => downloadFile(`/projects/${projectId}/procurement/docs/${g.docId}/pdf`, `${g.doc?.docNumber || 'PO'}.pdf`)}>📄 {g.doc.docNumber}</button>
                : <span className="text-xs text-slate-400">No PO linked</span>}
            </F>
            {/* Vendor-signed & stamped copy of the order (PO/WO/TO) — uploaded at
                payment time as proof the vendor accepted it. PDF only, optional. */}
            <F label={`Signed ${g.doc?.type || 'PO'} (vendor)`}>
              {g.signedPoUrl
                ? <a className="text-sm text-navy hover:underline" href={g.signedPoUrl} target="_blank" rel="noreferrer">📄 View signed {g.doc?.type || 'PO'}</a>
                : <span className="text-xs text-slate-400">Not uploaded</span>}
              {editable && <input className="input mt-1 text-xs" type="file" accept=".pdf,application/pdf" onChange={(e) => e.target.files?.[0] && uploadSignedPo.mutate(e.target.files[0])} />}
            </F>
            {/* KYC is held against the vendor master, so the whole set is fetched
                and listed — never uploaded here. If there is none, say so plainly. */}
            <F label={`Vendor KYC${kycDocs.length ? ` (${kycDocs.length})` : ''}`}>
              {kycDocs.length ? (
                <div className="space-y-0.5">
                  {kycDocs.map((d) => (
                    <a key={d.id} className="block text-sm text-navy hover:underline" href={d.fileUrl} target="_blank" rel="noreferrer" title={d.fileName}>
                      📄 {titleize(d.kind)}
                    </a>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-amber-600">Vendor’s KYC is not uploaded — add it on the vendor.</span>
              )}
            </F>
          </div>
        </div>

        {/* Payment lifecycle (§6): once approved the milestone triggers to Accounts,
            who record the UTR (Mark Paid). The entry stays open until the tax
            invoice is uploaded — a "paid but open" state is real. */}
        {isPaymentGrn && payStatus && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-slate-400">
              <span className="text-navy">PI uploaded</span><span>→</span>
              <span className="text-navy">submitted</span><span>→</span>
              <span className="text-navy">approved</span><span>→</span>
              <span className={payStatus ? 'text-navy' : ''}>triggered</span><span>→</span>
              <span className={paidButOpen || paymentClosed ? 'text-navy' : ''}>paid</span><span>→</span>
              <span className={paymentClosed ? 'text-navy' : ''}>closed</span>
            </div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {g.utrNumber && <F label="UTR / Payment Ref"><div className="text-sm font-medium text-slate-700">{g.utrNumber}{g.paidAt ? ` · ${fmtDate(g.paidAt)}` : ''}</div></F>}
              {(paidButOpen || paymentClosed) && (
                <F label="Payment Proof">
                  {g.paymentProofUrl
                    ? <a className="text-sm text-navy hover:underline" href={g.paymentProofUrl} target="_blank" rel="noreferrer">📄 View proof</a>
                    : <span className="text-xs text-slate-400">Not uploaded</span>}
                  {canMarkPaid && <input className="input mt-1 text-xs" type="file" accept=".pdf,image/*" onChange={(e) => e.target.files?.[0] && uploadProof.mutate(e.target.files[0])} />}
                </F>
              )}
            </div>
            {payStatus === 'TRIGGERED' && <div className="mt-2 text-[11px] text-amber-700">Triggered to Accounts — awaiting the UTR (Mark Paid).</div>}
            {paidButOpen && <div className="mt-2 text-[11px] text-emerald-700">Paid — this entry stays open until the tax invoice is uploaded and <strong>approved by Finance</strong>; then it closes and leaves the bucket.</div>}
            {paymentClosed && <div className="mt-2 text-[11px] text-slate-500">Closed — paid and the tax invoice is approved &amp; on file.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
// Field wrapper in the vendor-payment (FMS) form's format — small uppercase
// label above the control — so the GRN's payment screen reads the same as FMS.
function F({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {children}
    </div>
  );
}

function G({ label, v, on, ed }: { label: string; v: any; on: (x: string) => void; ed: boolean }) {
  return <F label={label}><input className="input" disabled={!ed} value={v || ''} onChange={(e) => on(e.target.value)} /></F>;
}
