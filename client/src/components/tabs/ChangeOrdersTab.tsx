import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Modal, Spinner } from '../ui';
import { docStatusPill, fmtDate, titleize } from '../../lib/format';

const TYPES = [['QTY_INCREASE', 'Quantity Increase'], ['QTY_DECREASE', 'Quantity Decrease'], ['NEW_ITEM', 'New Item'], ['SUBSTITUTION', 'Substitution']] as const;

export default function ChangeOrdersTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { canEdit, isAdmin } = useAuth();
  const canManage = canEdit('changeorders');
  const [show, setShow] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['change-orders', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/change-orders`)).data.orders as any[] });
  const act = useMutation({
    mutationFn: (v: { id: string; verb: string; body?: any }) => api.post(`/projects/${projectId}/change-orders/${v.id}/${v.verb}`, v.body ?? {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['change-orders', projectId] }); qc.invalidateQueries({ queryKey: ['boq', projectId] }); },
    onError: (e) => alert(errMsg(e)),
  });

  if (isLoading) return <Spinner label="Loading change orders…" />;
  const orders = data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-600">Change Orders ({orders.length})</h3>
        {canManage && <button className="btn-primary text-sm" onClick={() => setShow(true)}>+ Raise Change Order</button>}
      </div>

      {orders.length === 0 ? (
        <EmptyState title="No change orders" hint="Raise a change order when more material is needed than the BOQ planned, or for new/substituted items. It routes to AA sir for approval and updates the BOQ baseline on approval." action={canManage ? <button className="btn-primary mt-2" onClick={() => setShow(true)}>+ Raise Change Order</button> : undefined} />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">CO No.</th><th>Type</th><th>Item</th><th className="text-right">Change</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-slate-100 align-top">
                  <td className="px-4 py-2 font-medium text-navy">{o.coNumber}</td>
                  <td><span className="badge bg-slate-100 text-slate-600">{titleize(o.type)}</span></td>
                  <td className="text-slate-600">{o.boqItem?.description?.slice(0, 50) || o.description.slice(0, 50)}{o.rejectionReason && <div className="text-xs text-red-500">Rejected: {o.rejectionReason}</div>}</td>
                  <td className="text-right">{o.originalQty != null ? `${o.originalQty} → ${o.newTotalQty}` : `${o.changeQty}`} {o.unit || ''}</td>
                  <td><span className={`badge ${docStatusPill(o.status)}`}>{titleize(o.status)}</span></td>
                  <td className="px-2 text-right">
                    {canManage && o.status === 'DRAFT' && <button className="text-xs font-medium text-navy hover:underline" onClick={() => act.mutate({ id: o.id, verb: 'submit' })}>Submit</button>}
                    {isAdmin && o.status === 'PENDING' && <div className="flex justify-end gap-2"><button className="text-xs font-medium text-green-700 hover:underline" onClick={() => act.mutate({ id: o.id, verb: 'approve' })}>Approve</button><button className="text-xs font-medium text-red-600 hover:underline" onClick={() => { const r = prompt('Rejection reason'); if (r) act.mutate({ id: o.id, verb: 'reject', body: { reason: r } }); }}>Reject</button></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <COModal projectId={projectId} onClose={() => setShow(false)} onDone={() => { setShow(false); qc.invalidateQueries({ queryKey: ['change-orders', projectId] }); }} />}
    </div>
  );
}

function COModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  // Match BOQTab's cache shape ({ items, locked, categories }) — same queryKey.
  const boqQ = useQuery({ queryKey: ['boq', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data });
  const boqItems: any[] = boqQ.data?.items ?? [];
  const [f, setF] = useState<any>({ type: 'QTY_INCREASE', boqItemId: '', description: '', changeQty: 0, costImpact: '', paidByClient: 'TBD', justification: '' });
  const [err, setErr] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/projects/${projectId}/change-orders`, { ...f, boqItemId: f.boqItemId || null, costImpact: f.costImpact === '' ? null : Number(f.costImpact) }), onSuccess: onDone, onError: (e) => setErr(errMsg(e)) });
  const needsItem = f.type !== 'NEW_ITEM';
  return (
    <Modal title="Raise Change Order" onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Type</label><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        {needsItem && <div><label className="label">BOQ item</label><select className="input" value={f.boqItemId} onChange={(e) => setF({ ...f, boqItemId: e.target.value })}><option value="">— select —</option>{boqItems.filter((i) => !i.isGroup).map((i) => <option key={i.id} value={i.id}>{(i.description || '').slice(0, 50)} ({i.plannedQty} {i.unit})</option>)}</select></div>}
        <div className="sm:col-span-2"><label className="label">Description *</label><textarea className="input" rows={2} required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
        <div><label className="label">Change Qty (+/-)</label><input className="input" type="number" step="any" value={f.changeQty} onChange={(e) => setF({ ...f, changeQty: e.target.value })} /></div>
        <div><label className="label">Cost Impact (₹)</label><input className="input" type="number" step="any" value={f.costImpact} onChange={(e) => setF({ ...f, costImpact: e.target.value })} /></div>
        <div><label className="label">Paid by client?</label><select className="input" value={f.paidByClient} onChange={(e) => setF({ ...f, paidByClient: e.target.value })}><option>TBD</option><option>YES</option><option>NO</option></select></div>
        <div className="sm:col-span-2"><label className="label">Justification</label><textarea className="input" rows={2} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} /></div>
        {err && <div className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Create (Draft)'}</button></div>
      </form>
    </Modal>
  );
}
