import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { EmptyState, Spinner } from '../ui';
import { fmtDate, fmtNum } from '../../lib/format';

export default function ApprovalQueue({ projectId, canApprove }: { projectId: string; canApprove: boolean }) {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['pending', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/progress/pending`)).data.entries as any[],
    enabled: canApprove,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['pending', projectId] });
    qc.invalidateQueries({ queryKey: ['boq', projectId] });
    qc.invalidateQueries({ queryKey: ['dashboard', projectId] });
    qc.invalidateQueries({ queryKey: ['history', projectId] });
  };

  const approve = useMutation({ mutationFn: (id: string) => api.post(`/projects/${projectId}/progress/${id}/approve`), onSuccess: invalidate, onError: (e) => alert(errMsg(e)) });
  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${projectId}/progress/${id}/reject`, { reason }),
    onSuccess: () => { setRejecting(null); setReason(''); invalidate(); },
    onError: (e) => alert(errMsg(e)),
  });

  if (!canApprove) return <div className="card p-6 text-sm text-slate-500">Only supervisors and admins can view the approval queue.</div>;
  if (isLoading) return <Spinner label="Loading approval queue…" />;
  if (error) return <div className="card p-6 text-red-600">Could not load the queue.</div>;
  if (!data?.length) return <EmptyState title="No pending entries" hint="All caught up — there are no progress entries awaiting approval." />;

  return (
    <div className="card divide-y divide-slate-100">
      {data.map((e) => (
        <div key={e.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-slate-800">{e.boqItem.description}</div>
              <div className="mt-0.5 text-sm text-slate-500">
                <span className="font-semibold text-navy">+{fmtNum(e.quantityInstalled)} {e.boqItem.unit}</span> · {fmtDate(e.date)} · by {e.submittedBy.name}
              </div>
              {e.remarks && <div className="mt-1 text-xs text-slate-400">“{e.remarks}”</div>}
              {e.photoUrl && <a href={e.photoUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-navy underline">View photo</a>}
            </div>
            <div className="flex gap-2">
              <button className="btn-outline" onClick={() => setRejecting(e.id)}>Reject</button>
              <button className="btn-primary" onClick={() => approve.mutate(e.id)} disabled={approve.isPending}>Approve</button>
            </div>
          </div>
          {rejecting === e.id && (
            <div className="mt-3 rounded-lg bg-slate-50 p-3">
              <label className="label">Reason for rejection</label>
              <div className="flex gap-2">
                <input className="input" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. quantity mismatch with site" />
                <button className="btn-danger whitespace-nowrap" onClick={() => reason && reject.mutate(e.id)} disabled={!reason || reject.isPending}>Confirm Reject</button>
                <button className="btn-outline" onClick={() => { setRejecting(null); setReason(''); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
