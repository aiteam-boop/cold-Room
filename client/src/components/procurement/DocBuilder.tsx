import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import { docStatusPill, inr, titleize } from '../../lib/format';
import DocPaper, { vendorBlock } from './DocPaper';
import ApprovalTimeline from './ApprovalTimeline';
import ChainBuilder from './ChainBuilder';
import { DeliveryBadge, isoDay } from '../DeliveryBadge';

// Common units of measure for Work Order line items. The line's existing value
// is merged in at render time so custom / legacy units are never dropped.
const UOM_OPTIONS = [
  'Nos.', 'Pcs', 'Set', 'Pair', 'Lot', 'Job',
  'Meter', 'RMT', 'Sq.M', 'Cu.M', 'Sq.Ft', 'Ft',
  'Kg', 'MT', 'Ton', 'Liter', 'Roll', 'Bundle', 'Box', 'Bag',
  'Hour', 'Day', 'Month',
];

const PAY = [
  { key: 'payAdvancePct', label: 'Advance' },
  { key: 'payBeforeDeliveryPct', label: 'Before Delivery' },
  { key: 'payRunningPct', label: 'Running' },
  { key: 'payPostDeliveryPct', label: 'Post Delivery' },
  { key: 'payPostCompletionPct', label: 'Post Completion' },
  { key: 'payRetentionPct', label: 'Retention' },
] as const;

export default function DocBuilder({ projectId, docId, onClose }: { projectId: string; docId: string; role: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { canEdit, can, user, hideFinancials } = useAuth();
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [view, setView] = useState<'document' | 'form'>('document');
  const [showChain, setShowChain] = useState(false);
  // Post-approval amendment: an approved doc is locked until the editor opts to
  // amend it, which then requires a written reason on save.
  const [amending, setAmending] = useState(false);
  const [amendRemark, setAmendRemark] = useState('');
  // After saving an amendment, offer to resubmit for fresh approval.
  const [askResubmit, setAskResubmit] = useState(false);
  // When true, the chain builder RE-submits the amended doc without re-saving.
  const [resubmitMode, setResubmitMode] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['proc-doc', docId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/docs/${docId}`)).data as { doc: any; approval?: any } });
  const vendorsQ = useQuery({ queryKey: ['proc-vendors', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/vendors`)).data.vendors as any[] });
  // Same queryKey + shape as BOQTab so the React Query cache isn't corrupted.
  const boqQ = useQuery({ queryKey: ['boq', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data });
  const boqItems: any[] = (boqQ.data?.items ?? []).filter((i: any) => !i.isGroup);
  useEffect(() => { if (data?.doc) setD(structuredClone(data.doc)); }, [data]);

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/docs/${docId}`, {
      docNumber: d.docNumber,
      vendorId: d.vendorId, vendorName: d.vendorName, vendorAddress: d.vendorAddress, vendorGstin: d.vendorGstin, vendorContact: d.vendorContact, vendorPhone: d.vendorPhone,
      againstQuotation: d.againstQuotation, invoiceTo: d.invoiceTo, shipTo: d.shipTo, siteAddress: d.siteAddress,
      promisedDeliveryDate: d.promisedDeliveryDate || null, requiredByDate: d.requiredByDate || null,
      gstEnabled: d.gstEnabled, gstPct: Number(d.gstPct),
      payAdvancePct: Number(d.payAdvancePct), payBeforeDeliveryPct: Number(d.payBeforeDeliveryPct), payRunningPct: Number(d.payRunningPct),
      payPostDeliveryPct: Number(d.payPostDeliveryPct), payPostCompletionPct: Number(d.payPostCompletionPct), payRetentionPct: Number(d.payRetentionPct),
      payGstInclusive: !!d.payGstInclusive,
      customColumns: d.customColumns ?? [],
      payTriggers: d.payTriggers, termsSections: d.termsSections,
      lineItems: d.lineItems.map((l: any, i: number) => ({ srNo: i + 1, description: l.description, uom: l.uom, qty: Number(l.qty), unitPrice: Number(l.unitPrice), totalPrice: l.totalOverride != null ? Number(l.totalPrice) : undefined, isLeadTime: l.isLeadTime, leadTimeText: l.leadTimeText, customValues: l.customValues ?? {}, boqItemId: l.boqItemId ?? null })),
      // Only sent when amending an approved doc — the server logs it and requires it.
      ...(amending ? { amendmentRemark: amendRemark } : {}),
    })).data.doc,
    onSuccess: (doc) => {
      const wasAmending = amending;
      setD(structuredClone(doc));
      setMsg({ ok: true, t: wasAmending ? 'Amendment saved and logged.' : 'Saved.' });
      setAmending(false); setAmendRemark('');
      // After an amendment, ask whether to send it back through approval.
      if (wasAmending) setAskResubmit(true);
      qc.invalidateQueries({ queryKey: ['proc-doc', docId] });
      qc.invalidateQueries({ queryKey: ['proc-docs', projectId] });
      qc.invalidateQueries({ queryKey: ['boq-cost', projectId] });
    },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  // Backfill the delivery commitment on a document that was approved before this
  // field existed. Its own endpoint, because PATCH refuses approved documents.
  const setDelivery = useMutation({
    mutationFn: async (body: { promisedDeliveryDate: string | null; requiredByDate: string | null }) =>
      (await api.post(`/projects/${projectId}/procurement/docs/${docId}/delivery`, body)).data.doc,
    onSuccess: (doc) => {
      setD(structuredClone(doc));
      setMsg({ ok: true, t: 'Delivery date recorded.' });
      qc.invalidateQueries({ queryKey: ['proc-doc', docId] });
      qc.invalidateQueries({ queryKey: ['proc-docs', projectId] });
    },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  const doAction = useMutation({
    mutationFn: async (vars: { verb: string; body?: any }) => (await api.post(`/projects/${projectId}/procurement/docs/${docId}/${vars.verb}`, vars.body ?? {})).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['proc-doc', docId] }); setMsg({ ok: true, t: 'Done.' }); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  if (isLoading || !d) return <Spinner label="Loading document…" />;
  const isWO = d.type === 'WO';
  const canEditDoc = canEdit(isWO ? 'wo' : 'po');
  const canApprove = can('canApprove');
  const approved = d.status === 'APPROVED';
  // An approved doc is locked unless the editor has chosen to amend it.
  const locked = approved && !amending;
  const editable = (!approved || amending) && canEditDoc;
  const amendments: { at: string; byName: string; byEmail: string; remark: string }[] = d.amendments ?? [];

  // Approval-chain state. Whose turn it is drives which action buttons show.
  const approval = data?.approval as { steps: any[]; total: number; currentApproverId?: string | null } | undefined;
  const hasChain = (approval?.total ?? 0) > 0;
  const myTurn = !!approval?.currentApproverId && approval.currentApproverId === user?.id;
  // Show Approve/On Hold to the current approver, or (legacy, no chain) to canApprove holders.
  const canAct = d.status === 'PENDING_APPROVAL' && (hasChain ? (myTurn || canApprove) : canApprove);
  // Approvers never reject: they put the document ON HOLD with a note saying what
  // to correct, and the raiser fixes it and resubmits.
  const promptRemarks = (verb: 'approve' | 'hold') => {
    const r = window.prompt(verb === 'hold' ? 'What needs to be corrected? (required)' : 'Remarks (optional)') ?? (verb === 'approve' ? '' : null);
    if (verb === 'hold' && !r?.trim()) return;
    doAction.mutate({ verb, body: verb === 'hold' ? { reason: r } : { remarks: r } });
  };

  const payTotal = PAY.reduce((s, p) => s + (Number(d[p.key]) || 0), 0);
  const basic = d.lineItems.filter((l: any) => !l.isLeadTime).reduce((s: number, l: any) => s + (Number(l.qty) * Number(l.unitPrice) || 0), 0);
  const finalAmt = d.gstEnabled ? basic + Math.round(basic * (Number(d.gstPct) / 100)) : basic;
  // The base each payment-term % is computed from — final (incl. GST) when the PO
  // is GST-inclusive, else the basic. Milestones on the server use the same rule.
  const payBase = d.payGstInclusive ? finalAmt : basic;
  const struck = (d.termsSections || []).filter((s: any) => s.isStruckOff).length;

  function setLine(i: number, patch: any) {
    setD((p: any) => { const li = [...p.lineItems]; li[i] = { ...li[i], ...patch }; return { ...p, lineItems: li }; });
  }
  function addLine(lead = false) { setD((p: any) => ({ ...p, lineItems: [...p.lineItems, { description: '', qty: 0, unitPrice: 0, totalPrice: 0, uom: isWO ? 'Nos.' : null, isLeadTime: lead, leadTimeText: lead ? '7 Days' : null }] })); }
  function delLine(i: number) { setD((p: any) => ({ ...p, lineItems: p.lineItems.filter((_: any, idx: number) => idx !== i) })); }

  function selectVendor(id: string) {
    const v = vendorsQ.data?.find((x) => x.id === id);
    // Fill the "To," block from the same builder the document view uses, so both
    // vendor pickers produce the identical letterhead (name, address, Tel/Fax,
    // Website, GSTIN, CIN) — this one used to drop in the bare address only.
    setD((p: any) => ({ ...p, vendorId: id || null, vendorName: v?.name ?? p.vendorName, vendorAddress: v ? vendorBlock(v) : p.vendorAddress, vendorGstin: v?.gstin ?? p.vendorGstin, vendorContact: v?.contactPerson ?? p.vendorContact, vendorPhone: v?.phones ?? p.vendorPhone }));
  }

  // Linking a PO line to a BOQ item is what makes the BOQ Cost view work
  // (Sprint PRD §6.3). Description, unit and model are pulled from the BOQ so
  // they match exactly — Amisha never re-types them.
  async function selectBoqItem(i: number, boqItemId: string) {
    if (!boqItemId) { setLine(i, { boqItemId: null }); return; }
    const b = boqItems.find((x) => x.id === boqItemId);
    if (!b) return;
    const description = [b.description, b.makeModel].filter(Boolean).join('\n');
    setLine(i, { boqItemId, description, uom: b.unit ?? null });

    // Auto-suggest this vendor's current rate for the item; Amisha can override.
    if (!d.vendorId) return;
    try {
      const r = await api.get(`/projects/${projectId}/procurement/vendors/${d.vendorId}/rate`, { params: { item: b.description } });
      const rate = r.data?.suggested?.rate;
      if (rate != null) setLine(i, { unitPrice: rate });
    } catch { /* no rate chart / no permission — leave the price as typed */ }
  }

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button className="btn-outline text-sm" onClick={onClose}>← Back</button>
          <h2 className="text-lg font-bold text-navy">{d.docNumber}</h2>
          <span className={`badge ${docStatusPill(d.status)}`}>{titleize(d.status)}</span>
          {d.esignApplied && <span className="badge bg-blue-100 text-blue-700">✓ e-signed</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-xs">
            <button onClick={() => setView('document')} className={`rounded px-2 py-1 font-medium ${view === 'document' ? 'bg-white text-navy shadow-sm' : 'text-slate-500'}`}>Document</button>
            <button onClick={() => setView('form')} className={`rounded px-2 py-1 font-medium ${view === 'form' ? 'bg-white text-navy shadow-sm' : 'text-slate-500'}`}>Form</button>
          </div>
          <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/procurement/docs/${docId}/pdf`, `${d.docNumber || 'document'}.pdf`)}>📄 Download PDF</button>
          {/* Approved docs are locked. "Amend" unlocks them, and Save then needs a reason. */}
          {approved && canEditDoc && !amending && (
            <button className="btn-outline text-sm" onClick={() => { setAmending(true); setView('form'); setMsg(null); }}>✎ Amend</button>
          )}
          {amending && <button className="btn-outline text-sm" onClick={() => { setAmending(false); setAmendRemark(''); setD(structuredClone(data!.doc)); }}>Cancel amend</button>}
          {editable && (
            <button
              className="btn-primary text-sm"
              disabled={save.isPending || (amending && amendRemark.trim().length < 3)}
              title={amending && amendRemark.trim().length < 3 ? 'Enter a reason for the amendment first' : undefined}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : amending ? 'Save amendment' : 'Save'}
            </button>
          )}
          {/* ChainBuilder decides: with an admin-configured Approval Chain it
              submits straight through with no popup; without one it falls back
              to the matrix / free-form picker as before. */}
          {editable && (d.status === 'DRAFT' || d.status === 'ON_HOLD') && (
            <button className="btn-primary text-sm" disabled={save.isPending || doAction.isPending}
              onClick={() => setShowChain(true)}>
              {doAction.isPending ? 'Submitting…' : d.status === 'ON_HOLD' ? 'Resubmit for Approval' : 'Submit for Approval'}
            </button>
          )}
          {canEditDoc && d.status === 'PENDING_APPROVAL' && <button className="btn-outline text-sm" onClick={() => doAction.mutate({ verb: 'recall' })}>Recall</button>}
          {canEditDoc && d.status === 'PENDING_APPROVAL' && hasChain && <button className="btn-outline text-sm" disabled={doAction.isPending} onClick={() => doAction.mutate({ verb: 'remind' })}>Send Reminder</button>}
          {/* Approvers see the document itself before deciding. */}
          {canAct && <button className="btn-outline text-sm" onClick={() => openAuthedFile(`/projects/${projectId}/procurement/docs/${d.id}/pdf`)}>👁 View {d.type}</button>}
          {canAct && <button className="btn-primary text-sm" onClick={() => promptRemarks('approve')}>✓ Approve</button>}
          {canAct && <button className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600" onClick={() => promptRemarks('hold')}>⏸ Put On Hold</button>}
        </div>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.t}</div>}
      {/* Sent back by an approver: show exactly what they asked to be corrected. */}
      {d.status === 'ON_HOLD' && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5">
          <div className="text-sm font-semibold text-orange-800">⏸ On hold — correct this and resubmit</div>
          {d.rejectionReason && <div className="mt-1 text-sm text-orange-900">{d.rejectionReason}</div>}
          <div className="mt-1 text-[11px] text-orange-700">Fix the points above, Save, then Resubmit for approval.</div>
        </div>
      )}
      {hasChain && <ApprovalTimeline approval={approval as any} />}
      {showChain && (
        <ChainBuilder
          docType={isWO ? 'WO' : 'PO'}
          projectId={projectId}
          amount={Number(d.finalAmount) || 0}
          busy={doAction.isPending || save.isPending}
          onClose={() => { setShowChain(false); setResubmitMode(false); }}
          onConfirm={async (chain) => {
            // Resubmit after amendment: the amendment is already saved, so just
            // submit. A fresh draft submit saves first, then submits.
            if (!resubmitMode) await save.mutateAsync();
            doAction.mutate({ verb: 'submit', body: { chain } });
            setShowChain(false); setResubmitMode(false);
          }}
        />
      )}
      {d.rejectionReason && d.status !== 'APPROVED' && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">Last rejection: {d.rejectionReason}</div>}
      {locked && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">
          This {d.type} is approved and locked.{canEditDoc ? ' Use “Amend” above to change it — a reason is required and every change is logged below.' : ''}
        </div>
      )}

      {/* After an amendment: send back through approval, or keep as amended. */}
      {askResubmit && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-navy/20 bg-navy/5 px-3 py-2.5">
          <div className="text-sm text-navy">
            Amendment saved. Do you want to <strong>resubmit this {d.type} for approval</strong>?
          </div>
          <div className="flex gap-2">
            <button className="btn-primary text-sm" onClick={() => { setAskResubmit(false); setResubmitMode(true); setShowChain(true); }}>
              Resubmit for approval
            </button>
            <button className="btn-outline text-sm" onClick={() => setAskResubmit(false)}>
              No, keep as amended
            </button>
          </div>
        </div>
      )}

      {/* Amendment reason input — shown while amending an approved doc. */}
      {amending && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-amber-700">Reason for amending this approved {d.type} *</label>
          <textarea
            className="input text-sm"
            rows={2}
            value={amendRemark}
            onChange={(e) => setAmendRemark(e.target.value)}
            placeholder="e.g. Vendor revised the delivery quantity for line 1 after approval"
          />
          <div className="mt-1 text-[11px] text-amber-700">This reason and your name &amp; email are saved to the amendment history and shown to everyone.</div>
        </div>
      )}

      {/* Post-approval amendment history — visible to everyone who opens the doc. */}
      {amendments.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Amendments after approval ({amendments.length})
          </div>
          <ol className="divide-y divide-slate-100">
            {[...amendments].reverse().map((a, i) => (
              <li key={i} className="px-3 py-2 text-sm">
                <div className="text-slate-700">{a.remark}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  {a.byName}{a.byEmail ? ` · ${a.byEmail}` : ''} · {new Date(a.at).toLocaleString('en-GB')}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {view === 'document' && <DocPaper d={d} setD={setD} editable={editable} vendors={vendorsQ.data ?? []} />}

      {view === 'form' && <>
      {/* Vendor + header */}
      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Vendor / {isWO ? 'Contractor' : 'Supplier'} & Header</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Select vendor (site-filtered)</label>
            <select className="input" disabled={!editable} value={d.vendorId || ''} onChange={(e) => selectVendor(e.target.value)}>
              <option value="">— choose / manual —</option>
              {vendorsQ.data?.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.kycStatus})</option>)}
            </select>
          </div>
          <F label="Against Quotation" v={d.againstQuotation} on={(x) => setD({ ...d, againstQuotation: x })} ed={editable} />
          <F label="Vendor Name" v={d.vendorName} on={(x) => setD({ ...d, vendorName: x })} ed={editable} />
          <F label="Vendor GSTIN" v={d.vendorGstin} on={(x) => setD({ ...d, vendorGstin: x })} ed={editable} />
          <FT label="Vendor Address" v={d.vendorAddress} on={(x) => setD({ ...d, vendorAddress: x })} ed={editable} />
          <div className="grid gap-3">
            <F label="Contact Person" v={d.vendorContact} on={(x) => setD({ ...d, vendorContact: x })} ed={editable} />
            <F label="Phone" v={d.vendorPhone} on={(x) => setD({ ...d, vendorPhone: x })} ed={editable} />
          </div>
          <FT label="Invoice To" v={d.invoiceTo} on={(x) => setD({ ...d, invoiceTo: x })} ed={editable} />
          <FT label={isWO ? 'Site Address' : 'Ship To'} v={isWO ? d.siteAddress : d.shipTo} on={(x) => setD(isWO ? { ...d, siteAddress: x } : { ...d, shipTo: x })} ed={editable} />
        </div>
      </div>

      {/* Delivery commitment — what the vendor is held to, and what "delivered on
          time?" is measured against. The actual date comes from the GRN.
          An approved document with no promised date may still be backfilled once;
          an existing commitment is frozen with the rest of the signed document. */}
      {(() => {
        const canBackfill = locked && canEditDoc && !d.promisedDeliveryDate;
        const dateEditable = editable || canBackfill;
        return (
          <div className="card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-600">Delivery Schedule</div>
              {canBackfill && (
                <button className="btn-primary text-xs" disabled={setDelivery.isPending || !d.promisedDeliveryDate}
                  onClick={() => setDelivery.mutate({ promisedDeliveryDate: d.promisedDeliveryDate ?? null, requiredByDate: d.requiredByDate ?? null })}>
                  {setDelivery.isPending ? 'Saving…' : 'Set delivery date'}
                </button>
              )}
            </div>

            {canBackfill && (
              <div className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                This {d.type} was approved before a delivery date was recorded. You may set it once here — after that it is
                frozen with the document, so on-time reporting cannot be rewritten after the fact.
              </div>
            )}
            {locked && d.promisedDeliveryDate && (
              <div className="mb-3 rounded bg-slate-50 px-3 py-2 text-xs text-slate-500">
                The delivery commitment is part of the approved document and cannot be changed. Raise a revised {d.type} to renegotiate it.
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="label">Promised Delivery Date <span className="text-slate-400">(vendor's commitment)</span></label>
                <input type="date" className="input" disabled={!dateEditable}
                  value={isoDay(d.promisedDeliveryDate)}
                  onChange={(e) => setD({ ...d, promisedDeliveryDate: e.target.value || null })} />
                <div className="mt-1 text-[11px] text-slate-400">Printed on the {isWO ? 'WO' : 'PO'}. Drives on-time delivery reporting.</div>
              </div>
              <div>
                <label className="label">Required By <span className="text-slate-400">(site need date)</span></label>
                <input type="date" className="input" disabled={!dateEditable}
                  value={isoDay(d.requiredByDate)}
                  onChange={(e) => setD({ ...d, requiredByDate: e.target.value || null })} />
              </div>
              <div>
                <label className="label">Actual Delivery</label>
                <DeliveryBadge delivery={d.delivery} />
              </div>
            </div>
          </div>
        );
      })()}

      {/* Line items */}
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between"><div className="text-sm font-semibold text-slate-600">Line Items</div>
          {editable && <div className="flex gap-2"><button className="btn-outline text-xs" onClick={() => addLine(false)}>+ Row</button>{isWO && <button className="btn-outline text-xs" onClick={() => addLine(true)}>+ Lead Time</button>}</div>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="w-8">#</th><th>Description</th><th className="w-52">BOQ Item</th>{isWO && <th className="w-20">UOM</th>}<th className="w-20">Qty</th><th className="w-28">Unit Price</th><th className="w-28 text-right">Total</th>{editable && <th></th>}</tr></thead>
            <tbody>
              {d.lineItems.map((l: any, i: number) => l.isLeadTime ? (
                <tr key={i} className="border-b border-slate-100 bg-purple-50/40">
                  <td className="py-1 text-center text-purple-500">⏱</td>
                  <td colSpan={isWO ? 4 : 3}><input className="input bg-transparent text-purple-700" disabled={!editable} value={l.leadTimeText || ''} onChange={(e) => setLine(i, { leadTimeText: e.target.value })} placeholder="Lead Time e.g. 7 Days" /></td>
                  <td colSpan={2}></td>{editable && <td><button className="text-slate-300 hover:text-red-500" onClick={() => delLine(i)}>✕</button></td>}
                </tr>
              ) : (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="py-1 text-center text-slate-400">{i + 1}</td>
                  <td><textarea className="input min-h-[38px] text-xs" disabled={!editable} rows={Math.min((l.description || '').split('\n').length + 1, 6)} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                  <td>
                    {/* Optional but strongly recommended: without it this line's cost
                        never reaches the BOQ Cost sheet and shows up as "unlinked". */}
                    <select className="input text-xs" disabled={!editable} value={l.boqItemId || ''} onChange={(e) => selectBoqItem(i, e.target.value)}>
                      <option value="">— not linked —</option>
                      {boqItems.map((b) => <option key={b.id} value={b.id}>{b.srNo ? `${b.srNo}. ` : ''}{(b.description || '').slice(0, 50)}</option>)}
                    </select>
                    {!l.boqItemId && !!l.description?.trim() && <div className="mt-0.5 text-[10px] text-amber-600">Unlinked — cost won’t appear in BOQ Cost</div>}
                  </td>
                  {isWO && <td>
                    <select className="input" disabled={!editable} value={l.uom || ''} onChange={(e) => setLine(i, { uom: e.target.value })}>
                      <option value="">—</option>
                      {(l.uom && !UOM_OPTIONS.includes(l.uom) ? [l.uom, ...UOM_OPTIONS] : UOM_OPTIONS).map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </td>}
                  <td><input className="input" type="number" disabled={!editable} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} /></td>
                  <td><input className="input" type="number" disabled={!editable} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></td>
                  <td className="text-right font-medium">{inr(Number(l.qty) * Number(l.unitPrice) || 0)}</td>
                  {editable && <td><button className="text-slate-300 hover:text-red-500" onClick={() => delLine(i)}>✕</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Totals */}
        <div className="mt-3 flex justify-end">
          <div className="w-72 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Basic Amount</span><span className="font-semibold">{inr(basic)}</span></div>
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-1 text-slate-500">{isWO && <input type="checkbox" disabled={!editable} checked={d.gstEnabled} onChange={(e) => setD({ ...d, gstEnabled: e.target.checked })} />}GST
                {d.gstEnabled && <select className="ml-1 rounded border border-slate-300 px-1 text-xs" disabled={!editable} value={d.gstPct} onChange={(e) => setD({ ...d, gstPct: Number(e.target.value) })}>{[0, 5, 12, 18, 28].map((g) => <option key={g} value={g}>{g}%</option>)}</select>}
              </label>
              <span>{d.gstEnabled ? inr(Math.round(basic * (Number(d.gstPct) / 100))) : '—'}</span>
            </div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-bold text-navy"><span>Final Amount</span><span>{inr(d.gstEnabled ? basic + Math.round(basic * (Number(d.gstPct) / 100)) : basic)}</span></div>
          </div>
        </div>
      </div>

      {/* 6-field payment terms */}
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-600">Payment Terms (6-field, must total 100%)</div>
          <span className={`badge ${Math.abs(payTotal - 100) < 0.01 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>Total: {payTotal}%</span>
        </div>
        {/* Which amount the % is taken from: FINAL (incl. GST) or BASIC. The
            milestones (Payment Pipeline) follow the same choice. */}
        <div className="mb-3 flex flex-wrap items-center gap-4 rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-xs font-medium text-slate-600">Payment amount includes:</span>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" disabled={!editable} checked={!!d.payGstInclusive} onChange={() => setD({ ...d, payGstInclusive: true })} />
            GST ({d.gstEnabled ? `${d.gstPct}% ` : ''}inclusive) — of {inr(finalAmt)}
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" disabled={!editable} checked={!d.payGstInclusive} onChange={() => setD({ ...d, payGstInclusive: false })} />
            Basic value only — of {inr(basic)}
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {PAY.map((p) => (
            <div key={p.key} className="rounded-lg bg-slate-50 p-2">
              <label className="label">{p.label}</label>
              <div className="flex items-center gap-1">
                <input className="input" type="number" disabled={!editable} value={d[p.key]} onChange={(e) => setD({ ...d, [p.key]: e.target.value })} />
                <span className="text-xs text-slate-400">%</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">{inr(Math.round(payBase * (Number(d[p.key]) / 100)))}</div>
              <input className="input mt-1 text-xs" disabled={!editable} placeholder="Trigger condition note" value={d.payTriggers?.[payKey(p.key)]?.note || ''} onChange={(e) => setD({ ...d, payTriggers: { ...d.payTriggers, [payKey(p.key)]: { ...d.payTriggers?.[payKey(p.key)], note: e.target.value } } })} />
            </div>
          ))}
        </div>
        {Math.abs(payTotal - 100) > 0.01 && <div className="mt-2 text-xs text-red-600">Payment terms must total exactly 100% before submission.</div>}
        {d.milestones?.length > 0 && (
          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Generated Payment Checklist</div>
            {d.milestones.map((m: any) => <div key={m.id} className="flex justify-between text-sm"><span className="text-slate-600">{m.name} · {m.percentage}%</span><span>{inr(m.inrAmount)} <span className="badge bg-slate-100 text-slate-600">{m.status}</span></span></div>)}
          </div>
        )}
      </div>

      {/* T&C — strike-off, not delete (Sprint PRD §8). Standard clauses can be
          edited and struck off; locked clauses are read-only; only custom clauses
          Amisha added can be removed outright. */}
      <div className="card p-4">
        <div className="mb-1 text-sm font-semibold text-slate-600">
          Terms &amp; Conditions ({d.termsSections?.length || 0} sections)
          {struck > 0 && <span className="ml-2 badge bg-slate-100 text-slate-600">{struck} struck off</span>}
        </div>
        <p className="mb-3 text-xs text-slate-400">Struck-off clauses stay in the PDF, crossed out, with a footnote — they are never deleted.</p>
        <div className="space-y-2">
          {(d.termsSections || []).map((s: any, i: number) => {
            const isStruck = !!s.isStruckOff;
            const patch = (p: any) => { const t = [...d.termsSections]; t[i] = { ...t[i], ...p }; setD({ ...d, termsSections: t }); };
            return (
              <details key={i} className={`rounded-lg border ${isStruck ? 'border-slate-200 bg-slate-50' : 'border-slate-200'}`}>
                <summary className={`cursor-pointer px-3 py-2 text-sm font-medium ${isStruck ? 'text-slate-400 line-through' : 'text-navy'}`}>
                  {s.title}
                  {s.isLocked && <span className="ml-2 text-xs" title="Legal / compliance — read only">🔒</span>}
                  {s.isCustom && <span className="ml-2 badge bg-blue-50 text-blue-700">custom</span>}
                </summary>
                <div className="space-y-2 px-3 pb-3">
                  {/* Only custom clauses may be retitled — a standard clause's title
                      is its identity when the server validates the save. */}
                  <input className="input text-sm font-medium" disabled={!editable || !s.isCustom} value={s.title} onChange={(e) => patch({ title: e.target.value })} />
                  <textarea className={`input text-xs ${isStruck ? 'text-slate-400 line-through' : ''}`} rows={3} disabled={!editable || s.isLocked} value={s.text} onChange={(e) => patch({ text: e.target.value })} />
                  {editable && (
                    <div className="flex gap-3">
                      {!s.isLocked && (
                        <button type="button" className={`text-xs hover:underline ${isStruck ? 'text-blue-600' : 'text-amber-600'}`}
                          onClick={() => patch({ isStruckOff: !isStruck, struckOffAt: isStruck ? null : new Date().toISOString() })}>
                          {isStruck ? 'Undo Strike-off' : 'Strike off clause'}
                        </button>
                      )}
                      {s.isCustom
                        ? <button type="button" className="text-xs text-red-500 hover:underline" onClick={() => setD({ ...d, termsSections: d.termsSections.filter((_: any, idx: number) => idx !== i) })}>Delete section</button>
                        : <span className="text-xs text-slate-400">Standard clause — cannot be deleted</span>}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
          {editable && <button type="button" className="btn-outline text-xs" onClick={() => setD({ ...d, termsSections: [...(d.termsSections || []), { title: 'New Section', text: '', isCustom: true, isLocked: false, isStruckOff: false, struckOffAt: null }] })}>+ Add Section</button>}
        </div>
      </div>
      </>}

      {/* Budget vs Actual (BOQ & Budget PRD v1 §5) — sits BELOW the PO. Shows what
          each BOQ item was budgeted at vs what this PO is spending on it, with the
          variance. Internal only; never printed on the vendor PO. Hidden from
          hideFinancials users. */}
      {!hideFinancials && (
        <BudgetVsActual projectId={projectId} docId={docId} docType={d.type} lineItems={d.lineItems} boqItems={boqItems}
          persistedCompareIds={d.budgetCompareItemIds ?? []} poBasic={basic} />
      )}
    </div>
  );
}

// The budget comparison panel on the PO/WO builder. Two ways to compare (PRD §5):
//  • AUTO — every BOQ item this doc's line items are linked to, with its frozen
//    budget pulled in and the doc's spend on that item computed live.
//  • MANUAL — pick any BOQ item from the dropdown to compare against (its budget,
//    unit and qty auto-fetch), or type a budget when the item has none.
function BudgetVsActual({ projectId, docId, docType, lineItems, boqItems, persistedCompareIds, poBasic }: {
  projectId: string; docId: string; docType: string; lineItems: any[]; boqItems: any[];
  persistedCompareIds: string[]; poBasic: number;
}) {
  const money = (n: number | null | undefined) => (n == null ? '—' : inr(n));
  // A PO covers multiple items, so several manual comparison rows can be added.
  // Seeded from what was persisted on the PO, so the comparison survives navigation.
  const [manualRows, setManualRows] = useState<{ boqItemId: string; typedBudget: string }[]>(
    () => (persistedCompareIds ?? []).map((id) => ({ boqItemId: id, typedBudget: '' })),
  );
  const [pick, setPick] = useState('');

  // Persist the picked BOQ items on the PO so they are still here next time.
  const persist = (rows: { boqItemId: string }[]) => {
    api.patch(`/projects/${projectId}/procurement/docs/${docId}/budget-compare`, { itemIds: rows.map((r) => r.boqItemId) }).catch(() => {});
  };

  const sumQ = useQuery({
    queryKey: ['budget-summary', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/budget/summary`)).data as {
      frozen: boolean;
      byItem: Record<string, { description: string; unit: string | null; budgetQty: number | null; budgetRate: number | null; budgetAmount: number | null }>;
    },
  });
  const byItem = sumQ.data?.byItem ?? {};

  // The doc's spend on a given BOQ item = its line totals (qty × unit price).
  const actualForItem = (boqItemId: string) =>
    lineItems.filter((l) => l.boqItemId === boqItemId && !l.isLeadTime)
      .reduce((s, l) => s + (Number(l.qty) * Number(l.unitPrice) || 0), 0);

  // Auto rows: distinct BOQ items this doc's lines are linked to.
  const linkedIds = [...new Set(lineItems.filter((l) => l.boqItemId).map((l) => l.boqItemId as string))];

  // Auto rows: distinct BOQ items this doc's lines are linked to.
  const row = (boqItemId: string, manualBudget?: number | null, isCompare = false) => {
    const b = byItem[boqItemId];
    const meta = boqItems.find((x) => x.id === boqItemId);
    const budget = manualBudget != null ? manualBudget : b?.budgetAmount ?? null;
    const linked = actualForItem(boqItemId);
    // "This PO" for the item: its linked line total. If nothing is line-linked at
    // all AND this is a compare row, fall back to the whole PO basic amount — that's
    // the common single-item PO, so the variance ("kitna farak") is still visible.
    const noLinks = linkedIds.length === 0;
    const actual = linked > 0 ? linked : (isCompare && noLinks ? poBasic : 0);
    const actualIsWholePo = actual > 0 && linked === 0;
    const variance = budget != null && actual > 0 ? Math.round((actual - budget) * 100) / 100 : null;
    const variancePct = variance != null && budget ? Math.round((variance / budget) * 1000) / 10 : null;
    return {
      boqItemId,
      description: b?.description ?? meta?.description ?? '—',
      unit: b?.unit ?? meta?.unit ?? '—',
      budgetQty: b?.budgetQty ?? meta?.plannedQty ?? null,
      budget, actual, actualIsWholePo, variance, variancePct,
      hasBudget: b?.budgetAmount != null,
    };
  };

  const autoRows = linkedIds.map((id) => row(id));
  // Manual rows the user added to compare against (excluding ones already auto-shown).
  const manualRowsData = manualRows
    .filter((m) => !linkedIds.includes(m.boqItemId))
    .map((m) => ({ ...row(m.boqItemId, m.typedBudget !== '' ? Number(m.typedBudget) : undefined, true), _typed: m.typedBudget }));
  const addManual = (id: string) => {
    if (!id || manualRows.some((m) => m.boqItemId === id)) { setPick(''); return; }
    setManualRows((rows) => { const next = [...rows, { boqItemId: id, typedBudget: '' }]; persist(next); return next; });
    setPick('');
  };
  const setTyped = (id: string, v: string) => setManualRows((rows) => rows.map((m) => (m.boqItemId === id ? { ...m, typedBudget: v } : m)));
  const removeManual = (id: string) => setManualRows((rows) => { const next = rows.filter((m) => m.boqItemId !== id); persist(next); return next; });

  return (
    <div className="card p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-600">Budget vs Actual</div>
        {sumQ.data && (
          <span className={`badge ${sumQ.data.frozen ? 'bg-navy/10 text-navy' : 'bg-amber-100 text-amber-700'}`}>
            {sumQ.data.frozen ? '🔒 Budget frozen' : 'Budget draft'}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-slate-400">
        What each BOQ item was budgeted at vs what this {docType} spends on it. Link a line to a BOQ item (in the Form tab) and its budget appears here automatically — or compare against any item below. Internal only; never printed on the {docType}.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="py-1">BOQ Item</th>
              <th>Unit</th>
              <th className="text-right">Budget Qty</th>
              <th className="text-right">Budget</th>
              <th className="text-right">This {docType}</th>
              <th className="text-right">Variance</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {autoRows.length === 0 && manualRowsData.length === 0 && (
              <tr><td colSpan={7} className="py-2 text-xs italic text-slate-400">No BOQ item linked yet — link line items to BOQ items in the Form tab, or add items to compare below.</td></tr>
            )}
            {autoRows.map((r) => <BvaRow key={r.boqItemId} r={r} money={money} />)}
            {manualRowsData.map((r) => (
              <BvaRow key={`m-${r.boqItemId}`} r={r} money={money} manual
                typed={r._typed} onTyped={(v) => setTyped(r.boqItemId, v)} onRemove={() => removeManual(r.boqItemId)} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Add one or more BOQ items to compare — a PO covers several items, so this
          multi-selects (PRD §5). Budget/unit/qty auto-fetch; type a budget for an
          item that has none (dropdown AND typing). */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
        <span className="text-xs text-slate-400">Add item to compare:</span>
        <select className="input h-8 w-72 text-xs" value={pick} onChange={(e) => addManual(e.target.value)}>
          <option value="">— pick a BOQ item —</option>
          {boqItems
            .filter((it) => !linkedIds.includes(it.id) && !manualRows.some((m) => m.boqItemId === it.id))
            .map((it) => (
              <option key={it.id} value={it.id}>{it.description?.slice(0, 60)}{byItem[it.id]?.budgetAmount != null ? '  ✓ budgeted' : ''}</option>
            ))}
        </select>
        {manualRows.length > 0 && <button type="button" className="text-xs text-slate-400 hover:text-red-500" onClick={() => { setManualRows([]); persist([]); }}>clear all</button>}
      </div>
    </div>
  );
}

function BvaRow({ r, money, manual, typed, onTyped, onRemove }: {
  r: { boqItemId: string; description: string; unit: string; budgetQty: number | null; budget: number | null; actual: number; actualIsWholePo?: boolean; variance: number | null; variancePct: number | null; hasBudget: boolean };
  money: (n: number | null | undefined) => string; manual?: boolean;
  typed?: string; onTyped?: (v: string) => void; onRemove?: () => void;
}) {
  const under = r.variance != null && r.variance <= 0;
  return (
    <tr className="border-t border-slate-100">
      <td className="py-1.5 text-xs text-slate-700">
        {r.description.slice(0, 55)}
        {manual && <span className="badge ml-1 bg-slate-100 text-slate-500">compare</span>}
      </td>
      <td className="text-xs text-slate-500">{r.unit}</td>
      <td className="text-right text-xs text-slate-500">{r.budgetQty ?? '—'}</td>
      <td className="text-right text-xs font-medium text-slate-700">
        {/* An item with no frozen budget can be compared against a typed figure. */}
        {!r.hasBudget && manual && onTyped
          ? <input className="input h-6 w-24 text-right text-xs" type="number" placeholder="budget ₹" value={typed ?? ''} onChange={(e) => onTyped(e.target.value)} />
          : money(r.budget)}
      </td>
      <td className="text-right text-xs font-medium text-navy">
        {r.actual > 0 ? money(r.actual) : '—'}
        {r.actualIsWholePo && <div className="text-[9px] font-normal text-slate-400">whole PO</div>}
      </td>
      <td className="text-right text-xs">
        {r.variance == null
          ? <span className="text-slate-300">—</span>
          : <span className={`font-medium ${under ? 'text-green-700' : 'text-red-600'}`} title={under ? 'Under budget' : 'Over budget'}>
              {under ? '−' : '+'}{money(Math.abs(r.variance))}{r.variancePct != null && <span className="ml-1 text-[10px] font-normal">({r.variancePct > 0 ? '+' : ''}{r.variancePct}%)</span>}
            </span>}
      </td>
      <td className="text-right">
        {onRemove && <button type="button" className="text-xs text-slate-300 hover:text-red-500" title="Remove" onClick={onRemove}>✕</button>}
      </td>
    </tr>
  );
}

function payKey(stateKey: string): string {
  return ({ payAdvancePct: 'advance', payBeforeDeliveryPct: 'beforeDelivery', payRunningPct: 'running', payPostDeliveryPct: 'postDelivery', payPostCompletionPct: 'postCompletion', payRetentionPct: 'retention' } as any)[stateKey];
}

function F({ label, v, on, ed }: { label: string; v: any; on: (x: string) => void; ed: boolean }) {
  return <div><label className="label">{label}</label><input className="input" disabled={!ed} value={v || ''} onChange={(e) => on(e.target.value)} /></div>;
}
function FT({ label, v, on, ed }: { label: string; v: any; on: (x: string) => void; ed: boolean }) {
  return <div><label className="label">{label}</label><textarea className="input text-xs" rows={3} disabled={!ed} value={v || ''} onChange={(e) => on(e.target.value)} /></div>;
}
