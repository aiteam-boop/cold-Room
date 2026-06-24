import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import { docStatusPill, inr, titleize } from '../../lib/format';
import DocPaper from './DocPaper';

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
  const { canEdit, can } = useAuth();
  const [d, setD] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [view, setView] = useState<'document' | 'form'>('document');

  const { data, isLoading } = useQuery({ queryKey: ['proc-doc', docId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/docs/${docId}`)).data.doc });
  const vendorsQ = useQuery({ queryKey: ['proc-vendors', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/vendors`)).data.vendors as any[] });
  useEffect(() => { if (data) setD(structuredClone(data)); }, [data]);

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/docs/${docId}`, {
      vendorId: d.vendorId, vendorName: d.vendorName, vendorAddress: d.vendorAddress, vendorGstin: d.vendorGstin, vendorContact: d.vendorContact, vendorPhone: d.vendorPhone,
      againstQuotation: d.againstQuotation, invoiceTo: d.invoiceTo, shipTo: d.shipTo, siteAddress: d.siteAddress,
      gstEnabled: d.gstEnabled, gstPct: Number(d.gstPct),
      payAdvancePct: Number(d.payAdvancePct), payBeforeDeliveryPct: Number(d.payBeforeDeliveryPct), payRunningPct: Number(d.payRunningPct),
      payPostDeliveryPct: Number(d.payPostDeliveryPct), payPostCompletionPct: Number(d.payPostCompletionPct), payRetentionPct: Number(d.payRetentionPct),
      payTriggers: d.payTriggers, termsSections: d.termsSections,
      lineItems: d.lineItems.map((l: any, i: number) => ({ srNo: i + 1, description: l.description, uom: l.uom, qty: Number(l.qty), unitPrice: Number(l.unitPrice), totalPrice: l.totalOverride != null ? Number(l.totalPrice) : undefined, isLeadTime: l.isLeadTime, leadTimeText: l.leadTimeText })),
    })).data.doc,
    onSuccess: (doc) => { setD(structuredClone(doc)); setMsg({ ok: true, t: 'Saved.' }); qc.invalidateQueries({ queryKey: ['proc-doc', docId] }); },
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
  const locked = d.status === 'APPROVED';
  const editable = !locked && canEditDoc;

  const payTotal = PAY.reduce((s, p) => s + (Number(d[p.key]) || 0), 0);
  const basic = d.lineItems.filter((l: any) => !l.isLeadTime).reduce((s: number, l: any) => s + (Number(l.qty) * Number(l.unitPrice) || 0), 0);

  function setLine(i: number, patch: any) {
    setD((p: any) => { const li = [...p.lineItems]; li[i] = { ...li[i], ...patch }; return { ...p, lineItems: li }; });
  }
  function addLine(lead = false) { setD((p: any) => ({ ...p, lineItems: [...p.lineItems, { description: '', qty: 0, unitPrice: 0, totalPrice: 0, uom: isWO ? 'Nos.' : null, isLeadTime: lead, leadTimeText: lead ? '7 Days' : null }] })); }
  function delLine(i: number) { setD((p: any) => ({ ...p, lineItems: p.lineItems.filter((_: any, idx: number) => idx !== i) })); }

  function selectVendor(id: string) {
    const v = vendorsQ.data?.find((x) => x.id === id);
    setD((p: any) => ({ ...p, vendorId: id || null, vendorName: v?.name ?? p.vendorName, vendorAddress: v?.address ?? p.vendorAddress, vendorGstin: v?.gstin ?? p.vendorGstin, vendorContact: v?.contactPerson ?? p.vendorContact, vendorPhone: v?.phones ?? p.vendorPhone }));
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
          <button className="btn-outline text-sm" onClick={() => openAuthedFile(`/projects/${projectId}/procurement/docs/${docId}/pdf`)}>📄 PDF</button>
          {editable && <button className="btn-primary text-sm" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>}
          {editable && d.status === 'DRAFT' && <button className="btn-primary text-sm" onClick={async () => { await save.mutateAsync(); doAction.mutate({ verb: 'submit' }); }}>Submit for Approval</button>}
          {canEditDoc && d.status === 'PENDING_APPROVAL' && <button className="btn-outline text-sm" onClick={() => doAction.mutate({ verb: 'recall' })}>Recall</button>}
          {canApprove && d.status === 'PENDING_APPROVAL' && <button className="btn-primary text-sm" onClick={() => doAction.mutate({ verb: 'approve' })}>✓ Approve + e-sign</button>}
          {canApprove && d.status === 'PENDING_APPROVAL' && <button className="btn-danger text-sm" onClick={() => { const r = prompt('Rejection reason'); if (r) doAction.mutate({ verb: 'reject', body: { reason: r } }); }}>Reject</button>}
        </div>
      </div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.t}</div>}
      {d.rejectionReason && d.status !== 'APPROVED' && <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">Last rejection: {d.rejectionReason}</div>}
      {locked && <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">This {d.type} is approved and locked. Every field was editable before approval (manual override on all).</div>}

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

      {/* Line items */}
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between"><div className="text-sm font-semibold text-slate-600">Line Items</div>
          {editable && <div className="flex gap-2"><button className="btn-outline text-xs" onClick={() => addLine(false)}>+ Row</button>{isWO && <button className="btn-outline text-xs" onClick={() => addLine(true)}>+ Lead Time</button>}</div>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="w-8">#</th><th>Description</th>{isWO && <th className="w-20">UOM</th>}<th className="w-20">Qty</th><th className="w-28">Unit Price</th><th className="w-28 text-right">Total</th>{editable && <th></th>}</tr></thead>
            <tbody>
              {d.lineItems.map((l: any, i: number) => l.isLeadTime ? (
                <tr key={i} className="border-b border-slate-100 bg-purple-50/40">
                  <td className="py-1 text-center text-purple-500">⏱</td>
                  <td colSpan={isWO ? 3 : 2}><input className="input bg-transparent text-purple-700" disabled={!editable} value={l.leadTimeText || ''} onChange={(e) => setLine(i, { leadTimeText: e.target.value })} placeholder="Lead Time e.g. 7 Days" /></td>
                  <td colSpan={2}></td>{editable && <td><button className="text-slate-300 hover:text-red-500" onClick={() => delLine(i)}>✕</button></td>}
                </tr>
              ) : (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="py-1 text-center text-slate-400">{i + 1}</td>
                  <td><textarea className="input min-h-[38px] text-xs" disabled={!editable} rows={Math.min((l.description || '').split('\n').length + 1, 6)} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
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
        <div className="grid gap-3 sm:grid-cols-3">
          {PAY.map((p) => (
            <div key={p.key} className="rounded-lg bg-slate-50 p-2">
              <label className="label">{p.label}</label>
              <div className="flex items-center gap-1">
                <input className="input" type="number" disabled={!editable} value={d[p.key]} onChange={(e) => setD({ ...d, [p.key]: e.target.value })} />
                <span className="text-xs text-slate-400">%</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">{inr(Math.round(basic * (Number(d[p.key]) / 100)))}</div>
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

      {/* T&C */}
      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Terms & Conditions ({d.termsSections?.length || 0} sections — all editable)</div>
        <div className="space-y-2">
          {(d.termsSections || []).map((s: any, i: number) => (
            <details key={i} className="rounded-lg border border-slate-200">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-navy">{s.title}</summary>
              <div className="space-y-2 px-3 pb-3">
                <input className="input text-sm font-medium" disabled={!editable} value={s.title} onChange={(e) => { const t = [...d.termsSections]; t[i] = { ...t[i], title: e.target.value }; setD({ ...d, termsSections: t }); }} />
                <textarea className="input text-xs" rows={3} disabled={!editable} value={s.text} onChange={(e) => { const t = [...d.termsSections]; t[i] = { ...t[i], text: e.target.value }; setD({ ...d, termsSections: t }); }} />
                {editable && <button className="text-xs text-red-500 hover:underline" onClick={() => setD({ ...d, termsSections: d.termsSections.filter((_: any, idx: number) => idx !== i) })}>Delete section</button>}
              </div>
            </details>
          ))}
          {editable && <button className="btn-outline text-xs" onClick={() => setD({ ...d, termsSections: [...(d.termsSections || []), { title: 'New Section', text: '' }] })}>+ Add Section</button>}
        </div>
      </div>
      </>}
    </div>
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
