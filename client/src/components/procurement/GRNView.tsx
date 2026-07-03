import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { docStatusPill, fmtDate, inr, titleize } from '../../lib/format';
import ApprovalTimeline from './ApprovalTimeline';
import ChainBuilder from './ChainBuilder';

export default function GRNView({ projectId }: { projectId: string; role: string }) {
  const qc = useQueryClient();
  const { canEdit, can, hideFinancials } = useAuth();
  const canRaise = canEdit('grn');
  const canApprove = can('canApprove');
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const [openId, setOpenId] = useState<string | null>(null);
  const [raising, setRaising] = useState(false);

  const grnsQ = useQuery({ queryKey: ['grns', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/grns`)).data.grns as any[] });
  const posQ = useQuery({ queryKey: ['proc-docs-approved', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/docs`)).data.docs.filter((d: any) => d.status === 'APPROVED') });

  const raise = useMutation({
    mutationFn: (docId: string) => api.post(`/projects/${projectId}/procurement/grns`, { docId }),
    onSuccess: (r) => { setRaising(false); qc.invalidateQueries({ queryKey: ['grns', projectId] }); setOpenId(r.data.grn.id); },
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
              {posQ.data.map((d: any) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-2 text-sm">
                  <span>{d.docNumber} · {d.vendorName} · {money(d.finalAmount)}</span>
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
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">GRN No.</th><th>Against</th><th>Vendor</th><th>Date</th><th className="text-right">Invoice Value</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {grns.map((g) => (
                <tr key={g.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-navy">{g.grnNumber}</td>
                  <td className="text-slate-600">{g.doc?.docNumber}</td>
                  <td className="text-slate-600">{g.vendorName}</td>
                  <td className="text-slate-500">{fmtDate(g.grnDate)}</td>
                  <td className="text-right">{g.invoiceValue ? money(g.invoiceValue) : '—'}</td>
                  <td><span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span></td>
                  <td className="px-2 text-right"><button className="text-xs font-medium text-navy hover:underline" onClick={() => setOpenId(g.id)}>Open →</button></td>
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
  const { user } = useAuth();
  const [g, setG] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [showChain, setShowChain] = useState(false);
  const grnQ = useQuery({ queryKey: ['grn', grnId], queryFn: async () => { const res = (await api.get(`/projects/${projectId}/procurement/grns/${grnId}`)).data; setG(structuredClone(res.grn)); return res as { grn: any; approval?: any }; } });
  const isLoading = grnQ.isLoading;

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/grns/${grnId}`, {
      vehicleNumber: g.vehicleNumber, driverName: g.driverName, deliveryChallanNumber: g.deliveryChallanNumber,
      invoiceNumber: g.invoiceNumber, invoiceDate: g.invoiceDate?.slice?.(0, 10), invoiceValue: g.invoiceValue ? Number(g.invoiceValue) : undefined, ewayBillNumber: g.ewayBillNumber,
      lineItems: g.lineItems.map((l: any) => ({ id: l.id, receiptQty: Number(l.receiptQty), defectQty: Number(l.defectQty || 0), remarks: l.remarks })),
    })).data.grn,
    onSuccess: (grn) => { setG(structuredClone(grn)); setMsg('Saved.'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadInvoice = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/grns/${grnId}/invoice`, fd); },
    onSuccess: () => { setMsg('Invoice uploaded.'); qc.invalidateQueries({ queryKey: ['grn', grnId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const act = useMutation({ mutationFn: (v: { verb: string; body?: any }) => api.post(`/projects/${projectId}/procurement/grns/${grnId}/${v.verb}`, v.body ?? {}), onSuccess: () => { qc.invalidateQueries({ queryKey: ['grn', grnId] }); qc.invalidateQueries({ queryKey: ['grns', projectId] }); }, onError: (e) => setMsg(errMsg(e)) });

  if (isLoading || !g) return <Spinner label="Loading GRN…" />;
  const editable = g.status === 'DRAFT';

  // Approval-chain state (mirrors DocBuilder).
  const approval = grnQ.data?.approval as { steps: any[]; total: number; currentApproverId?: string | null } | undefined;
  const hasChain = (approval?.total ?? 0) > 0;
  const myTurn = !!approval?.currentApproverId && approval.currentApproverId === user?.id;
  const canAct = g.status === 'OPEN' && (hasChain ? (myTurn || canApprove) : canApprove);
  const promptRemarks = (verb: 'approve' | 'reject') => {
    const r = window.prompt(verb === 'reject' ? 'Rejection reason' : 'Remarks (optional)') ?? (verb === 'approve' ? '' : null);
    if (verb === 'reject' && !r) return;
    act.mutate({ verb, body: verb === 'reject' ? { reason: r } : { remarks: r } });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><button className="btn-outline text-sm" onClick={onClose}>← Back</button><h2 className="text-lg font-bold text-navy">{g.grnNumber}</h2><span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span></div>
        <div className="flex gap-2">
          {g.status === 'APPROVED' && <button className="btn-outline text-sm" onClick={() => openAuthedFile(`/projects/${projectId}/procurement/grns/${grnId}/pdf`)}>📄 PDF</button>}
          {editable && <button className="btn-primary text-sm" onClick={() => save.mutate()}>Save</button>}
          {editable && <button className="btn-primary text-sm" onClick={() => setShowChain(true)}>Submit</button>}
          {g.status === 'OPEN' && hasChain && <button className="btn-outline text-sm" disabled={act.isPending} onClick={() => act.mutate({ verb: 'remind' })}>Send Reminder</button>}
          {canAct && <button className="btn-primary text-sm" onClick={() => promptRemarks('approve')}>✓ Approve</button>}
          {canAct && <button className="btn-danger text-sm" onClick={() => promptRemarks('reject')}>Reject</button>}
        </div>
      </div>
      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}
      {hasChain && <ApprovalTimeline approval={approval as any} />}
      {showChain && (
        <ChainBuilder
          docType="GRN"
          busy={act.isPending || save.isPending}
          onClose={() => setShowChain(false)}
          onConfirm={async (chain) => { await save.mutateAsync(); act.mutate({ verb: 'submit', body: { chain } }); setShowChain(false); }}
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
        <div className="mb-3 text-sm font-semibold text-slate-600">Receipt Line Items</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-400"><tr><th>Description</th><th className="w-20">PO Qty</th><th className="w-20">Prev Recd</th><th className="w-24">Receipt</th><th className="w-20">Defect</th><th className="w-20">Accepted</th></tr></thead>
            <tbody>
              {g.lineItems.map((l: any, i: number) => (
                <tr key={l.id} className="border-b border-slate-100">
                  <td className="py-1 text-xs">{l.description}</td>
                  <td>{l.poQty}</td><td>{l.previouslyReceivedQty}</td>
                  <td><input className="input" type="number" disabled={!editable} value={l.receiptQty} onChange={(e) => { const li = [...g.lineItems]; li[i] = { ...li[i], receiptQty: e.target.value }; setG({ ...g, lineItems: li }); }} /></td>
                  <td><input className="input" type="number" disabled={!editable} value={l.defectQty} onChange={(e) => { const li = [...g.lineItems]; li[i] = { ...li[i], defectQty: e.target.value }; setG({ ...g, lineItems: li }); }} /></td>
                  <td className="font-medium">{Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Invoice (mandatory before submit)</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <G label="Invoice Number *" v={g.invoiceNumber} on={(x) => setG({ ...g, invoiceNumber: x })} ed={editable} />
          <div><label className="label">Invoice Date *</label><input className="input" type="date" disabled={!editable} value={g.invoiceDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, invoiceDate: e.target.value })} /></div>
          <G label="Invoice Value (INR) *" v={g.invoiceValue} on={(x) => setG({ ...g, invoiceValue: x })} ed={editable} />
          <G label="E-Way Bill Number" v={g.ewayBillNumber} on={(x) => setG({ ...g, ewayBillNumber: x })} ed={editable} />
          <div><label className="label">Invoice PDF * {g.invoicePdfUrl && <span className="text-green-600">✓ uploaded</span>}</label><input className="input text-xs" type="file" accept=".pdf,image/*" disabled={!editable} onChange={(e) => e.target.files?.[0] && uploadInvoice.mutate(e.target.files[0])} /></div>
        </div>
      </div>
    </div>
  );
}
function G({ label, v, on, ed }: { label: string; v: any; on: (x: string) => void; ed: boolean }) {
  return <div><label className="label">{label}</label><input className="input" disabled={!ed} value={v || ''} onChange={(e) => on(e.target.value)} /></div>;
}
