import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { docStatusPill, fmtDate, inr, titleize } from '../../lib/format';
import DocBuilder from './DocBuilder';
import { DeliveryPill, type Delivery } from '../DeliveryBadge';

interface Doc { id: string; type: string; docNumber: string; status: string; vendorName?: string; docDate: string; basicAmount: number; finalAmount: number; esignApplied: boolean; counts: { lineItems: number; grns: number; milestones: number }; delivery?: Delivery; createdBy?: { name: string; email: string } | null; pendingWith?: string | null; pendingWithRole?: string | null; approvedSteps?: number; totalSteps?: number; }

export default function DocList({ projectId, role, type, focusId }: { projectId: string; role: string; type: 'PO' | 'WO' | 'TO'; focusId?: string }) {
  const qc = useQueryClient();
  const { canEdit, hideFinancials } = useAuth();
  const isAdmin = canEdit(type === 'PO' ? 'po' : type === 'TO' ? 'to' : 'wo');
  const label = type === 'PO' ? 'Purchase Orders' : type === 'TO' ? 'Transport Orders' : 'Work Orders';
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [q, setQ] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['proc-docs', projectId, type],
    queryFn: async () => (await api.get(`/projects/${projectId}/procurement/docs?type=${type}`)).data.docs as Doc[],
  });

  const create = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/docs`, { type })).data.doc,
    onSuccess: (doc) => { qc.invalidateQueries({ queryKey: ['proc-docs', projectId, type] }); setOpenId(doc.id); },
    onError: (e) => alert(errMsg(e)),
  });
  // Drafts and on-hold docs can be deleted — a pending/approved doc is a record.
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/procurement/docs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['proc-docs', projectId, type] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (openId) return <DocBuilder projectId={projectId} docId={openId} role={role} onClose={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ['proc-docs', projectId, type] }); }} />;
  if (isLoading) return <Spinner label="Loading…" />;
  const allDocs = data ?? [];
  // Client-side search over number / vendor / raiser / status — no server round-trip.
  const term = q.trim().toLowerCase();
  const docs = term
    ? allDocs.filter((d) => [d.docNumber, d.vendorName, d.createdBy?.email, d.createdBy?.name, d.status].some((v) => (v || '').toLowerCase().includes(term)))
    : allDocs;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-600">{label} ({docs.length}{term && docs.length !== allDocs.length ? ` of ${allDocs.length}` : ''})</h3>
        <div className="flex items-center gap-2">
          {allDocs.length > 0 && (
            <input className="input h-8 w-52 text-sm" placeholder={`Search ${type} no. / vendor…`} value={q} onChange={(e) => setQ(e.target.value)} />
          )}
          {isAdmin && <button className="btn-primary text-sm" disabled={create.isPending} onClick={() => create.mutate()}>+ New {type}</button>}
        </div>
      </div>
      {allDocs.length === 0 ? (
        <EmptyState title={`No ${label} yet`} hint={isAdmin ? `Create a ${type} with the company's exact format — vendor auto-fill, line items, 6-field payment terms and T&C.` : 'None created yet.'} action={isAdmin ? <button className="btn-primary mt-2" onClick={() => create.mutate()}>+ New {type}</button> : undefined} />
      ) : docs.length === 0 ? (
        <div className="card px-4 py-8 text-center text-sm text-slate-400">No {type} matches “{q}”.</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">{type} No.</th><th>Vendor</th><th>Created by</th><th>Date</th><th className="text-right">Basic</th><th className="text-right">Final</th><th>Status</th><th>Delivery</th><th></th></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-navy">{d.docNumber}</td>
                  <td className="text-slate-600">{d.vendorName || '—'}</td>
                  {/* Who raised it — the email, so it is obvious who to go back to. */}
                  <td className="text-slate-500">
                    {d.createdBy
                      ? <span title={d.createdBy.name} className="text-xs">{d.createdBy.email}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="text-slate-500">{fmtDate(d.docDate)}</td>
                  <td className="text-right">{money(d.basicAmount)}</td>
                  <td className="text-right font-medium">{money(d.finalAmount)}</td>
                  <td>
                    <span className={`badge ${docStatusPill(d.status)}`}>{titleize(d.status)}{d.totalSteps ? ` · ${d.approvedSteps ?? 0}/${d.totalSteps}` : ''}</span>
                    {/* Who this document is currently waiting on to approve. */}
                    {d.pendingWith && <div className="mt-0.5 text-[11px] text-amber-600">⏳ {d.pendingWith}{d.pendingWithRole ? ` · ${d.pendingWithRole}` : ''}</div>}
                  </td>
                  <td><DeliveryPill delivery={d.delivery} /></td>
                  <td className="px-2 text-right">
                    {isAdmin && (d.status === 'DRAFT' || d.status === 'ON_HOLD') && <button className="mr-3 text-xs font-medium text-rose-500 hover:underline" onClick={() => confirm(`Delete ${d.status === 'ON_HOLD' ? 'on-hold' : 'draft'} ${d.docNumber}? This can't be undone.`) && del.mutate(d.id)}>Delete</button>}
                    <button className="text-xs font-medium text-navy hover:underline" onClick={() => setOpenId(d.id)}>Open →</button>
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
