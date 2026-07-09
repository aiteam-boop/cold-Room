// The sheet's `Milestones` tab — "kab kab humne committed kiya aur kab kab
// khatam hua hai".
//
// The FKI (freeze) column in the workbook holds text — "7th", "10th", "16th" —
// so its Delay formula (= Actual − Committed) ignores FKI entirely. Here it is a
// real date, and the delay also ticks live on an overdue-but-unfinished milestone
// instead of staying blank until someone fills in an actual date.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import { DelayCell, sheetDate } from './shared';

interface Milestone {
  id: string;
  name: string;
  committedDateVendor: string | null;
  fkiFreezeDate: string | null;
  actualDate: string | null;
  remarks: string | null;
  delayDays: number | null;
  isOverdue: boolean;
}

const isoDay = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export default function MilestonesTab({ projectId }: { projectId: string }) {
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const editable = canEdit('dpr');
  const [newName, setNewName] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['dpr-milestones', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/dpr/milestones`)).data as { milestones: Milestone[] },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['dpr-milestones'] });
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/projects/${projectId}/dpr/milestones/${id}`, body),
    onSuccess: invalidate,
  });
  const create = useMutation({
    mutationFn: async (name: string) => api.post(`/projects/${projectId}/dpr/milestones`, { name, sortOrder: (data?.milestones.length ?? 0) + 1 }),
    onSuccess: () => { setNewName(''); invalidate(); },
  });
  const del = useMutation({
    mutationFn: async (id: string) => api.delete(`/projects/${projectId}/dpr/milestones/${id}`),
    onSuccess: invalidate,
  });

  if (isLoading) return <Spinner label="Loading milestones…" />;
  const rows = data?.milestones ?? [];

  const dateCell = (m: Milestone, field: 'committedDateVendor' | 'fkiFreezeDate' | 'actualDate') =>
    editable ? (
      <input type="date" className="w-32 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs hover:border-slate-200 focus:border-navy focus:outline-none"
        value={isoDay(m[field])} onChange={(e) => patch.mutate({ id: m.id, body: { [field]: e.target.value || null } })} />
    ) : (
      <span className="text-slate-600">{sheetDate(m[field])}</span>
    );

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-navy">Key Milestone Dates</h2>

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-navy text-left text-xs uppercase tracking-wide text-white">
                <th className="px-3 py-2.5 font-semibold">Room / Milestone</th>
                <th className="px-3 py-2.5 font-semibold">Committed Date — Vendor</th>
                <th className="px-3 py-2.5 font-semibold">FKI (Freeze Date)</th>
                <th className="px-3 py-2.5 font-semibold">Actual Date</th>
                <th className="px-3 py-2.5 font-semibold">Delay (Days)</th>
                <th className="px-3 py-2.5 font-semibold">Remarks</th>
                {editable && <th className="px-3 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">No milestones yet.</td></tr>}
              {rows.map((m) => (
                <tr key={m.id} className={`border-b border-slate-100 last:border-0 ${m.isOverdue ? 'bg-red-50/40' : 'hover:bg-slate-50'}`}>
                  <td className="px-3 py-2 font-medium text-slate-700">{m.name}</td>
                  <td className="px-3 py-2">{dateCell(m, 'committedDateVendor')}</td>
                  <td className="px-3 py-2">{dateCell(m, 'fkiFreezeDate')}</td>
                  <td className="px-3 py-2">{dateCell(m, 'actualDate')}</td>
                  <td className="px-3 py-2">
                    <DelayCell days={m.delayDays} />
                    {m.isOverdue && <span className="ml-1.5 text-[10px] uppercase text-red-500">overdue</span>}
                  </td>
                  <td className="max-w-sm px-3 py-2 text-xs text-slate-500">{m.remarks || '—'}</td>
                  {editable && (
                    <td className="px-3 py-2 text-right">
                      <button className="text-xs text-red-500 hover:underline" onClick={() => confirm(`Delete "${m.name}"?`) && del.mutate(m.id)}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editable && (
          <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-2">
            <input className="input max-w-xs" placeholder="New milestone name…" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && newName.trim() && create.mutate(newName.trim())} />
            <button className="btn-secondary" disabled={!newName.trim() || create.isPending} onClick={() => create.mutate(newName.trim())}>
              Add milestone
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
