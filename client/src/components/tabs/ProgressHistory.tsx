import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { EmptyState, Spinner } from '../ui';
import { fmtDate, fmtNum } from '../../lib/format';

const STATUS_PILL: Record<string, string> = {
  APPROVED: 'bg-green-100 text-green-700',
  PENDING: 'bg-amber-100 text-amber-700',
  REJECTED: 'bg-red-100 text-red-700',
  VOIDED: 'bg-slate-200 text-slate-600',
};

export default function ProgressHistory({ projectId }: { projectId: string; isAdmin: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ['history', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/progress`)).data.entries as any[],
  });
  if (isLoading) return <Spinner label="Loading history…" />;
  if (!data?.length) return <EmptyState title="No progress entries yet" hint="Submitted progress entries will appear here as a chronological feed." />;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr><th className="px-4 py-2">Date</th><th>Activity</th><th className="text-right">Qty</th><th>By</th><th>Proof</th><th>Status</th></tr>
          </thead>
          <tbody>
            {data.map((e) => (
              <tr key={e.id} className="border-b border-slate-100">
                <td className="px-4 py-2 whitespace-nowrap text-slate-500">{fmtDate(e.date)}</td>
                <td className="py-2">
                  <div className="text-slate-700">{e.boqItem.description}</div>
                  {e.remarks && <div className="text-xs text-slate-400">“{e.remarks}”</div>}
                  {e.rejectionReason && <div className="text-xs text-red-500">Rejected: {e.rejectionReason}</div>}
                </td>
                <td className="text-right whitespace-nowrap font-medium text-navy">+{fmtNum(e.quantityInstalled)} {e.boqItem.unit}</td>
                <td className="text-slate-500">{e.submittedBy.name}</td>
                <td className="py-2"><Proof url={e.photoUrl} /></td>
                <td><span className={`badge ${STATUS_PILL[e.status] || 'bg-slate-100'}`}>{e.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Shows the uploaded proof for a progress entry. Images open in an in-page
// lightbox popup (not a new tab); other file types keep a direct link.
function Proof({ url }: { url?: string | null }) {
  const [open, setOpen] = useState(false);
  // Close the lightbox on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!url) return <span className="text-xs text-slate-300">—</span>;
  const isImg = /\.(png|jpe?g|gif|webp|bmp)$/i.test(url);
  if (!isImg) {
    return <a href={url} target="_blank" rel="noreferrer" title="Open file" className="text-xs font-medium text-navy hover:underline">📄 View file</a>;
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="View proof" className="inline-block">
        <img src={url} alt="proof" className="h-10 w-10 rounded border border-slate-200 object-cover hover:ring-2 hover:ring-navy" />
      </button>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
          <img src={url} alt="proof" className="max-h-[90vh] max-w-[90vw] rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/90 text-lg font-bold text-slate-700 shadow hover:bg-white"
            aria-label="Close"
          >✕</button>
        </div>
      )}
    </>
  );
}
