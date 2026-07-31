import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { docStatusPill, fmtDate, titleize } from '../../lib/format';

// The physical goods-receipt register: material/spares/machines arriving on site
// against an approved PO/WO. Deliberately simple — delivery details + what was
// actually received per line. No payment here; that lives on the Payment page.
export default function GoodsReceiptView({ projectId, focusId }: { projectId: string; role: string; focusId?: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canRaise = canEdit('grn');
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [raising, setRaising] = useState(false);

  const grsQ = useQuery({ queryKey: ['goods-receipts', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/goods-receipts`)).data.goodsReceipts as any[] });
  const posQ = useQuery({ queryKey: ['gr-available-docs', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/goods-receipts/available-docs`)).data.docs as any[] });

  const raise = useMutation({
    mutationFn: (docId: string) => api.post(`/projects/${projectId}/procurement/goods-receipts`, { docId }),
    onSuccess: (r) => { setRaising(false); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); setOpenId(r.data.goodsReceipt.id); },
    onError: (e) => alert(errMsg(e)),
  });
  const delGr = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/procurement/goods-receipts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (openId) return <GoodsReceiptForm projectId={projectId} grId={openId} onClose={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); }} />;
  if (grsQ.isLoading) return <Spinner label="Loading goods receipts…" />;
  const grs = grsQ.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-600">Goods Receipts ({grs.length})</h3>
        {canRaise && <button className="btn-primary text-sm" onClick={() => setRaising(true)}>+ Raise GRN</button>}
      </div>

      {raising && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-medium text-slate-600">Raise a goods receipt against an approved PO/WO</div>
          {posQ.data?.length ? (
            <div className="space-y-2">
              {posQ.data.map((d: any) => (
                <div key={d.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-2 text-sm">
                  <span>
                    <span className="font-medium text-navy">{d.docNumber}</span>
                    <span className="badge ml-1 bg-slate-100 text-slate-600">{d.type}</span>
                    <span className="text-slate-500"> · {d.vendorName || '—'}</span>
                    {d.grnCount > 0 && <span className="text-xs text-slate-400"> · {d.grnCount} receipt{d.grnCount > 1 ? 's' : ''} already raised</span>}
                  </span>
                  <button className="btn-outline text-xs" onClick={() => raise.mutate(d.id)}>Select</button>
                </div>
              ))}
            </div>
          ) : <div className="text-sm text-slate-400">No approved POs/WOs to receive against.</div>}
          <button className="btn-outline mt-2 text-xs" onClick={() => setRaising(false)}>Cancel</button>
        </div>
      )}

      {grs.length === 0 ? (
        <EmptyState title="No goods receipts yet" hint="When material, spares or machines arrive on site, raise a GRN against the relevant PO/WO to record the delivery and what was received." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">GRN No.</th><th>Against</th><th>Vendor</th><th>Received by</th><th>Date</th><th className="pl-2">Status</th><th></th></tr></thead>
            <tbody>
              {grs.map((g) => (
                <tr key={g.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-navy">{g.grnNumber}</td>
                  <td className="text-slate-600">{g.doc?.docNumber}</td>
                  <td className="text-slate-600">{g.vendorName}</td>
                  <td className="text-slate-500">
                    {g.createdBy ? <span title={g.createdBy.name} className="text-xs">{g.createdBy.email}</span> : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="text-slate-500">{fmtDate(g.receivedDate)}</td>
                  <td className="pl-2"><span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span></td>
                  <td className="px-2 text-right">
                    {canRaise && g.status === 'DRAFT' && <button className="mr-3 text-xs font-medium text-rose-500 hover:underline" onClick={() => confirm(`Delete draft ${g.grnNumber}? This can't be undone.`) && delGr.mutate(g.id)}>Delete</button>}
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

function GoodsReceiptForm({ projectId, grId, onClose }: { projectId: string; grId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const [g, setG] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const grQ = useQuery({
    queryKey: ['goods-receipt', grId],
    queryFn: async () => {
      const res = (await api.get(`/projects/${projectId}/procurement/goods-receipts/${grId}`)).data;
      setG(structuredClone(res.goodsReceipt));
      return res as { goodsReceipt: any };
    },
  });

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/goods-receipts/${grId}`, {
      vehicleNumber: g.vehicleNumber, driverName: g.driverName, deliveryChallanNumber: g.deliveryChallanNumber, remarks: g.remarks,
      lineItems: g.lineItems.map((l: any) => ({ id: l.id, receiptQty: Number(l.receiptQty), defectQty: Number(l.defectQty || 0), remarks: l.remarks })),
    })).data.goodsReceipt,
    onSuccess: (gr) => { setG(structuredClone(gr)); setMsg('Saved.'); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const receive = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/receive`, {})).data.goodsReceipt,
    onSuccess: () => { setMsg('Marked received.'); grQ.refetch(); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/photo`, fd); },
    onSuccess: () => { setMsg('Photo uploaded.'); grQ.refetch(); },
    onError: (e) => setMsg(errMsg(e)),
  });

  if (grQ.isLoading || !g) return <Spinner label="Loading goods receipt…" />;
  const editable = g.status === 'DRAFT' && canEdit('grn');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button className="btn-outline text-sm" onClick={onClose}>← Back</button>
          <h2 className="text-lg font-bold text-navy">{g.grnNumber}</h2>
          <span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>
        </div>
        <div className="flex gap-2">
          {editable && <button className="btn-primary text-sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>}
          {editable && <button className="btn-outline text-sm" disabled={receive.isPending} onClick={() => { if (confirm('Mark this goods receipt as RECEIVED? It will be locked as a record.')) { save.mutate(); receive.mutate(); } }}>✓ Mark Received</button>}
        </div>
      </div>
      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}

      {g.status === 'RECEIVED' && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">This goods receipt is confirmed and locked.</div>
      )}

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Against</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <F label="PO / WO Number"><input className="input bg-slate-50 text-slate-600" value={g.doc?.docNumber ?? '—'} disabled readOnly /></F>
          <F label="Vendor"><input className="input bg-slate-50 text-slate-600" value={g.vendorName ?? '—'} disabled readOnly /></F>
          <F label="Site Address"><input className="input bg-slate-50 text-slate-600" value={g.siteAddress ?? '—'} disabled readOnly /></F>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Delivery Details</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <G label="Vehicle Number" v={g.vehicleNumber} on={(x) => setG({ ...g, vehicleNumber: x })} ed={editable} />
          <G label="Driver Name" v={g.driverName} on={(x) => setG({ ...g, driverName: x })} ed={editable} />
          <G label="Delivery Challan No." v={g.deliveryChallanNumber} on={(x) => setG({ ...g, deliveryChallanNumber: x })} ed={editable} />
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-1 text-sm font-semibold text-slate-600">Received Line Items</div>
        <p className="mb-3 text-xs text-slate-400">Enter what actually arrived. Accepted = Receipt − Defect. Prices and payment are handled on the Payment page.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="text-left">Description</th>
                <th className="w-20 text-center">PO Qty</th>
                <th className="w-24 text-center">Prev Recd</th>
                <th className="w-24 text-center">Remaining</th>
                <th className="w-24 text-center">Receipt</th>
                <th className="w-20 text-center">Defect</th>
                <th className="w-20 text-center">Accepted</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Notes & Photo</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <F label="Remarks"><textarea className="input" rows={2} disabled={!editable} value={g.remarks || ''} onChange={(e) => setG({ ...g, remarks: e.target.value })} placeholder="e.g. 2 cartons damaged in transit, noted on challan" /></F>
          <F label="Material Photo">
            {g.photoUrl
              ? <a className="text-sm text-navy hover:underline" href={g.photoUrl} target="_blank" rel="noreferrer">🖼 View photo</a>
              : <span className="text-xs text-slate-400">Not uploaded</span>}
            {editable && <input className="input mt-1 text-xs" type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && uploadPhoto.mutate(e.target.files[0])} />}
          </F>
        </div>
      </div>
    </div>
  );
}

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
