import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { fmtDate } from '../../lib/format';

const TYPES = ['PO', 'WO', 'GRN', 'PI', 'KACCHA_BILL', 'TAX_INVOICE', 'DELIVERY_CHALLAN', 'KYC', 'COMPLETION_CERT', 'PHOTO', 'EWAY', 'PAYMENT_PROOF', 'PACKING_LIST', 'OTHER'];

// Upload the company logo and CEO e-signature used on all PO/WO/GRN documents.
function BrandingPanel() {
  const [ver, setVer] = useState(Date.now());
  const [msg, setMsg] = useState('');
  const up = useMutation({
    mutationFn: async (v: { kind: 'logo' | 'signature'; file: File }) => { const fd = new FormData(); fd.append('file', v.file); return api.post(`/branding/${v.kind}`, fd); },
    onSuccess: (_r, v) => { setMsg(`${v.kind === 'logo' ? 'Logo' : 'Signature'} updated.`); setVer(Date.now()); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const Slot = ({ kind, label, hint }: { kind: 'logo' | 'signature'; label: string; hint: string }) => (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-3">
      <div className="grid h-14 w-24 place-items-center overflow-hidden rounded bg-slate-50">
        <img src={`/api/branding/${kind}?v=${ver}`} alt={label} className="max-h-12 max-w-full object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-700">{label}</div>
        <div className="text-xs text-slate-400">{hint}</div>
      </div>
      <label className="btn-outline cursor-pointer text-xs">Upload<input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => e.target.files?.[0] && up.mutate({ kind, file: e.target.files[0] })} /></label>
    </div>
  );
  return (
    <div className="card p-4">
      <div className="mb-2 text-sm font-semibold text-slate-600">Company Branding <span className="text-xs font-normal text-slate-400">— used on every PO / WO / GRN</span></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Slot kind="logo" label="Company Logo" hint="Crystal logo (top-right of documents). PNG with transparent background works best." />
        <Slot kind="signature" label="CEO E-Signature" hint="Akash Agrawal's signature image. Tightly cropped PNG, transparent/white background." />
      </div>
      {msg && <div className="mt-2 text-xs text-green-700">{msg}</div>}
    </div>
  );
}

export default function DocumentsView({ projectId }: { projectId: string; role: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const isAdmin = canEdit('documents');
  const [filter, setFilter] = useState('');
  const [upType, setUpType] = useState('PI');

  const { data, isLoading } = useQuery({ queryKey: ['proc-documents', projectId, filter], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/documents${filter ? `?type=${filter}` : ''}`)).data.documents as any[] });

  const upload = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); fd.append('type', upType); return api.post(`/projects/${projectId}/procurement/documents`, fd); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proc-documents', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (isLoading) return <Spinner label="Loading documents…" />;
  const docs = data ?? [];

  return (
    <div className="space-y-3">
      {isAdmin && <BrandingPanel />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-slate-600">Document Repository ({docs.length})</h3>
          <select className="rounded-lg border border-slate-300 px-2 py-1 text-sm" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
          </select>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <select className="rounded-lg border border-slate-300 px-2 py-1 text-sm" value={upType} onChange={(e) => setUpType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
            <label className="btn-primary cursor-pointer text-sm">Upload<input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} /></label>
          </div>
        )}
      </div>

      {docs.length === 0 ? (
        <EmptyState title="No documents yet" hint="System-generated PO/WO/GRN PDFs are auto-saved on approval. Upload PIs, kaccha bills, tax invoices, KYC, payment proofs, etc." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">Type</th><th>File</th><th>Linked</th><th>Vendor</th><th>Uploaded</th><th></th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2"><span className="badge bg-slate-100 text-slate-600">{d.type.replace(/_/g, ' ')}</span></td>
                  <td className="text-slate-600">{d.fileName}</td>
                  <td className="text-slate-500">{d.linkedDocNumber || '—'}</td>
                  <td className="text-slate-500">{d.vendorName || '—'}</td>
                  <td className="text-slate-400">{fmtDate(d.uploadedAt)}</td>
                  <td className="px-2 text-right">{d.fileUrl.startsWith('/api/') ? <button className="text-xs font-medium text-navy hover:underline" onClick={() => openAuthedFile(d.fileUrl.replace(/^\/api/, ''))}>View →</button> : <a className="text-xs font-medium text-navy hover:underline" href={d.fileUrl} target="_blank" rel="noreferrer">View →</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
