import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Modal, Spinner } from '../components/ui';
import { fmtDate } from '../lib/format';

const KYC_DOT: Record<string, string> = { Complete: 'bg-green-500', Partial: 'bg-amber-500', Missing: 'bg-red-500' };

// Global vendor database (all projects). Gated by the Vendors page grant.
export default function VendorsPage() {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canManage = canEdit('vendors');
  const [show, setShow] = useState(false);
  const [q, setQ] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['all-vendors'],
    queryFn: async () => (await api.get('/vendors')).data.vendors as any[],
  });

  if (isLoading) return <Spinner label="Loading vendors…" />;
  if (error) return <div className="card p-6 text-red-600">You don't have access to the global vendor database.</div>;
  const vendors = (data ?? []).filter((v) => `${v.name} ${v.gstin} ${v.contactPerson}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-navy">Vendors & Contractors</h1>
          <p className="text-sm text-slate-500">Company-wide vendor database with KYC and site mapping.</p>
        </div>
        <div className="flex items-center gap-2">
          <input className="input w-56" placeholder="Search vendor…" value={q} onChange={(e) => setQ(e.target.value)} />
          {canManage && <button className="btn-primary" onClick={() => setShow(true)}>+ Add Vendor</button>}
        </div>
      </div>

      {vendors.length === 0 ? (
        <EmptyState title="No vendors yet" hint="Add vendors/contractors here; map them to project sites so they appear in PO/WO creation." action={canManage ? <button className="btn-primary mt-2" onClick={() => setShow(true)}>+ Add Vendor</button> : undefined} />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Name</th><th>Type</th><th>GSTIN</th><th>Sites</th><th>POs/WOs</th><th>KYC</th><th>Added</th></tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-navy">{v.name}<div className="text-xs font-normal text-slate-400">{v.contactPerson} {v.phones && `· ${v.phones}`}</div></td>
                  <td><span className="badge bg-slate-100 text-slate-600">{v.type}</span></td>
                  <td className="text-slate-500">{v.gstin || '—'}</td>
                  <td className="text-slate-500">{v.siteMappings?.map((s: any) => s.project?.name).filter(Boolean).join(', ') || '—'}</td>
                  <td className="text-slate-500">{v._count?.docs ?? 0}</td>
                  <td><span className="inline-flex items-center gap-1 text-xs"><span className={`h-2 w-2 rounded-full ${KYC_DOT[v.kycStatus]}`} />{v.kycStatus}</span></td>
                  <td className="text-slate-400">{fmtDate(v.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <AddVendor onClose={() => setShow(false)} onDone={() => { setShow(false); qc.invalidateQueries({ queryKey: ['all-vendors'] }); }} />}
    </div>
  );
}

function AddVendor({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ name: '', type: 'VENDOR', contactPerson: '', phones: '', address: '', email: '', gstin: '', pan: '', bankAccount: '', ifsc: '' });
  const [err, setErr] = useState('');
  const m = useMutation({ mutationFn: () => api.post('/vendors', f), onSuccess: onDone, onError: (e) => setErr(errMsg(e)) });
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
