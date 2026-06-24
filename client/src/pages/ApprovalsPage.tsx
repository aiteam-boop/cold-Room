import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Spinner } from '../components/ui';
import { fmtDate, inr } from '../lib/format';

// Global approval queue — every PO/WO pending approval across all projects.
export default function ApprovalsPage() {
  const { hideFinancials } = useAuth();
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals-pending'],
    queryFn: async () => (await api.get('/approvals/pending')).data.docs as any[],
    refetchInterval: 30_000,
  });

  if (isLoading) return <Spinner label="Loading approvals…" />;
  if (error) return <div className="card p-6 text-red-600">You don't have access to the approval queue.</div>;
  const docs = data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-navy">Approval Queue</h1>
        <p className="text-sm text-slate-500">Purchase &amp; Work Orders awaiting your approval, across all projects.</p>
      </div>
      {docs.length === 0 ? (
        <EmptyState title="Nothing pending" hint="All Purchase Orders and Work Orders are up to date — no approvals waiting." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Document</th><th>Project</th><th>Vendor</th><th className="text-right">Basic</th><th className="text-right">Final</th><th>Submitted by</th><th></th></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2"><span className="font-medium text-navy">{d.docNumber}</span> <span className="badge bg-slate-100 text-slate-600">{d.type}</span></td>
                  <td className="text-slate-600">{d.projectName}</td>
                  <td className="text-slate-600">{d.vendorName || '—'}</td>
                  <td className="text-right">{money(d.basicAmount)}</td>
                  <td className="text-right font-medium">{money(d.finalAmount)}</td>
                  <td className="text-slate-500">{d.createdBy || '—'}<div className="text-xs text-slate-400">{fmtDate(d.submittedAt)}</div></td>
                  <td className="px-2 text-right"><Link to={`/projects/${d.projectId}`} className="text-xs font-medium text-navy hover:underline">Open & review →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-400">Open a document to review every field and Approve (applies e-sign) or Reject with a comment.</p>
    </div>
  );
}
