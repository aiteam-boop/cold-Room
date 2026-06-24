import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Modal, Spinner } from '../ui';

const KYC_DOT: Record<string, string> = { Complete: 'bg-green-500', Partial: 'bg-amber-500', Missing: 'bg-red-500' };

export default function VendorsView({ projectId }: { projectId: string; role: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const isAdmin = canEdit('vendors');
  const [show, setShow] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['proc-vendors', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/vendors`)).data.vendors as any[] });

  if (isLoading) return <Spinner label="Loading vendors…" />;
  const vendors = data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-600">Vendors & Contractors mapped to this site ({vendors.length})</h3>
        {isAdmin && <button className="btn-primary text-sm" onClick={() => setShow(true)}>+ Add Vendor</button>}
      </div>
      {vendors.length === 0 ? (
        <EmptyState title="No vendors mapped to this site" hint={isAdmin ? 'Add a vendor/contractor — they\'ll be selectable when creating POs/WOs for this project.' : 'No vendors yet.'} action={isAdmin ? <button className="btn-primary mt-2" onClick={() => setShow(true)}>+ Add Vendor</button> : undefined} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {vendors.map((v) => (
            <div key={v.id} className="card p-4">
              <div className="flex items-start justify-between">
                <div className="font-semibold text-navy">{v.name}</div>
                <span className="badge bg-slate-100 text-slate-600">{v.type}</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-slate-500"><span className={`h-2 w-2 rounded-full ${KYC_DOT[v.kycStatus]}`} /> KYC {v.kycStatus}</div>
              {v.address && <div className="mt-2 text-xs text-slate-500">{v.address}</div>}
              <div className="mt-2 space-y-0.5 text-xs text-slate-400">
                {v.gstin && <div>GSTIN: {v.gstin}</div>}
                {v.contactPerson && <div>Contact: {v.contactPerson} {v.phones && `· ${v.phones}`}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {show && <AddVendor projectId={projectId} onClose={() => setShow(false)} onDone={() => { setShow(false); qc.invalidateQueries({ queryKey: ['proc-vendors', projectId] }); }} />}
    </div>
  );
}

function AddVendor({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ name: '', type: 'VENDOR', contactPerson: '', phones: '', address: '', email: '', gstin: '', pan: '', bankAccount: '', ifsc: '' });
  const [err, setErr] = useState('');
  const m = useMutation({ mutationFn: () => api.post(`/projects/${projectId}/procurement/vendors`, f), onSuccess: onDone, onError: (e) => setErr(errMsg(e)) });
  const F = (k: string, label: string) => <div><label className="label">{label}</label><input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>;
  return (
    <Modal title="Add Vendor / Contractor" onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="grid gap-3 sm:grid-cols-2">
        {F('name', 'Name *')}
        <div><label className="label">Type</label><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="VENDOR">Vendor (material)</option><option value="CONTRACTOR">Contractor (labor)</option></select></div>
        {F('contactPerson', 'Contact Person')}{F('phones', 'Phone(s)')}
        <div className="sm:col-span-2"><label className="label">Address</label><textarea className="input" rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
        {F('email', 'Email')}{F('gstin', 'GSTIN')}{F('pan', 'PAN')}{F('bankAccount', 'Bank Account')}{F('ifsc', 'IFSC')}
        {err && <div className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Adding…' : 'Add Vendor'}</button></div>
      </form>
    </Modal>
  );
}
