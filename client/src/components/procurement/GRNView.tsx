import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { docStatusPill, fmtDate, inr, titleize } from '../../lib/format';
import ApprovalTimeline from './ApprovalTimeline';
import ChainBuilder from './ChainBuilder';

export default function GRNView({ projectId, focusId }: { projectId: string; role: string; focusId?: string }) {
  const qc = useQueryClient();
  const { canEdit, can } = useAuth();
  const canRaise = canEdit('grn');
  const canApprove = can('canApprove');
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [raising, setRaising] = useState(false);

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

  if (openId) return <GRNForm projectId={projectId} grnId={openId} canApprove={canApprove} onClose={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ['grns', projectId] }); }} />;
  if (grnsQ.isLoading) return <Spinner label="Loading GRNs…" />;
  const grns = grnsQ.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-600">Good Receipt Notes ({grns.length})</h3>
        {canRaise && <button className="btn-primary text-sm" onClick={() => setRaising(true)}>+ Raise GRN</button>}
      </div>

      {raising && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-medium text-slate-600">Raise GRN against an approved PO/WO</div>
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

      {grns.length === 0 ? (
        <EmptyState title="No GRNs yet" hint="When material arrives on site, raise a GRN against the relevant PO/WO to confirm delivery and link the invoice." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">GRN No.</th><th>Against</th><th>Vendor</th><th>Raised by</th><th>Date</th><th className="text-right">PI Value</th><th className="pr-8 text-right">Invoice Value</th><th className="pl-2">Status</th><th></th></tr></thead>
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
                    <span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>
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

function GRNForm({ projectId, grnId, canApprove, onClose }: { projectId: string; grnId: string; canApprove: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { user, canEdit, can } = useAuth();
  const canMarkPaid = can('canMarkPaid');
  // PO pricing arrives already nulled for anyone who may not see it, so a plain
  // null-check is the whole rule here.
  const money = (n: number | null | undefined) => (n == null ? '—' : inr(n));
  const [g, setG] = useState<any>(null);
  // True while piValue is just the PO's default (not typed) — a PI upload may replace it.
  const piValueFromPo = useRef(false);
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
      invoiceNumber: g.invoiceNumber, invoiceDate: g.invoiceDate?.slice?.(0, 10), invoiceValue: g.invoiceValue ? Number(g.invoiceValue) : undefined, ewayBillNumber: g.ewayBillNumber,
      // Payment (GRN/Payment PRD v3 §3) — the milestone being paid, the PI, and the amount.
      milestoneId: g.milestoneId ?? null, milestoneKey: g.milestoneKey ?? null, milestoneName: g.milestoneName ?? null,
      piNumber: g.piNumber ?? null, piDate: g.piDate?.slice?.(0, 10) || null, paymentDueDate: g.paymentDueDate?.slice?.(0, 10) || null, piValue: g.piValue != null && g.piValue !== '' ? Number(g.piValue) : null,
      amountToPay: g.amountToPay != null && g.amountToPay !== '' ? Number(g.amountToPay) : null,
      lineItems: g.lineItems.map((l: any) => ({ id: l.id, receiptQty: Number(l.receiptQty), defectQty: Number(l.defectQty || 0), remarks: l.remarks })),
      ...(amending ? { amendmentRemark: amendRemark } : {}),
    })).data.grn,
    onSuccess: (grn) => {
      const wasAmending = amending;
      setG(structuredClone(grn));
      setMsg(wasAmending ? 'Amendment saved and logged.' : 'Saved.');
      setAmending(false); setAmendRemark('');
      if (wasAmending) setAskResubmit(true);
      qc.invalidateQueries({ queryKey: ['grns', projectId] });
    },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadInvoice = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/invoice`, fd); },
    onSuccess: () => { setMsg('Invoice uploaded.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); },
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
  const act = useMutation({ mutationFn: (v: { verb: string; body?: any }) => api.post(`/projects/${projectId}/procurement/grns/${grnId}/${v.verb}`, v.body ?? {}), onSuccess: () => { qc.invalidateQueries({ queryKey: ['grn', grnId] }); qc.invalidateQueries({ queryKey: ['grns', projectId] }); }, onError: (e) => setMsg(errMsg(e)) });
  // Accounts record the UTR (§5–§6). Marking paid does NOT close the entry — the
  // tax invoice does — so a "paid but open" GRN is a real state.
  const markPaid = useMutation({
    mutationFn: async (utr: string) => (await api.post(`/projects/${projectId}/procurement/grns/${grnId}/mark-paid`, { utrNumber: utr })).data.grn,
    onSuccess: () => { setMsg('Marked paid — the entry stays open until the tax invoice is uploaded.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); qc.invalidateQueries({ queryKey: ['grns', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // The tax invoice arrives AFTER approval on a payment GRN (§6), so recording its
  // number/date/value is the closing step — not an amendment. This patches ONLY
  // those fields, which the server accepts without an amendment reason.
  const saveTaxInvoice = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/grns/${grnId}`, {
      invoiceNumber: g.invoiceNumber ?? null,
      invoiceDate: g.invoiceDate?.slice?.(0, 10) || null,
      invoiceValue: g.invoiceValue != null && g.invoiceValue !== '' ? Number(g.invoiceValue) : null,
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

  if (isLoading || !g) return <Spinner label="Loading GRN…" />;
  const approved = g.status === 'APPROVED';
  const canEditGrn = canEdit('grn');
  // Draft is freely editable; an approved GRN only while amending (with a reason).
  // ON_HOLD came back from an approver with a note — it must be editable so the
  // raiser can correct it and resubmit.
  const editable = g.status === 'DRAFT' || g.status === 'ON_HOLD' || (approved && amending);
  const amendments: { at: string; byName: string; byEmail: string; remark: string }[] = g.amendments ?? [];

  // Approval-chain state (mirrors DocBuilder).
  const approval = grnQ.data?.approval as { steps: any[]; total: number; currentApproverId?: string | null } | undefined;
  const hasChain = (approval?.total ?? 0) > 0;
  const myTurn = !!approval?.currentApproverId && approval.currentApproverId === user?.id;
  const canAct = g.status === 'OPEN' && (hasChain ? (myTurn || canApprove) : canApprove);
  // Payment (§3): PO milestones for the term dropdown + the advance already paid,
  // which auto-captures so the balance can compute.
  const milestones: any[] = grnQ.data?.milestones ?? [];
  const advanceOnPo: number = grnQ.data?.advanceOnPo ?? 0;
  // The vendor's KYC set (GST certificate, PAN, cancelled cheque, …), resolved
  // from the vendor master — shown here, never uploaded here.
  const kycDocs: { id: string; kind: string; fileName: string; fileUrl: string }[] = (grnQ.data as any)?.kycDocs ?? [];
  const piValueNum = Number(g.piValue) || 0;
  // Live balance, same formula as the vendor-payment (FMS) form:
  // PI value − (advance already on the PO + what this entry pays).
  const balanceToPay = Math.round((piValueNum - advanceOnPo - (Number(g.amountToPay) || 0)) * 100) / 100;
  const isMilestoneLocked = (m: any) => m.status === 'PAID' || m.status === 'TRIGGERED';
  // Payment lifecycle (§6): TRIGGERED → PAID → CLOSED, running alongside the
  // goods/approval status. A GRN can be PAID but still OPEN (tax invoice pending).
  const payStatus: string | null = g.paymentStatus ?? null;
  const isPaymentGrn = !!g.milestoneId;
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
        <div className="flex items-center gap-2"><button className="btn-outline text-sm" onClick={onClose}>← Back</button><h2 className="text-lg font-bold text-navy">{g.grnNumber}</h2><span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>
          {payStatus && <span className={`badge ${paymentClosed ? 'bg-slate-100 text-slate-600' : paidButOpen ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{paymentClosed ? 'Payment Closed' : paidButOpen ? 'Paid · tax invoice pending' : 'Payment Triggered'}</span>}
        </div>
        <div className="flex gap-2">
          {canRecordPaid && <button className="btn-primary text-sm" disabled={markPaid.isPending} onClick={doMarkPaid}>💳 Mark Paid</button>}
          {g.status === 'APPROVED' && <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${grnId}/pdf`, `${g?.grnNumber || 'GRN'}.pdf`)}>📄 Download PDF</button>}
          {/* Internal copy with the FINAL APPROVAL stamp; clean one goes to the vendor. */}
          {g.status === 'APPROVED' && <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${grnId}/pdf?approvals=1`, `${g?.grnNumber || 'GRN'} - Approved.pdf`)}>🕒 With Approval</button>}
          {approved && canEditGrn && !amending && <button className="btn-outline text-sm" onClick={() => { setAmending(true); setMsg(''); }}>✎ Amend</button>}
          {amending && <button className="btn-outline text-sm" onClick={() => { setAmending(false); setAmendRemark(''); setG(structuredClone(grnQ.data!.grn)); }}>Cancel amend</button>}
          {editable && (
            <button className="btn-primary text-sm" disabled={save.isPending || (amending && amendRemark.trim().length < 3)} onClick={() => save.mutate()}>
              {amending ? 'Save amendment' : 'Save'}
            </button>
          )}
          {(g.status === 'DRAFT' || g.status === 'ON_HOLD') && <button className="btn-primary text-sm" onClick={() => setShowChain(true)}>{g.status === 'ON_HOLD' ? 'Resubmit' : 'Submit'}</button>}
          {g.status === 'OPEN' && hasChain && <button className="btn-outline text-sm" disabled={act.isPending} onClick={() => act.mutate({ verb: 'remind' })}>Send Reminder</button>}
          {/* Approvers see the document itself before deciding. */}
          {canAct && <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/procurement/grns/${grnId}/pdf`, `${g?.grnNumber || 'GRN'}.pdf`)}>📄 Download GRN</button>}
          {canAct && <button className="btn-primary text-sm" onClick={() => promptRemarks('approve')}>✓ Approve</button>}
          {canAct && <button className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600" onClick={() => promptRemarks('hold')}>⏸ Put On Hold</button>}
        </div>
      </div>
      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}

      {approved && !amending && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          This GRN is approved and locked.{canEditGrn ? ' Use “Amend” above to change it — a reason is required and every change is logged below.' : ''}
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

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Delivery Details</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <G label="Vehicle Number" v={g.vehicleNumber} on={(x) => setG({ ...g, vehicleNumber: x })} ed={editable} />
          <G label="Driver Name" v={g.driverName} on={(x) => setG({ ...g, driverName: x })} ed={editable} />
          <G label="Delivery Challan No." v={g.deliveryChallanNumber} on={(x) => setG({ ...g, deliveryChallanNumber: x })} ed={editable} />
        </div>
      </div>

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

      <div className="card p-4">
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
              {canUploadTaxInvoice && <input className="input mt-1 text-xs" type="file" accept=".pdf,image/*" onChange={(e) => e.target.files?.[0] && uploadInvoice.mutate(e.target.files[0])} />}
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
      </div>

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
                  // Picking a term pre-fills what it's worth (still editable for a
                  // partial payment) — same behaviour as the vendor-payment form.
                  setG({
                    ...g, milestoneId: m?.id ?? null, milestoneKey: m?.fieldKey ?? null, milestoneName: m?.name ?? null,
                    amountToPay: m?.inrAmount != null ? m.inrAmount : g.amountToPay,
                  });
                }}
              >
                <option value="">Select a payment term…</option>
                {milestones.map((m) => (
                  <option key={m.id} value={m.id} disabled={isMilestoneLocked(m) && m.id !== g.milestoneId}>
                    {m.name}{m.percentage ? ` (${m.percentage}%)` : ''}{m.inrAmount != null ? ` — ${inr(m.inrAmount)}` : ''}{isMilestoneLocked(m) ? ` · ${titleize(m.status)}` : ''}
                  </option>
                ))}
              </select>
              {milestones.length === 0 && <div className="mt-1 text-[11px] text-slate-400">This PO has no payment terms defined.</div>}
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

          {/* The PO's terms, same strip as the FMS form. */}
          {milestones.length > 0 && (
            <div className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-600">Payment terms (from PO): </span>
              {milestones.filter((m) => m.percentage).map((m) => `${m.name} ${m.percentage}%`).join(' · ') || '—'}
            </div>
          )}

          {/* Attachments — the PI drives the payment; the tax invoice lives in its
              own card above; the PO this GRN is against is one click away. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <F label="PI (Proforma Invoice) PDF *">
              {g.piPdfUrl
                ? <a className="text-sm text-navy hover:underline" href={g.piPdfUrl} target="_blank" rel="noreferrer">📄 View PI</a>
                : <span className="text-xs text-slate-400">Not uploaded</span>}
              {editable && <input className="input mt-1 text-xs" type="file" accept=".pdf,image/*" onChange={(e) => e.target.files?.[0] && uploadPI.mutate(e.target.files[0])} />}
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
            {paidButOpen && <div className="mt-2 text-[11px] text-emerald-700">Paid, but this entry stays open until the tax invoice is uploaded below — then it closes and leaves the bucket.</div>}
            {paymentClosed && <div className="mt-2 text-[11px] text-slate-500">Closed — paid and the tax invoice is on file.</div>}
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
