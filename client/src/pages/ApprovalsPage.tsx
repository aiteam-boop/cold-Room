import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Spinner } from '../components/ui';
import { fmtDate, inr } from '../lib/format';

interface Item {
  kind: 'PO' | 'WO' | 'GRN';
  docId: string; projectId: string; projectName?: string;
  number: string; vendorName?: string;
  basicAmount?: number | null; finalAmount?: number | null;
  submittedAt: string; myRole?: string | null; legacy?: boolean;
  invoiceNumber?: string | null; invoicePdfUrl?: string | null;
}

// "My Approvals" — documents where the signed-in user is the current approver.
// Fully actionable here so approvers never need access to the project workspace.
export default function ApprovalsPage() {
  const qc = useQueryClient();
  const { hideFinancials, isAdmin } = useAuth();
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));

  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals-mine'],
    queryFn: async () => (await api.get('/approvals/mine')).data.items as Item[],
    refetchInterval: 30_000,
  });

  const act = useMutation({
    mutationFn: async ({ item, verb, remarks }: { item: Item; verb: 'approve' | 'reject'; remarks?: string }) => {
      const seg = item.kind === 'GRN' ? 'grns' : 'docs';
      const body = verb === 'reject' ? { reason: remarks } : { remarks };
      return api.post(`/projects/${item.projectId}/procurement/${seg}/${item.docId}/${verb}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals-mine'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e) => alert(errMsg(e)),
  });

  const decide = (item: Item, verb: 'approve' | 'reject') => {
    const remarks = window.prompt(verb === 'reject' ? 'Rejection reason' : 'Remarks (optional)') ?? (verb === 'approve' ? '' : null);
    if (verb === 'reject' && !remarks) return;
    act.mutate({ item, verb, remarks: remarks ?? undefined });
  };

  if (isLoading) return <Spinner label="Loading approvals…" />;
  if (error) return <div className="card p-6 text-red-600">Could not load your approvals.</div>;
  const items = data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-navy">My Approvals</h1>
        <p className="text-sm text-slate-500">
          {isAdmin ? 'Every document currently awaiting approval, across all projects.' : 'Documents awaiting your approval. Approve or reject directly here.'}
        </p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="Nothing pending" hint="You have no documents waiting for your approval right now." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Document</th><th>Project</th><th>Vendor</th><th className="text-right">Amount</th><th>Submitted</th><th className="text-right">Action</th></tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={`${d.kind}-${d.docId}`} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <span className="font-medium text-navy">{d.number}</span> <span className="badge bg-slate-100 text-slate-600">{d.kind}</span>
                    {d.myRole && <div className="text-xs text-slate-400">as {d.myRole}</div>}
                    {d.legacy && <div className="text-xs text-slate-400">no chain — admin action</div>}
                    {d.invoicePdfUrl
                      ? <a href={d.invoicePdfUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-navy hover:underline">📄 View invoice{d.invoiceNumber ? ` (${d.invoiceNumber})` : ''}</a>
                      : d.kind === 'GRN' && <span className="text-xs text-slate-400">no invoice file</span>}
                  </td>
                  <td className="text-slate-600">{d.projectName}</td>
                  <td className="text-slate-600">{d.vendorName || '—'}</td>
                  <td className="text-right font-medium">{money(d.finalAmount)}</td>
                  <td className="text-slate-500">{fmtDate(d.submittedAt)}</td>
                  <td className="px-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button className="rounded-lg bg-navy px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={act.isPending} onClick={() => decide(d, 'approve')}>✓ Approve</button>
                      <button className="rounded-lg bg-red-500 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={act.isPending} onClick={() => decide(d, 'reject')}>Reject</button>
                    </div>
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
