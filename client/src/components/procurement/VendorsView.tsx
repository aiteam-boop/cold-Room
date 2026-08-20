import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Modal, Spinner } from '../ui';
import { fmtDate, inr } from '../../lib/format';
import VendorDetail from './VendorDetail';

// Full vendor master (Sprint PRD §5): multiple contacts, multiple plant
// addresses, several bank accounts, KYC documents and a dated rate chart.
// Vendors are company-wide; editing goes through the global /vendors routes so a
// change is visible in every project at once.

const KYC_DOT: Record<string, string> = { Complete: 'bg-green-500', Partial: 'bg-amber-500', Missing: 'bg-red-500' };
const VENDOR_TYPE_LABEL: Record<string, string> = {
  MANUFACTURER: 'Manufacturer', TRADER: 'Trader', CONTRACTOR: 'Contractor', SERVICE_PROVIDER: 'Service Provider',
};

interface Meta {
  vendorTypes: string[]; boqCategories: string[]; workCategories: string[];
  authorityLevels: string[]; bankAccountTypes: string[]; kycKinds: string[];
  maxContacts: number; maxPhonesPerContact: number;
}

export default function VendorsView({ projectId }: { projectId: string; role: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canManage = canEdit('vendors');
  const [editing, setEditing] = useState<any | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  // The vendors page shows deactivated vendors too; the PO picker does not.
  const { data, isLoading } = useQuery({
    queryKey: ['proc-vendors', projectId, 'all'],
    queryFn: async () => (await api.get(`/projects/${projectId}/procurement/vendors?includeInactive=1`)).data.vendors as any[],
  });
  const metaQ = useQuery({ queryKey: ['vendor-meta'], queryFn: async () => (await api.get('/vendors/meta')).data as Meta });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['proc-vendors', projectId, 'all'] });
    qc.invalidateQueries({ queryKey: ['proc-vendors', projectId] });
    qc.invalidateQueries({ queryKey: ['all-vendors'] });
  };
  // Delete a duplicate/unused vendor. The server refuses if it has POs/WOs or
  // payments, so a vendor with real transactions can never be orphaned. This hook
  // MUST sit before the early loading return — hooks can never run conditionally,
  // or React throws "Rendered more hooks than during the previous render".
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/vendors/${id}`),
    onSuccess: () => invalidate(),
    onError: (e) => alert(errMsg(e)),
  });

  if (isLoading) return <Spinner label="Loading vendors…" />;
  const all = data ?? [];
  const needle = q.toLowerCase().trim();
  const vendors = all
    .filter((v) => showInactive || v.isActive !== false)
    .filter((v) => !needle || [v.name, v.legalName, v.tradeName, v.gstin, ...(v.boqCategories ?? [])].filter(Boolean).some((s: string) => s.toLowerCase().includes(needle)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-slate-600">Vendors &amp; Contractors — company-wide ({vendors.length})</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-56 text-sm" placeholder="Search name, GSTIN, category…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
          {canManage && <button className="btn-primary text-sm" onClick={() => setCreating(true)}>+ Add Vendor</button>}
        </div>
      </div>

      {vendors.length === 0 ? (
        <EmptyState title={needle ? 'No vendors match that search' : 'No vendors yet'} hint={canManage ? "Add a vendor/contractor — they'll be selectable when creating POs/WOs." : 'No vendors yet.'} action={canManage && !needle ? <button className="btn-primary mt-2" onClick={() => setCreating(true)}>+ Add Vendor</button> : undefined} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Click a card to view details (read-only); Edit/Delete stop propagation. */}
          {vendors.map((v) => (
            <div key={v.id} role="button" onClick={() => setViewing(v.id)} className={`card cursor-pointer p-4 transition-shadow hover:shadow-md ${v.isActive === false ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-navy">{v.name}</div>
                  {v.legalName && v.legalName !== v.name && <div className="truncate text-[11px] text-slate-400">{v.legalName}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canManage && <button className="text-xs font-medium text-navy hover:underline" onClick={(e) => { e.stopPropagation(); setEditing(v); }}>Edit</button>}
                  {canManage && <button className="text-xs font-medium text-rose-500 hover:underline" onClick={(e) => { e.stopPropagation(); if (confirm(`Delete vendor “${v.name}”? This can't be undone. (Blocked if it has any PO/WO or payment.)`)) del.mutate(v.id); }}>Delete</button>}
                  <span className="badge bg-slate-100 text-slate-600">{v.vendorType ? VENDOR_TYPE_LABEL[v.vendorType] : v.type}</span>
                </div>
              </div>

              {v.isActive === false && <div className="mt-1 text-[11px] font-semibold text-red-600">Inactive — hidden from PO/WO search</div>}
              <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                <span className={`h-2 w-2 rounded-full ${KYC_DOT[v.kycStatus]}`} /> KYC {v.kycStatus}
                {v.kycDocCount > 0 && <span className="text-slate-300">· {v.kycDocCount} doc{v.kycDocCount > 1 ? 's' : ''}</span>}
              </div>

              {(v.boqCategories?.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {v.boqCategories.slice(0, 3).map((c: string) => <span key={c} className="badge bg-blue-50 text-blue-700">{c}</span>)}
                  {v.boqCategories.length > 3 && <span className="badge bg-slate-100 text-slate-500">+{v.boqCategories.length - 3}</span>}
                </div>
              )}

              <div className="mt-2 space-y-0.5 text-xs text-slate-400">
                {v.gstin && <div>GSTIN: {v.gstin}</div>}
                {primaryContact(v) && <div className="truncate">Contact: {primaryContact(v)!.name}{primaryContact(v)!.phones?.[0] ? ` · ${primaryContact(v)!.phones[0]}` : ''}</div>}
                {v.plants?.length > 0 && <div>{v.plants.length} plant address{v.plants.length > 1 ? 'es' : ''}</div>}
                {v.rateChart?.length > 0 && <div>{v.rateChart.length} rate{v.rateChart.length > 1 ? 's' : ''} on file</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewing && (
        <VendorDetail
          vendorId={viewing}
          canEdit={canManage}
          onEdit={() => { const vv = all.find((x) => x.id === viewing); setViewing(null); if (vv) setEditing(vv); }}
          onClose={() => setViewing(null)}
        />
      )}

      {(creating || editing) && metaQ.data && (
        <VendorModal
          projectId={projectId}
          vendor={editing}
          meta={metaQ.data}
          onClose={() => { setCreating(false); setEditing(null); }}
          onDone={() => { setCreating(false); setEditing(null); invalidate(); }}
        />
      )}
    </div>
  );
}

const primaryContact = (v: any) => (v.contacts ?? []).find((c: any) => c.isPrimary) ?? (v.contacts ?? [])[0] ?? null;

// ── Editor ───────────────────────────────────────────────────────────────────

type Tab = 'basic' | 'contacts' | 'financial' | 'kyc' | 'rates';
const TABS: { key: Tab; label: string }[] = [
  { key: 'basic', label: 'Basic Info' },
  { key: 'contacts', label: 'Contacts & Plants' },
  { key: 'financial', label: 'Financial' },
  { key: 'kyc', label: 'KYC Documents' },
  { key: 'rates', label: 'Rate Chart' },
];

function VendorModal({ projectId, vendor, meta, onClose, onDone }: { projectId: string; vendor?: any; meta: Meta; onClose: () => void; onDone: () => void }) {
  const isEdit = !!vendor?.id;
  const [tab, setTab] = useState<Tab>('basic');
  const [err, setErr] = useState('');
  const [f, setF] = useState<any>(() => ({
    name: vendor?.name ?? '', legalName: vendor?.legalName ?? '', tradeName: vendor?.tradeName ?? '',
    type: vendor?.type ?? 'VENDOR', vendorType: vendor?.vendorType ?? '',
    boqCategories: vendor?.boqCategories ?? [], workCategories: vendor?.workCategories ?? [],
    website: vendor?.website ?? '', tel: vendor?.tel ?? '', fax: vendor?.fax ?? '', email: vendor?.email ?? '',
    address: vendor?.address ?? '',
    gstin: vendor?.gstin ?? '', cin: vendor?.cin ?? '', pan: vendor?.pan ?? '',
    registeredSince: vendor?.registeredSince?.slice?.(0, 10) ?? '',
    isActive: vendor?.isActive ?? true,
    contacts: vendor?.contacts ?? [],
    plants: vendor?.plants ?? [],
    billingAddress: vendor?.billingAddress ?? null,
    bankAccounts: vendor?.bankAccounts ?? [],
    rateChart: vendor?.rateChart ?? [],
  }));

  const isContractor = f.vendorType === 'CONTRACTOR' || f.type === 'CONTRACTOR';

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...f,
        vendorType: f.vendorType || null,
        registeredSince: f.registeredSince || null,
        workCategories: isContractor ? f.workCategories : [],
        // Drop half-typed rows rather than 400-ing on them.
        contacts: (f.contacts as any[]).filter((c) => c.name?.trim()),
        plants: (f.plants as any[]).filter((p) => p.address?.trim()),
        bankAccounts: (f.bankAccounts as any[]).filter((b) => b.bankName?.trim() && b.accountNo?.trim()),
        rateChart: (f.rateChart as any[]).filter((r) => r.itemDescription?.trim() && r.rate !== ''),
        billingAddress: f.billingAddress?.address?.trim() ? f.billingAddress : null,
      };
      // Both paths hit the global vendor routes — they are the only ones that
      // accept the full profile (contacts, plants, banks, rate chart). Creating
      // also maps the new vendor to this project as a site. The project-scoped
      // inline-create endpoint stays for the "add while drafting a PO" flow.
      return isEdit
        ? api.patch(`/vendors/${vendor.id}`, payload)
        : api.post('/vendors', { ...payload, projectIds: [projectId] });
    },
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });

  const set = (patch: any) => setF((p: any) => ({ ...p, ...patch }));
  const toggle = (key: 'boqCategories' | 'workCategories', v: string) =>
    set({ [key]: f[key].includes(v) ? f[key].filter((x: string) => x !== v) : [...f[key], v] });

  // A KYC document was read (GST certificate / PAN card / incorporation cert):
  // drop the numbers straight into the Financial tab. They are only SUGGESTED —
  // the user reviews them there and still has to press Save Changes.
  const [readMsg, setReadMsg] = useState<{ text: string; found: string[] } | null>(null);
  const applyExtracted = (e: { gstin?: string; pan?: string; cin?: string; source?: string; note?: string }) => {
    const patch: any = {};
    const found: string[] = [];
    if (e.gstin) { patch.gstin = e.gstin; found.push(`GSTIN ${e.gstin}`); }
    if (e.pan) { patch.pan = e.pan; found.push(`PAN ${e.pan}`); }
    if (e.cin) { patch.cin = e.cin; found.push(`CIN ${e.cin}`); }
    if (!found.length) { setReadMsg({ text: e.note || 'Nothing could be read from that document.', found: [] }); return; }
    set(patch);
    setReadMsg({ text: e.source === 'pdf-text' ? 'Read from the document text' : 'Read from the document image', found });
    setTab('financial');
  };

  return (
    <Modal title={isEdit ? `Edit ${vendor.name}` : 'Add Vendor / Contractor'} onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {TABS.map((t) => (
          // KYC + rate chart need a saved vendor id to attach things to.
          <button key={t.key} type="button" disabled={!isEdit && (t.key === 'kyc' || t.key === 'rates')}
            title={!isEdit && (t.key === 'kyc' || t.key === 'rates') ? 'Save the vendor first' : ''}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 font-medium disabled:opacity-40 ${tab === t.key ? 'bg-white text-navy shadow-sm' : 'text-slate-500'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* What the KYC reader pulled off the uploaded document. */}
      {readMsg && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-sm ${readMsg.found.length ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              {readMsg.found.length ? (
                <>
                  <div className="font-medium">✓ {readMsg.text} — filled into Financial</div>
                  <div className="mt-0.5 text-xs">{readMsg.found.join(' · ')}</div>
                  <div className="mt-0.5 text-[11px] opacity-80">Check they are right, then press <strong>Save Changes</strong>.</div>
                </>
              ) : <div>{readMsg.text}</div>}
            </div>
            <button type="button" className="text-lg leading-none opacity-50 hover:opacity-100" onClick={() => setReadMsg(null)}>×</button>
          </div>
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="space-y-4">
        {tab === 'basic' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Display name *"><input className="input" required value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Company Legal Name" hint="e.g. Kingspan Jindal Pvt. Ltd."><input className="input" value={f.legalName} onChange={(e) => set({ legalName: e.target.value })} /></Field>
            <Field label="Trade Name / Brand" hint="If different from the legal name"><input className="input" value={f.tradeName} onChange={(e) => set({ tradeName: e.target.value })} /></Field>
            <Field label="Vendor Type *">
              <select className="input" value={f.vendorType} onChange={(e) => set({ vendorType: e.target.value })}>
                <option value="">— select —</option>
                {meta.vendorTypes.map((t) => <option key={t} value={t}>{VENDOR_TYPE_LABEL[t]}</option>)}
              </select>
            </Field>

            <div className="sm:col-span-2">
              <label className="label">BOQ Categories supplied *</label>
              <div className="flex flex-wrap gap-1.5">
                {meta.boqCategories.map((c) => <Chip key={c} on={f.boqCategories.includes(c)} onClick={() => toggle('boqCategories', c)}>{c}</Chip>)}
              </div>
            </div>

            {isContractor && (
              <div className="sm:col-span-2">
                <label className="label">Work categories</label>
                <div className="flex flex-wrap gap-1.5">
                  {meta.workCategories.map((c) => <Chip key={c} on={f.workCategories.includes(c)} onClick={() => toggle('workCategories', c)}>{c}</Chip>)}
                </div>
              </div>
            )}

            <Field label="Website"><input className="input" value={f.website} onChange={(e) => set({ website: e.target.value })} /></Field>
            <Field label="Company Email"><input className="input" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Tel"><input className="input" value={f.tel} onChange={(e) => set({ tel: e.target.value })} /></Field>
            <Field label="Fax"><input className="input" value={f.fax} onChange={(e) => set({ fax: e.target.value })} /></Field>
            <Field label="Registered Since" hint="When this vendor was first engaged"><input className="input" type="date" value={f.registeredSince} onChange={(e) => set({ registeredSince: e.target.value })} /></Field>
            <Field label="Status">
              <label className="flex h-[38px] items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
                Active — appears in PO/WO vendor search
              </label>
            </Field>
            <div className="sm:col-span-2"><Field label="Primary address" hint="Shown on the PO 'To' block"><textarea className="input" rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} /></Field></div>
          </div>
        )}

        {tab === 'contacts' && (
          <div className="space-y-5">
            <Repeater
              title={`Contact Persons (${f.contacts.length}/${meta.maxContacts})`}
              hint="One contact is primary — they appear first on the PO."
              items={f.contacts}
              canAdd={f.contacts.length < meta.maxContacts}
              onAdd={() => set({ contacts: [...f.contacts, { name: '', designation: '', authorityLevel: null, phones: [''], email: '', isPrimary: f.contacts.length === 0 }] })}
              onRemove={(i) => set({ contacts: f.contacts.filter((_: any, x: number) => x !== i) })}
              render={(c, i) => {
                const setC = (patch: any) => set({ contacts: f.contacts.map((x: any, idx: number) => (idx === i ? { ...x, ...patch } : x)) });
                return (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Name *"><input className="input" value={c.name} onChange={(e) => setC({ name: e.target.value })} /></Field>
                    <Field label="Designation"><input className="input" placeholder="Sales Manager" value={c.designation ?? ''} onChange={(e) => setC({ designation: e.target.value })} /></Field>
                    <Field label="Authority Level">
                      <select className="input" value={c.authorityLevel ?? ''} onChange={(e) => setC({ authorityLevel: e.target.value || null })}>
                        <option value="">—</option>
                        {meta.authorityLevels.map((a) => <option key={a} value={a}>{a}</option>)}
                      </select>
                    </Field>
                    <Field label="Email"><input className="input" value={c.email ?? ''} onChange={(e) => setC({ email: e.target.value })} /></Field>
                    <div className="sm:col-span-2">
                      <label className="label">Phone numbers (mobile, office, alternate)</label>
                      <div className="flex flex-wrap gap-2">
                        {(c.phones ?? []).map((p: string, pi: number) => (
                          <input key={pi} className="input w-40" value={p} onChange={(e) => setC({ phones: c.phones.map((x: string, xi: number) => (xi === pi ? e.target.value : x)) })} />
                        ))}
                        {(c.phones?.length ?? 0) < meta.maxPhonesPerContact && (
                          <button type="button" className="btn-outline text-xs" onClick={() => setC({ phones: [...(c.phones ?? []), ''] })}>+ Phone</button>
                        )}
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600 sm:col-span-2">
                      <input type="radio" name="primary-contact" checked={!!c.isPrimary}
                        onChange={() => set({ contacts: f.contacts.map((x: any, idx: number) => ({ ...x, isPrimary: idx === i })) })} />
                      Primary contact
                    </label>
                  </div>
                );
              }}
            />

            <Repeater
              title={`Factory / Plant Addresses (${f.plants.length})`}
              hint="Each plant can carry its own GSTIN."
              items={f.plants}
              canAdd
              onAdd={() => set({ plants: [...f.plants, { address: '', address2: '', city: '', state: '', pin: '', gstin: '' }] })}
              onRemove={(i) => set({ plants: f.plants.filter((_: any, x: number) => x !== i) })}
              render={(p, i) => {
                const setP = (patch: any) => set({ plants: f.plants.map((x: any, idx: number) => (idx === i ? { ...x, ...patch } : x)) });
                return (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Address line 1 *"><input className="input" value={p.address} onChange={(e) => setP({ address: e.target.value })} /></Field>
                    <Field label="Address line 2"><input className="input" value={p.address2 ?? ''} onChange={(e) => setP({ address2: e.target.value })} /></Field>
                    <Field label="City"><input className="input" value={p.city ?? ''} onChange={(e) => setP({ city: e.target.value })} /></Field>
                    <Field label="State"><input className="input" value={p.state ?? ''} onChange={(e) => setP({ state: e.target.value })} /></Field>
                    <Field label="PIN"><input className="input" value={p.pin ?? ''} onChange={(e) => setP({ pin: e.target.value })} /></Field>
                    <Field label="GSTIN for this plant"><input className="input" value={p.gstin ?? ''} onChange={(e) => setP({ gstin: e.target.value })} /></Field>
                  </div>
                );
              }}
            />

            <div>
              <div className="mb-2 text-sm font-semibold text-slate-600">Billing Address</div>
              <p className="mb-2 text-xs text-slate-400">Used on the PO “Invoice To” field. May differ from the factory address.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="sm:col-span-2"><Field label="Address"><textarea className="input" rows={2} value={f.billingAddress?.address ?? ''} onChange={(e) => set({ billingAddress: { ...(f.billingAddress ?? {}), address: e.target.value } })} /></Field></div>
                <Field label="City"><input className="input" value={f.billingAddress?.city ?? ''} onChange={(e) => set({ billingAddress: { ...(f.billingAddress ?? {}), city: e.target.value } })} /></Field>
                <Field label="State"><input className="input" value={f.billingAddress?.state ?? ''} onChange={(e) => set({ billingAddress: { ...(f.billingAddress ?? {}), state: e.target.value } })} /></Field>
                <Field label="PIN"><input className="input" value={f.billingAddress?.pin ?? ''} onChange={(e) => set({ billingAddress: { ...(f.billingAddress ?? {}), pin: e.target.value } })} /></Field>
              </div>
            </div>
          </div>
        )}

        {tab === 'financial' && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="GSTIN" hint="Primary GST number"><input className="input" value={f.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} /></Field>
              <Field label="PAN Number" hint="For TDS deduction"><input className="input" value={f.pan} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} /></Field>
              <Field label="CIN"><input className="input" value={f.cin} onChange={(e) => set({ cin: e.target.value.toUpperCase() })} /></Field>
            </div>

            <Repeater
              title={`Bank Accounts (${f.bankAccounts.length})`}
              hint="Some vendors hold different accounts per state/plant. Mark one primary — Accounts pays into it by default."
              items={f.bankAccounts}
              canAdd
              onAdd={() => set({ bankAccounts: [...f.bankAccounts, { bankName: '', branch: '', ifsc: '', accountNo: '', accountType: 'Current', beneficiaryName: '', isPrimary: f.bankAccounts.length === 0 }] })}
              onRemove={(i) => set({ bankAccounts: f.bankAccounts.filter((_: any, x: number) => x !== i) })}
              render={(b, i) => {
                const setB = (patch: any) => set({ bankAccounts: f.bankAccounts.map((x: any, idx: number) => (idx === i ? { ...x, ...patch } : x)) });
                return (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <Field label="Bank Name *"><input className="input" value={b.bankName} onChange={(e) => setB({ bankName: e.target.value })} /></Field>
                    <Field label="Branch"><input className="input" value={b.branch ?? ''} onChange={(e) => setB({ branch: e.target.value })} /></Field>
                    <Field label="Account Number *"><input className="input" value={b.accountNo} onChange={(e) => setB({ accountNo: e.target.value })} /></Field>
                    <Field label="IFSC"><input className="input" value={b.ifsc ?? ''} onChange={(e) => setB({ ifsc: e.target.value.toUpperCase() })} /></Field>
                    <Field label="Account Type">
                      <select className="input" value={b.accountType ?? ''} onChange={(e) => setB({ accountType: e.target.value || null })}>
                        <option value="">—</option>
                        {meta.bankAccountTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </Field>
                    <Field label="Beneficiary Name" hint="As per bank records"><input className="input" value={b.beneficiaryName ?? ''} onChange={(e) => setB({ beneficiaryName: e.target.value })} /></Field>
                    <label className="flex items-center gap-2 text-xs text-slate-600 sm:col-span-3">
                      <input type="radio" name="primary-bank" checked={!!b.isPrimary}
                        onChange={() => set({ bankAccounts: f.bankAccounts.map((x: any, idx: number) => ({ ...x, isPrimary: idx === i })) })} />
                      Primary account
                    </label>
                  </div>
                );
              }}
            />
          </div>
        )}

        {tab === 'kyc' && isEdit && <KycPanel projectId={projectId} vendorId={vendor.id} meta={meta} onExtracted={applyExtracted} />}
        {tab === 'rates' && isEdit && <RatePanel vendorId={vendor.id} rates={f.rateChart} onChange={(rateChart) => set({ rateChart })} />}

        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-outline" onClick={onClose}>Close</button>
          <button className="btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Vendor'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── KYC ──────────────────────────────────────────────────────────────────────

type Extracted = { gstin?: string; pan?: string; cin?: string; source?: string; note?: string };

function KycPanel({ projectId, vendorId, meta, onExtracted }: {
  projectId: string; vendorId: string; meta: Meta;
  /** The GSTIN / PAN / CIN read off the document, for the Financial tab to fill. */
  onExtracted: (e: Extracted) => void;
}) {
  const qc = useQueryClient();
  const [kind, setKind] = useState(meta.kycKinds[0]);
  const [msg, setMsg] = useState('');

  const docsQ = useQuery({ queryKey: ['vendor-detail', vendorId], queryFn: async () => (await api.get(`/vendors/${vendorId}`)).data.vendor });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['vendor-detail', vendorId] });
    qc.invalidateQueries({ queryKey: ['proc-vendors', projectId, 'all'] });
    qc.invalidateQueries({ queryKey: ['proc-vendors', projectId] });
  };
  const up = useMutation({
    mutationFn: (file: File) => { const fd = new FormData(); fd.append('file', file); fd.append('kycKind', kind); return api.post(`/projects/${projectId}/procurement/vendors/${vendorId}/kyc`, fd); },
    // The upload also reads the document; a failed read never fails the upload.
    onSuccess: (r) => { setMsg('Uploaded.'); refresh(); if (r.data?.extracted) onExtracted(r.data.extracted); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Re-read a document that was uploaded before this existed (or that failed).
  const read = useMutation({
    mutationFn: (docId: string) => api.post(`/projects/${projectId}/procurement/vendors/${vendorId}/kyc/${docId}/extract`),
    onSuccess: (r) => { setMsg(''); onExtracted(r.data?.extracted ?? {}); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Remove a wrong/outdated KYC file so the right one can be uploaded in its place.
  const del = useMutation({
    mutationFn: (docId: string) => api.delete(`/projects/${projectId}/procurement/vendors/${vendorId}/kyc/${docId}`),
    onSuccess: () => { setMsg('Document removed — you can upload a new one.'); refresh(); },
    onError: (e) => setMsg(errMsg(e)),
  });

  const docs: any[] = docsQ.data?.kycDocs ?? [];
  const status = docsQ.data?.kycStatus ?? 'Missing';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className={`h-2.5 w-2.5 rounded-full ${KYC_DOT[status]}`} />
        <span className="font-medium text-slate-700">KYC {status}</span>
        <span className="text-xs text-slate-400">Complete requires GST certificate + PAN card + cancelled cheque.</span>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-3">
        <div className="flex-1">
          <label className="label">Document type</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {meta.kycKinds.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</option>)}
          </select>
        </div>
        <div className="flex-1">
          <label className="label">File (PDF or image)</label>
          <input className="input text-xs" type="file" accept=".pdf,image/*" disabled={up.isPending} onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} />
        </div>
      </div>
      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{msg}</div>}

      {docs.length === 0 ? (
        <div className="text-sm text-slate-400">No KYC documents uploaded yet.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">Type</th><th>File</th><th>Uploaded</th><th className="text-right">Read</th><th className="text-right">Remove</th></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id} className="border-t border-slate-100">
                <td className="py-1.5 text-xs">{(d.kycKind ?? 'Unspecified').replace(/_/g, ' ')}</td>
                <td><a className="text-xs font-medium text-navy hover:underline" href={d.fileUrl} target="_blank" rel="noreferrer">{d.fileName}</a></td>
                <td className="text-xs text-slate-400">{fmtDate(d.uploadedAt)}</td>
                {/* Pull the GSTIN / PAN / CIN off a document uploaded earlier. */}
                <td className="text-right">
                  <button
                    type="button"
                    className="text-xs font-medium text-navy hover:underline disabled:opacity-40"
                    disabled={read.isPending}
                    title="Read the GSTIN / PAN / CIN off this document"
                    onClick={() => read.mutate(d.id)}
                  >{read.isPending && read.variables === d.id ? 'Reading…' : '🔍 Read'}</button>
                </td>
                {/* Remove a wrong file so the right one can be uploaded in its place. */}
                <td className="text-right">
                  <button
                    type="button"
                    className="text-slate-300 hover:text-red-500 disabled:opacity-40"
                    disabled={del.isPending}
                    title="Remove this document"
                    onClick={() => {
                      if (window.confirm(`Remove "${d.fileName}"? You can upload a replacement afterwards.`)) del.mutate(d.id);
                    }}
                  >✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Rate chart ───────────────────────────────────────────────────────────────

function RatePanel({ vendorId, rates, onChange }: { vendorId: string; rates: any[]; onChange: (r: any[]) => void }) {
  const [draft, setDraft] = useState({ itemDescription: '', unit: '', rate: '', effectiveFrom: new Date().toISOString().slice(0, 10), notes: '' });
  const [msg, setMsg] = useState('');

  // Adding a rate is append-only server-side: it closes the previous open-ended
  // window for that item rather than overwriting it, preserving rate history.
  const add = useMutation({
    mutationFn: async () => (await api.post(`/vendors/${vendorId}/rates`, { ...draft, rate: Number(draft.rate) })).data.rates as any[],
    onSuccess: (r) => { onChange(r); setDraft({ ...draft, itemDescription: '', unit: '', rate: '', notes: '' }); setMsg('Rate added.'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: async (rateId: string) => (await api.delete(`/vendors/${vendorId}/rates/${rateId}`)).data.rates as any[],
    onSuccess: (r) => { onChange(r); setMsg('Rate removed.'); },
    onError: (e) => setMsg(errMsg(e)),
  });

  const today = new Date().toISOString().slice(0, 10);
  const isCurrent = (r: any) => (!r.effectiveFrom || r.effectiveFrom <= today) && (!r.effectiveTo || r.effectiveTo >= today);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">Rates are date-ranged and never overwritten — a price change adds a new entry. The current rate is auto-suggested when this vendor is picked on a PO line.</p>

      <div className="grid items-end gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-6">
        <div className="sm:col-span-2"><Field label="Product / BOQ item"><input className="input" value={draft.itemDescription} onChange={(e) => setDraft({ ...draft, itemDescription: e.target.value })} /></Field></div>
        <Field label="Unit"><input className="input" placeholder="Sq.M" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /></Field>
        <Field label="Rate (₹)"><input className="input" type="number" min="0" step="0.01" value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} /></Field>
        <Field label="Effective From"><input className="input" type="date" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} /></Field>
        <button type="button" className="btn-primary text-sm" disabled={!draft.itemDescription.trim() || draft.rate === '' || add.isPending} onClick={() => { setMsg(''); add.mutate(); }}>+ Add Rate</button>
      </div>
      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{msg}</div>}

      {rates.length === 0 ? (
        <div className="text-sm text-slate-400">No rates on file. A vendor with no rate chart can still be used on a PO — the price is simply typed manually.</div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">Item</th><th>Unit</th><th className="text-right">Rate</th><th>Effective</th><th></th></tr></thead>
          <tbody>
            {rates.map((r) => (
              <tr key={r.id} className={`border-t border-slate-100 ${isCurrent(r) ? '' : 'text-slate-400'}`}>
                <td className="py-1.5">{r.itemDescription} {isCurrent(r) && <span className="badge bg-green-100 text-green-700">current</span>}</td>
                <td className="text-xs">{r.unit || '—'}</td>
                <td className="text-right font-medium">{inr(r.rate)}</td>
                <td className="text-xs">{r.effectiveFrom ? fmtDate(r.effectiveFrom) : '—'} → {r.effectiveTo ? fmtDate(r.effectiveTo) : 'open'}</td>
                <td className="text-right"><button type="button" className="text-slate-300 hover:text-red-500" onClick={() => del.mutate(r.id)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Small building blocks ────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${on ? 'border-navy bg-navy/10 text-navy' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
      {children}
    </button>
  );
}

function Repeater({ title, hint, items, canAdd, onAdd, onRemove, render }: {
  title: string; hint?: string; items: any[]; canAdd: boolean;
  onAdd: () => void; onRemove: (i: number) => void; render: (item: any, i: number) => React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-sm font-semibold text-slate-600">{title}</div>
      {hint && <p className="mb-2 text-xs text-slate-400">{hint}</p>}
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="relative rounded-lg border border-slate-200 p-3">
            <button type="button" className="absolute right-2 top-2 text-slate-300 hover:text-red-500" onClick={() => onRemove(i)}>✕</button>
            {render(item, i)}
          </div>
        ))}
        {items.length === 0 && <div className="text-xs text-slate-400">None yet.</div>}
      </div>
      {canAdd && <button type="button" className="btn-outline mt-2 text-xs" onClick={onAdd}>+ Add</button>}
    </div>
  );
}
