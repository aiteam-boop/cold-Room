import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Modal, Spinner } from '../components/ui';
import { fmtDate } from '../lib/format';
import VendorDetail from '../components/procurement/VendorDetail';
import ViewToggle, { useViewMode } from '../components/ViewToggle';
import KycBadge from '../components/procurement/KycBadge';

// Global vendor database (all projects). Gated by the Vendors page grant.
export default function VendorsPage() {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canManage = canEdit('vendors');
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [view, setView] = useViewMode('vendorsView.page', 'grid');

  const { data, isLoading, error } = useQuery({
    queryKey: ['all-vendors'],
    queryFn: async () => (await api.get('/vendors')).data.vendors as any[],
  });
  // Delete a duplicate/unused vendor — the server blocks it if any PO/WO or
  // payment is linked, so real transactions are never orphaned.
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/vendors/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['all-vendors'] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (isLoading) return <Spinner label="Loading vendors…" />;
  if (error) return <div className="card p-6 text-red-600">You don't have access to the global vendor database.</div>;
  // Display vendors A→Z by name (case-insensitive), regardless of when they were
  // added. Names are TRIMMED before comparing — some vendors have a stray leading
  // space in the stored name, which would otherwise sort them as a block at the
  // top. Sort a copy so the cached query data isn't mutated.
  const vendors = (data ?? [])
    .filter((v) => `${v.name} ${v.gstin} ${v.contactPerson}`.toLowerCase().includes(q.toLowerCase()))
    .slice()
    .sort((a, b) => (a.name || '').trim().localeCompare((b.name || '').trim(), undefined, { sensitivity: 'base', numeric: true }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-navy">Vendors & Contractors</h1>
          <p className="text-sm text-slate-500">Company-wide vendor database with KYC and site mapping.</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          <input className="input w-56" placeholder="Search vendor…" value={q} onChange={(e) => setQ(e.target.value)} />
          {canManage && <button className="btn-primary" onClick={() => setShow(true)}>+ Add Vendor</button>}
        </div>
      </div>

      {vendors.length === 0 ? (
        <EmptyState title="No vendors yet" hint="Add vendors/contractors here; map them to project sites so they appear in PO/WO creation." action={canManage ? <button className="btn-primary mt-2" onClick={() => setShow(true)}>+ Add Vendor</button> : undefined} />
      ) : view === 'cards' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Click a card to view details; Edit/Delete stop propagation. */}
          {vendors.map((v) => (
            <div key={v.id} role="button" onClick={() => setViewing(v.id)} className="card cursor-pointer p-4 transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 truncate font-semibold text-navy">{v.name}</div>
                <div className="flex shrink-0 items-center gap-2">
                  {canManage && <button className="text-xs font-medium text-navy hover:underline" onClick={(e) => { e.stopPropagation(); setEditing(v); }}>Edit</button>}
                  {canManage && <button className="text-xs font-medium text-rose-500 hover:underline" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete vendor “${v.name}”? This can't be undone. (Blocked if it has any PO/WO or payment.)`)) del.mutate(v.id); }}>Delete</button>}
                  <span className="badge bg-slate-100 text-slate-600">{v.type}</span>
                </div>
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                KYC <KycBadge kyc={v.kyc} kycStatus={v.kycStatus} />
              </div>
              {/* Which specific documents are still pending (doesn't touch the % badge):
                  mandatory ones in red with a *, optional ones in grey. Hidden when
                  KYC is complete. */}
              {v.kyc?.items?.some((it: any) => !it.done) && (
                <div className="mt-1 text-[11px] leading-snug">
                  <span className="text-slate-400">Pending: </span>
                  {v.kyc.items.filter((it: any) => !it.done).map((it: any, i: number, arr: any[]) => (
                    <span key={it.key} className={it.mandatory ? 'font-medium text-red-600' : 'text-slate-400'} title={it.mandatory ? 'Mandatory' : 'Optional'}>
                      {it.label}{it.mandatory ? '*' : ''}{i < arr.length - 1 ? ', ' : ''}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 space-y-0.5 text-xs text-slate-400">
                {(v.contactPerson || v.phones) && <div className="truncate">Contact: {v.contactPerson}{v.phones ? ` · ${v.phones}` : ''}</div>}
                {v.gstin && <div>GSTIN: {v.gstin}</div>}
                <div>Sites: {v.siteMappings?.map((s: any) => s.project?.name).filter(Boolean).join(', ') || '—'}</div>
                <div>{v._count?.docs ?? 0} PO/WO · added {fmtDate(v.createdAt)}</div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Name</th><th>Type</th><th>GSTIN</th><th>Sites</th><th>POs/WOs</th><th>KYC</th><th>Added</th>{canManage && <th></th>}</tr>
            </thead>
            <tbody>
              {/* Click anywhere on a row to view details; Edit/Delete stop propagation. */}
              {vendors.map((v) => (
                <tr key={v.id} onClick={() => setViewing(v.id)} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-navy">{v.name}<div className="text-xs font-normal text-slate-400">{v.contactPerson} {v.phones && `· ${v.phones}`}</div></td>
                  <td><span className="badge bg-slate-100 text-slate-600">{v.type}</span></td>
                  <td className="text-slate-500">{v.gstin || '—'}</td>
                  <td className="text-slate-500">{v.siteMappings?.map((s: any) => s.project?.name).filter(Boolean).join(', ') || '—'}</td>
                  <td className="text-slate-500">{v._count?.docs ?? 0}</td>
                  <td><KycBadge kyc={v.kyc} kycStatus={v.kycStatus} /></td>
                  <td className="text-slate-400">{fmtDate(v.createdAt)}</td>
                  {canManage && <td className="px-2 text-right"><div className="flex justify-end gap-3"><button className="text-xs font-medium text-navy hover:underline" onClick={(e) => { e.stopPropagation(); setEditing(v); }}>Edit</button><button className="text-xs font-medium text-rose-500 hover:underline" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete vendor “${v.name}”? This can't be undone. (Blocked if it has any PO/WO or payment.)`)) del.mutate(v.id); }}>Delete</button></div></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {viewing && (
        <VendorDetail
          vendorId={viewing}
          canEdit={canManage}
          onEdit={() => { const vv = (data ?? []).find((x) => x.id === viewing); setViewing(null); if (vv) setEditing(vv); }}
          onClose={() => setViewing(null)}
        />
      )}
      {(show || editing) && (
        <VendorModal
          vendor={editing}
          onClose={() => { setShow(false); setEditing(null); }}
          onDone={() => { setShow(false); setEditing(null); qc.invalidateQueries({ queryKey: ['all-vendors'] }); }}
        />
      )}
    </div>
  );
}

// Add OR edit a vendor. Passing `vendor` prefills the form and switches to PATCH.
function VendorModal({ vendor, onClose, onDone }: { vendor?: any; onClose: () => void; onDone: () => void }) {
  const isEdit = !!vendor?.id;
  const [f, setF] = useState<any>({
    name: vendor?.name ?? '', type: vendor?.type ?? 'VENDOR', contactPerson: vendor?.contactPerson ?? '',
    phones: vendor?.phones ?? '', tel: vendor?.tel ?? '', fax: vendor?.fax ?? '', website: vendor?.website ?? '',
    address: vendor?.address ?? '', email: vendor?.email ?? '',
    gstin: vendor?.gstin ?? '', cin: vendor?.cin ?? '', pan: vendor?.pan ?? '', bankAccount: vendor?.bankAccount ?? '', ifsc: vendor?.ifsc ?? '',
  });
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => (isEdit ? api.patch(`/vendors/${vendor.id}`, f) : api.post('/vendors', f)),
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });
  const F = (k: string, label: string) => <div><label className="label">{label}</label><input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>;
  return (
    <Modal title={isEdit ? 'Edit Vendor / Contractor' : 'Add Vendor / Contractor'} onClose={onClose} wide persistent>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="grid gap-3 sm:grid-cols-2">
        {F('name', 'Name *')}
        <div><label className="label">Type</label><select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="VENDOR">Vendor (material)</option><option value="CONTRACTOR">Contractor (labor)</option></select></div>
        {F('contactPerson', 'Contact Person')}{F('phones', 'Phone(s)')}
        {F('tel', 'Tel')}{F('fax', 'Fax')}
        {F('website', 'Website')}{F('email', 'Email')}
        <div className="sm:col-span-2"><label className="label">Address</label><textarea className="input" rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></div>
        {F('gstin', 'GSTIN (GSTN.NO)')}{F('cin', 'CIN')}{F('pan', 'PAN')}{F('bankAccount', 'Bank Account')}{F('ifsc', 'IFSC')}
        {err && <div className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-outline" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Vendor'}</button></div>
      </form>
    </Modal>
  );
}
