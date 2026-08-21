import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Modal, Spinner } from '../ui';
import { fmtDate, inr, titleize } from '../../lib/format';

const KYC_DOT: Record<string, string> = { Complete: 'bg-green-500', Partial: 'bg-amber-500', Missing: 'bg-red-500' };
// Pill colour follows the classic KYC status (green/amber/red); percentage rides inside.
const KYC_STATUS_CLASS: Record<string, string> = {
  Complete: 'bg-green-100 text-green-700 border-green-200',
  Partial: 'bg-amber-100 text-amber-700 border-amber-200',
  Missing: 'bg-red-100 text-red-700 border-red-200',
};

// Read-only vendor detail — opened by clicking a vendor card/row, so anyone can
// SEE a vendor's details without going through the Edit form.
export default function VendorDetail({ vendorId, canEdit, onEdit, onClose }: { vendorId: string; canEdit?: boolean; onEdit?: () => void; onClose: () => void }) {
  const { data: v, isLoading } = useQuery({ queryKey: ['vendor-detail', vendorId], queryFn: async () => (await api.get(`/vendors/${vendorId}`)).data.vendor as any });

  return (
    <Modal title={v?.name || 'Vendor details'} onClose={onClose} wide>
      {isLoading || !v ? <Spinner label="Loading vendor…" /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge bg-slate-100 text-slate-600">{v.vendorType || v.type || 'Vendor'}</span>
            {v.kyc ? (
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${KYC_STATUS_CLASS[v.kycStatus] || KYC_STATUS_CLASS.Missing}`} title={v.kyc.mandatoryMissing?.length ? `Cannot use — missing: ${v.kyc.mandatoryMissing.join(', ')}` : 'KYC complete'}>
                <span className={`h-2 w-2 rounded-full ${KYC_DOT[v.kycStatus] || 'bg-slate-300'}`} />
                KYC {v.kyc.percent}% · {v.kyc.completed}/{v.kyc.total}{!v.kyc.usable && ' ⚠'}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs"><span className={`h-2 w-2 rounded-full ${KYC_DOT[v.kycStatus] || 'bg-slate-300'}`} /> KYC {v.kycStatus || '—'}</span>
            )}
            {v.isActive === false && <span className="badge bg-red-50 text-red-600">Inactive</span>}
            {canEdit && onEdit && <button className="btn-outline ml-auto text-xs" onClick={onEdit}>✎ Edit</button>}
          </div>

          <Section title="Identity">
            <Row k="Legal name" v={v.legalName} />
            <Row k="Trade name" v={v.tradeName} />
            <Row k="GSTIN" v={v.gstin} />
            <Row k="PAN" v={v.pan} />
            <Row k="Website" v={v.website} />
          </Section>

          {(v.contacts?.length ?? 0) > 0 && (
            <Section title="Contacts">
              {v.contacts.map((c: any, i: number) => (
                <div key={i} className="rounded border border-slate-100 px-2 py-1">
                  <span className="font-medium text-slate-700">{c.name}</span>
                  {c.isPrimary && <span className="badge ml-1 bg-navy-50 text-navy">Primary</span>}
                  {c.designation && <span className="text-slate-500"> · {c.designation}</span>}
                  <div className="text-xs text-slate-500">{[...(c.phones ?? []), c.email].filter(Boolean).join(' · ') || '—'}</div>
                </div>
              ))}
            </Section>
          )}

          {((v.boqCategories?.length ?? 0) > 0 || (v.workCategories?.length ?? 0) > 0) && (
            <Section title="Supplies / Work">
              <div className="flex flex-wrap gap-1">
                {[...(v.boqCategories ?? []), ...(v.workCategories ?? [])].map((c: string) => <span key={c} className="badge bg-blue-50 text-blue-700">{c}</span>)}
              </div>
            </Section>
          )}

          {(v.siteMappings?.length ?? 0) > 0 && (
            <Section title="Mapped sites">
              <div className="text-slate-600">{v.siteMappings.map((s: any) => s.project?.name).filter(Boolean).join(', ') || '—'}</div>
            </Section>
          )}

          {v.kyc?.items && (
            <Section title="KYC checklist">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {v.kyc.items.map((it: any) => (
                  <span key={it.key} className={it.done ? 'text-emerald-600' : it.mandatory ? 'text-red-600' : 'text-slate-400'} title={it.mandatory ? 'Mandatory' : 'Optional'}>
                    {it.done ? '✓' : '○'} {it.label}{it.mandatory && !it.done ? ' *' : ''}
                  </span>
                ))}
              </div>
              {!v.kyc.usable && <div className="mt-1 text-[11px] font-medium text-red-600">⚠ Not usable for PO/payment — {v.kyc.mandatoryMissing.join(', ')} missing.</div>}
            </Section>
          )}

          <Section title={`KYC documents (${v.kycDocs?.length ?? 0})`}>
            {(v.kycDocs?.length ?? 0) === 0 ? <div className="text-xs text-slate-400">No KYC documents uploaded.</div> : (
              <div className="space-y-0.5">
                {v.kycDocs.map((d: any) => (
                  <a key={d.id} href={d.fileUrl} target="_blank" rel="noreferrer" className="block text-navy hover:underline" title={d.fileName}>📄 {d.kycKind ? titleize(d.kycKind) : (d.fileName || 'KYC')}</a>
                ))}
              </div>
            )}
          </Section>

          <Section title={`Purchase / Work Orders (${v.docs?.length ?? 0})`}>
            {(v.docs?.length ?? 0) === 0 ? <div className="text-xs text-slate-400">No POs/WOs raised against this vendor yet.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left uppercase text-slate-400"><tr><th className="py-1">No.</th><th>Type</th><th>Status</th><th className="text-right">Amount</th><th className="text-right">Date</th></tr></thead>
                  <tbody>
                    {v.docs.map((d: any) => (
                      <tr key={d.id} className="border-t border-slate-100">
                        <td className="py-1 font-medium text-navy">{d.docNumber}</td>
                        <td className="text-slate-500">{d.type}</td>
                        <td className="text-slate-500">{titleize(d.status)}</td>
                        <td className="text-right">{d.finalAmount != null ? inr(d.finalAmount) : '—'}</td>
                        <td className="text-right text-slate-400">{fmtDate(d.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {(v.rateChart?.length ?? 0) > 0 && <div className="text-xs text-slate-400">{v.rateChart.length} rate{v.rateChart.length > 1 ? 's' : ''} on file (see Edit → Rate chart).</div>}
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v?: string | null }) {
  if (!v) return null;
  return <div className="flex gap-2"><span className="w-28 shrink-0 text-slate-400">{k}</span><span className="text-slate-700">{v}</span></div>;
}
