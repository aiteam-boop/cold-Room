// FMS — Vendor Payment Entry (Procurement/Finance Flow PRD v2 §4).
//
// The register of vendor payments, plus the entry form. Selecting a PO fetches
// its payment-terms % + vendor + amount; the balance auto-computes; a GST toggle
// controls whether the amount is GST-inclusive; PI + KYC PDFs attach; the finance
// approval chain runs through the same engine as PO/GRN. Reuses ChainBuilder and
// ApprovalTimeline so the look matches the rest of procurement.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { docStatusPill, fmtDate, inr, titleize } from '../../lib/format';
import ChainBuilder from './ChainBuilder';
import ApprovalTimeline from './ApprovalTimeline';

interface Payment {
  id: string; paymentNumber: string; status: string; department: string | null;
  piNumber: string | null; piDate: string | null;
  vendorId: string | null; vendorName: string | null;
  docId: string | null; poNumber: string | null;
  paymentType: string; fullAmount: number; amountToPay: number; balance: number;
  gstInclusive: boolean; gstPct: number;
  payTermsSnapshot: PayTerms | null;
  piPdfUrl: string | null; kycPdfUrl: string | null;
  remark: string | null; paymentReference: string | null; paidAt: string | null; createdAt: string;
}
interface PayTerms { advance: number; beforeDelivery: number; running: number; postDelivery: number; postCompletion: number; retention: number }
interface POOption { id: string; docNumber: string; vendorId: string | null; vendorName: string | null; finalAmount: number; status: string }

const money = (n: number | null | undefined) => (n == null ? '—' : inr(n));

export default function FMSView({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const editable = canEdit('fms');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['fms', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/fms`)).data.payments as Payment[],
  });

  const create = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/fms`, {})).data.payment as Payment,
    onSuccess: (p) => { qc.invalidateQueries({ queryKey: ['fms', projectId] }); setOpenId(p.id); setCreating(false); },
  });

  if (isLoading) return <Spinner label="Loading payments…" />;
  const payments = data ?? [];

  if (openId) return <PaymentDetail projectId={projectId} paymentId={openId} editable={editable} onClose={() => setOpenId(null)} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold text-navy">FMS — Vendor Payments</h2>
          <p className="text-xs text-slate-400">Record a payment against a PO — balance &amp; payment terms compute themselves.</p>
        </div>
        {editable && <button className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creating…' : '+ New Payment'}</button>}
      </div>

      {payments.length === 0 ? (
        <EmptyState title="No payments yet" hint={editable ? 'Create a payment entry against a PO to begin.' : 'No vendor payments have been recorded.'} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-2">Payment No.</th><th>Vendor</th><th>PO</th><th>Type</th>
                  <th className="text-right">Full</th><th className="text-right">To Pay</th><th className="text-right">Balance</th>
                  <th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-navy">{p.paymentNumber}</td>
                    <td className="text-slate-600">{p.vendorName || '—'}</td>
                    <td className="text-slate-500">{p.poNumber || '—'}</td>
                    <td>{titleize(p.paymentType)}</td>
                    <td className="text-right">{money(p.fullAmount)}</td>
                    <td className="text-right font-medium">{money(p.amountToPay)}</td>
                    <td className="text-right">{money(p.balance)}</td>
                    <td><span className={`badge ${docStatusPill(p.status)}`}>{titleize(p.status)}</span></td>
                    <td className="px-2 text-right"><button className="text-xs font-medium text-navy hover:underline" onClick={() => setOpenId(p.id)}>Open →</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {creating && null}
    </div>
  );
}

// ── Detail / editor ─────────────────────────────────────────────────────────
function PaymentDetail({ projectId, paymentId, editable, onClose }: { projectId: string; paymentId: string; editable: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { user, can } = useAuth();
  const [p, setP] = useState<Payment | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [showChain, setShowChain] = useState(false);

  const { data } = useQuery({
    queryKey: ['fms-doc', paymentId],
    queryFn: async () => { const r = (await api.get(`/projects/${projectId}/fms/${paymentId}`)).data; setP(structuredClone(r.payment)); return r as { payment: Payment; approval: any }; },
  });
  const poOpts = useQuery({ queryKey: ['fms-pos', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/fms/po-options`)).data.pos as POOption[] });

  const refresh = () => { qc.invalidateQueries({ queryKey: ['fms-doc', paymentId] }); qc.invalidateQueries({ queryKey: ['fms', projectId] }); };

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/fms/${paymentId}`, {
      piNumber: p!.piNumber, piDate: p!.piDate ? p!.piDate.slice(0, 10) : null,
      vendorId: p!.vendorId, vendorName: p!.vendorName, docId: p!.docId, poNumber: p!.poNumber,
      paymentType: p!.paymentType, fullAmount: Number(p!.fullAmount), amountToPay: Number(p!.amountToPay),
      gstInclusive: p!.gstInclusive, gstPct: Number(p!.gstPct), payTermsSnapshot: p!.payTermsSnapshot, remark: p!.remark,
    })).data.payment as Payment,
    onSuccess: (np) => { setP(structuredClone(np)); setMsg({ ok: true, t: 'Saved.' }); refresh(); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  const act = useMutation({
    mutationFn: async (v: { verb: string; body?: any }) => (await api.post(`/projects/${projectId}/fms/${paymentId}/${v.verb}`, v.body ?? {})).data,
    onSuccess: () => { refresh(); setMsg({ ok: true, t: 'Done.' }); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  const upload = useMutation({
    mutationFn: async ({ kind, file }: { kind: 'pi' | 'kyc'; file: File }) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/fms/${paymentId}/${kind}`, fd); },
    onSuccess: () => { setMsg({ ok: true, t: 'Uploaded.' }); refresh(); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  // When a PO is chosen, fetch its terms + vendor + amount and pre-fill.
  async function selectPO(docId: string) {
    if (!p) return;
    if (!docId) { setP({ ...p, docId: null, poNumber: null }); return; }
    try {
      const r = (await api.get(`/projects/${projectId}/fms/po/${docId}`)).data;
      setP({
        ...p, docId, poNumber: r.docNumber,
        vendorId: r.vendorId ?? p.vendorId, vendorName: r.vendorName ?? p.vendorName,
        payTermsSnapshot: r.payTerms,
        // pre-fill full amount from the PO if not yet set (still manually editable)
        fullAmount: p.fullAmount || r.finalAmount || 0,
        gstInclusive: p.gstInclusive || !!r.gstEnabled,
        gstPct: r.gstPct ?? p.gstPct,
      });
      if (r.kycPdfUrl && !p.kycPdfUrl) setMsg({ ok: true, t: 'Vendor KYC on file — it will attach automatically.' });
    } catch (e) { setMsg({ ok: false, t: errMsg(e) }); }
  }

  if (!p) return <Spinner label="Loading payment…" />;
  const approval = data?.approval as { steps: any[]; total: number; currentApproverId?: string | null } | undefined;
  const hasChain = (approval?.total ?? 0) > 0;
  const myTurn = !!approval?.currentApproverId && approval.currentApproverId === user?.id;
  const canApprove = can('canApprove');
  const canAct = p.status === 'PENDING_APPROVAL' && (hasChain ? (myTurn || canApprove) : canApprove);
  const locked = p.status === 'APPROVED' || p.status === 'PAID';
  const canDo = editable && !locked;

  // Live balance preview (server also computes it authoritatively on save).
  const previewBalance = Math.round((Number(p.fullAmount || 0) - Number(p.amountToPay || 0)) * 100) / 100;

  const set = (patch: Partial<Payment>) => setP({ ...p, ...patch });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button className="btn-outline text-sm" onClick={onClose}>← Back</button>
          <h2 className="text-lg font-bold text-navy">{p.paymentNumber}</h2>
          <span className={`badge ${docStatusPill(p.status)}`}>{titleize(p.status)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {canDo && <button className="btn-primary text-sm" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>}
          {canDo && p.status === 'DRAFT' && <button className="btn-primary text-sm" onClick={() => setShowChain(true)}>Submit for Approval</button>}
          {editable && p.status === 'PENDING_APPROVAL' && <button className="btn-outline text-sm" onClick={() => act.mutate({ verb: 'recall' })}>Recall</button>}
          {canAct && <button className="btn-primary text-sm" onClick={() => act.mutate({ verb: 'approve', body: { remarks: '' } })}>✓ Approve</button>}
          {canAct && <button className="btn-danger text-sm" onClick={() => { const r = prompt('Rejection reason'); if (r) act.mutate({ verb: 'reject', body: { reason: r } }); }}>Reject</button>}
          {p.status === 'APPROVED' && can('canMarkPaid') && <button className="btn-primary text-sm" onClick={() => { const ref = prompt('Payment reference / UTR (optional)') ?? ''; act.mutate({ verb: 'mark-paid', body: { paymentReference: ref } }); }}>Mark Paid</button>}
        </div>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.t}</div>}
      {locked && <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">This payment is {p.status.toLowerCase()} and locked.{p.paymentReference ? ` UTR: ${p.paymentReference}` : ''}</div>}
      {hasChain && <ApprovalTimeline approval={approval as any} />}

      <div className="card space-y-4 p-4">
        {/* Who / PI */}
        <div className="grid gap-3 sm:grid-cols-3">
          <F label="Department"><input className="input" value={p.department ?? 'Cold Room'} disabled /></F>
          <F label="PI Number"><input className="input" disabled={!canDo} value={p.piNumber ?? ''} onChange={(e) => set({ piNumber: e.target.value })} /></F>
          <F label="PI Date"><input type="date" className="input" disabled={!canDo} value={p.piDate ? p.piDate.slice(0, 10) : ''} onChange={(e) => set({ piDate: e.target.value })} /></F>
        </div>

        {/* PO select → fetches terms + vendor */}
        <div className="grid gap-3 sm:grid-cols-3">
          <F label="PO Number (auto-fetch terms)">
            <select className="input" disabled={!canDo} value={p.docId ?? ''} onChange={(e) => selectPO(e.target.value)}>
              <option value="">— select PO —</option>
              {(poOpts.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.docNumber} · {o.vendorName || 'vendor'} ({o.status})</option>)}
            </select>
          </F>
          <F label="Vendor"><input className="input" disabled={!canDo} value={p.vendorName ?? ''} onChange={(e) => set({ vendorName: e.target.value })} /></F>
          <F label="Payment Type">
            <select className="input" disabled={!canDo} value={p.paymentType} onChange={(e) => set({ paymentType: e.target.value })}>
              <option value="ADVANCE">Advance</option>
              <option value="BALANCE">Balance</option>
              <option value="FULL">Full payment</option>
            </select>
          </F>
        </div>

        {/* Amounts */}
        <div className="grid gap-3 sm:grid-cols-3">
          <F label="Full Amount (manual — per actual qty + freight)"><input type="number" step="any" className="input" disabled={!canDo} value={p.fullAmount} onChange={(e) => set({ fullAmount: Number(e.target.value) })} /></F>
          <F label="Amount to Pay"><input type="number" step="any" className="input" disabled={!canDo} value={p.amountToPay} onChange={(e) => set({ amountToPay: Number(e.target.value) })} /></F>
          <F label="Balance (auto)"><input className="input bg-slate-50 font-semibold text-navy" value={money(save.isPending ? p.balance : previewBalance)} readOnly /></F>
        </div>

        {/* GST toggle */}
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-sm font-medium text-slate-600">Payment amount includes:</span>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" disabled={!canDo} checked={p.gstInclusive} onChange={() => set({ gstInclusive: true })} /> GST (100% inclusive)
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" disabled={!canDo} checked={!p.gstInclusive} onChange={() => set({ gstInclusive: false })} /> Basic value only
          </label>
          {p.gstInclusive && <span className="text-xs text-slate-400">GST {p.gstPct}%</span>}
        </div>

        {/* Payment terms (fetched from PO) */}
        {p.payTermsSnapshot && (
          <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500">
            <span className="font-semibold text-slate-600">Payment terms (from PO): </span>
            {([['Advance', p.payTermsSnapshot.advance], ['Before Dly', p.payTermsSnapshot.beforeDelivery], ['Running', p.payTermsSnapshot.running], ['Post Dly', p.payTermsSnapshot.postDelivery], ['Post Compl', p.payTermsSnapshot.postCompletion], ['Retention', p.payTermsSnapshot.retention]] as const)
              .filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}%`).join(' · ') || '—'}
          </div>
        )}

        {/* Attachments */}
        <div className="grid gap-3 sm:grid-cols-3">
          <F label="PI (Performa Invoice) PDF">
            {p.piPdfUrl ? <button className="text-sm text-navy hover:underline" onClick={() => openFile(p.piPdfUrl!)}>📄 View PI</button> : <span className="text-xs text-slate-400">Not uploaded</span>}
            {canDo && <input type="file" className="input mt-1 text-xs" onChange={(e) => e.target.files?.[0] && upload.mutate({ kind: 'pi', file: e.target.files[0] })} />}
          </F>
          <F label="Vendor KYC PDF (GST + PAN + cheque)">
            {p.kycPdfUrl ? <button className="text-sm text-navy hover:underline" onClick={() => openFile(p.kycPdfUrl!)}>📄 View KYC</button> : <span className="text-xs text-slate-400">Not uploaded</span>}
            {canDo && <input type="file" className="input mt-1 text-xs" onChange={(e) => e.target.files?.[0] && upload.mutate({ kind: 'kyc', file: e.target.files[0] })} />}
          </F>
          <F label="PO (attached)">
            {p.docId ? <button className="text-sm text-navy hover:underline" onClick={() => openAuthedFile(`/projects/${projectId}/procurement/docs/${p.docId}/pdf`)}>📄 Open {p.poNumber}</button> : <span className="text-xs text-slate-400">No PO selected</span>}
          </F>
        </div>

        <F label="Remark (what this payment is regarding)"><textarea className="input" rows={2} disabled={!canDo} value={p.remark ?? ''} onChange={(e) => set({ remark: e.target.value })} /></F>
      </div>

      {showChain && (
        <ChainBuilder
          docType="PAYMENT"
          projectId={projectId}
          amount={Number(p.amountToPay) || 0}
          busy={act.isPending || save.isPending}
          onClose={() => setShowChain(false)}
          onConfirm={async (chain) => { await save.mutateAsync(); act.mutate({ verb: 'submit', body: { chain } }); setShowChain(false); }}
        />
      )}
    </div>
  );

  function openFile(url: string) { url.startsWith('/api/') ? openAuthedFile(url.replace(/^\/api/, '')) : window.open(url, '_blank'); }
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {children}
    </div>
  );
}
