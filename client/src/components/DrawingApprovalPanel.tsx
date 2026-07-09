import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Spinner } from './ui';
import { fmtDate } from '../lib/format';

// The project's start-date anchor (Sprint PRD §2). The project has not
// officially started until all four drawings are ticked — the Gantt delay clock
// is meaningless before that, so this panel sits above the chart.

export interface DrawingApprovalItem {
  id: string;
  type: string;
  name: string;
  tatDays: number;
  drawingReceivedDate: string | null;
  plannedDate: string | null;
  effectivePlannedDate: string | null;
  actualDate: string | null;
  responsibleUserId: string | null;
  responsibleName: string;
  documentUrl: string | null;
  status: 'PENDING' | 'IN_REVIEW' | 'APPROVED';
  delayDays: number;
}

export interface DrawingApprovalData {
  items: DrawingApprovalItem[];
  total: number;
  approved: number;
  allApproved: boolean;
  officialStartDate: string | null;
  worstDelayDays: number;
  label: string;
  orderReceiveDate: string | null;
  advanceReceiveDate: string | null;
}

const STATUS_PILL: Record<string, string> = {
  APPROVED: 'bg-green-100 text-green-700',
  IN_REVIEW: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-slate-100 text-slate-600',
};
const STATUS_LABEL: Record<string, string> = { APPROVED: 'Approved', IN_REVIEW: 'In Review', PENDING: 'Pending' };

/** Compact banner — the always-visible summary line. Safe to render anywhere. */
export function DrawingApprovalBanner({ data, onOpen }: { data: DrawingApprovalData; onOpen?: () => void }) {
  const ok = data.allApproved;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm ${ok ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
      <span className="font-medium">
        {ok ? `Project Start: ${fmtDate(data.officialStartDate)}` : data.label}
        {!ok && data.worstDelayDays > 0 && (
          <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-700">
            Drawing Approval — {data.worstDelayDays} day{data.worstDelayDays > 1 ? 's' : ''} delayed
          </span>
        )}
      </span>
      {onOpen && <button className="text-xs font-semibold underline" onClick={onOpen}>{ok ? 'View checklist' : 'Complete checklist →'}</button>}
    </div>
  );
}

export default function DrawingApprovalPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canManage = canEdit('gantt');
  const [rows, setRows] = useState<DrawingApprovalItem[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['drawing-approvals', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/drawing-approvals`)).data as DrawingApprovalData,
  });
  // Project members feed the "Responsible person" dropdown; free text stays available.
  const projectQ = useQuery({ queryKey: ['project', projectId], queryFn: async () => (await api.get(`/projects/${projectId}`)).data });
  const members: { user: { id: string; name: string } }[] = projectQ.data?.project?.members ?? [];

  useEffect(() => { if (data) setRows(structuredClone(data.items)); }, [data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['drawing-approvals', projectId] });
    // The anchor moves the Gantt's day 0 and the project header's start date.
    qc.invalidateQueries({ queryKey: ['gantt', projectId] });
    qc.invalidateQueries({ queryKey: ['project', projectId] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const save = useMutation({
    mutationFn: async () => (await api.put(`/projects/${projectId}/drawing-approvals`, { items: rows })).data as DrawingApprovalData,
    onSuccess: (d) => { setRows(structuredClone(d.items)); setMsg({ ok: true, t: d.allApproved ? `Saved. Project start date set to ${fmtDate(d.officialStartDate)}.` : 'Saved.' }); invalidate(); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });
  const reset = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/drawing-approvals/reset`)).data as DrawingApprovalData,
    onSuccess: (d) => { setRows(structuredClone(d.items)); setMsg({ ok: true, t: 'Checklist reset to the 4 standard drawings.' }); invalidate(); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });
  const upload = useMutation({
    mutationFn: async (v: { itemId: string; file: File }) => {
      const fd = new FormData();
      fd.append('file', v.file);
      return (await api.post(`/projects/${projectId}/drawing-approvals/${v.itemId}/document`, fd)).data as DrawingApprovalData;
    },
    onSuccess: (d) => { setRows(structuredClone(d.items)); setMsg({ ok: true, t: 'Drawing attached.' }); invalidate(); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });
  const dates = useMutation({
    mutationFn: (patch: Record<string, string | null>) => api.patch(`/projects/${projectId}`, patch),
    onSuccess: () => { setMsg({ ok: true, t: 'Saved.' }); invalidate(); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  if (isLoading || !data || !rows) return <Spinner label="Loading drawing approvals…" />;

  const set = (i: number, patch: Partial<DrawingApprovalItem>) =>
    setRows((r) => r!.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  // Ticking "Approved" without a date is meaningless — default it to today.
  const setStatus = (i: number, status: DrawingApprovalItem['status']) => {
    const today = new Date().toISOString().slice(0, 10);
    set(i, status === 'APPROVED'
      ? { status, actualDate: rows[i].actualDate || today }
      : { status, actualDate: null });
  };

  // crypto.randomUUID, not Date.now() — two rows added in the same millisecond
  // would otherwise share an id, and document uploads target rows by id.
  const addRow = () => setRows((r) => [...r!, {
    id: crypto.randomUUID(), type: 'CUSTOM', name: 'Civil Drawing', tatDays: 4,
    drawingReceivedDate: null, plannedDate: null, effectivePlannedDate: null, actualDate: null,
    responsibleUserId: null, responsibleName: 'Amisha', documentUrl: null, status: 'PENDING', delayDays: 0,
  }]);

  const approvedCount = rows.filter((r) => r.status === 'APPROVED').length;
  const dirty = JSON.stringify(rows) !== JSON.stringify(data.items);

  return (
    <div className="card space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-700">Drawing Approval — project start anchor</h3>
          <p className="text-xs text-slate-400">The project officially starts on the date the last drawing is approved. Gantt day 0 follows this date.</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button className="btn-outline text-xs" disabled={reset.isPending} onClick={() => { if (confirm('Reset to the 4 standard drawings? Custom drawings and their dates will be discarded.')) reset.mutate(); }}>Reset</button>
            <button className="btn-primary text-sm" disabled={!dirty || save.isPending} onClick={() => { setMsg(null); save.mutate(); }}>{save.isPending ? 'Saving…' : 'Save Checklist'}</button>
          </div>
        )}
      </div>

      <DrawingApprovalBanner data={{ ...data, approved: approvedCount, allApproved: approvedCount === rows.length && rows.length > 0 }} />
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.t}</div>}

      {/* The other two start-date parameters. Recorded, but they never start the clock. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Order Receive Date</label>
          <input className="input" type="date" disabled={!canManage} defaultValue={data.orderReceiveDate?.slice(0, 10) ?? ''}
            onBlur={(e) => dates.mutate({ orderReceiveDate: e.target.value || null })} />
          <p className="mt-0.5 text-[11px] text-slate-400">When the order / LOI was received from the client.</p>
        </div>
        <div>
          <label className="label">Advance Payment Received</label>
          <input className="input" type="date" disabled={!canManage} defaultValue={data.advanceReceiveDate?.slice(0, 10) ?? ''}
            onBlur={(e) => dates.mutate({ advanceReceiveDate: e.target.value || null })} />
          <p className="mt-0.5 text-[11px] text-slate-400">Even with the advance paid, the project stays in “pending start” until all drawings are approved.</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        {/* min-width must exceed the sum of the fixed column widths (≈1120px),
            otherwise the only flexible column — Drawing — collapses to nothing. */}
        <table className="w-full min-w-[1180px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="px-2 py-2 w-64">Drawing</th>
              <th className="px-2 py-2 w-24">TAT (days)</th>
              <th className="px-2 py-2 w-36">Drawing Received</th>
              <th className="px-2 py-2 w-36">Planned Approval</th>
              <th className="px-2 py-2 w-36">Actual Approval</th>
              <th className="px-2 py-2 w-40">Responsible</th>
              <th className="px-2 py-2 w-32">Status</th>
              <th className="px-2 py-2 w-32">Document</th>
              {canManage && <th className="w-8" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-b border-slate-100 align-top">
                <td className="px-2 py-2">
                  {/* Every drawing can be renamed, standard ones included — a project
                      may call it "Panel GA Drawing" rather than "PUF Panel Drawing".
                      `type` (not the name) is what marks the 4 standard rows. */}
                  <input className="input" disabled={!canManage} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
                  <div className="mt-0.5 flex items-center gap-1 text-[11px]">
                    {r.type !== 'CUSTOM' && <span className="text-slate-400">standard</span>}
                    {r.delayDays > 0 && <span className="font-semibold text-red-600">· {r.delayDays} day{r.delayDays > 1 ? 's' : ''} delayed</span>}
                  </div>
                </td>
                <td className="px-2 py-2"><input className="input" type="number" min={1} disabled={!canManage} value={r.tatDays} onChange={(e) => set(i, { tatDays: Number(e.target.value) || 1 })} /></td>
                <td className="px-2 py-2"><input className="input" type="date" disabled={!canManage} value={r.drawingReceivedDate ?? ''} onChange={(e) => set(i, { drawingReceivedDate: e.target.value || null })} /></td>
                <td className="px-2 py-2">
                  <input className="input" type="date" disabled={!canManage} value={r.plannedDate ?? ''} placeholder={r.effectivePlannedDate ?? ''} onChange={(e) => set(i, { plannedDate: e.target.value || null })} />
                  {!r.plannedDate && r.effectivePlannedDate && <div className="mt-0.5 text-[11px] text-slate-400">auto: {fmtDate(r.effectivePlannedDate)} ({r.tatDays} working days)</div>}
                </td>
                <td className="px-2 py-2">
                  <input className="input" type="date" disabled={!canManage} value={r.actualDate ?? ''}
                    onChange={(e) => set(i, { actualDate: e.target.value || null, status: e.target.value ? 'APPROVED' : 'PENDING' })} />
                </td>
                <td className="px-2 py-2">
                  <select className="input" disabled={!canManage} value={r.responsibleUserId ?? ''} onChange={(e) => set(i, { responsibleUserId: e.target.value || null })}>
                    <option value="">{r.responsibleName || 'Amisha'} (default)</option>
                    {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
                  </select>
                </td>
                <td className="px-2 py-2">
                  <select className={`input ${STATUS_PILL[r.status]}`} disabled={!canManage} value={r.status} onChange={(e) => setStatus(i, e.target.value as DrawingApprovalItem['status'])}>
                    {(['PENDING', 'IN_REVIEW', 'APPROVED'] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </td>
                <td className="px-2 py-2">
                  {r.documentUrl
                    ? <a className="text-xs font-medium text-navy hover:underline" href={r.documentUrl} target="_blank" rel="noreferrer">📄 View PDF</a>
                    : <span className="text-xs text-slate-400">—</span>}
                  {canManage && (
                    <input className="input mt-1 text-[11px]" type="file" accept="application/pdf" disabled={dirty || upload.isPending}
                      title={dirty ? 'Save the checklist before attaching drawings' : 'Attach the final approved drawing (PDF)'}
                      onChange={(e) => e.target.files?.[0] && upload.mutate({ itemId: r.id, file: e.target.files[0] })} />
                  )}
                </td>
                {canManage && (
                  <td className="px-2 py-2">
                    {/* Only admin-added drawings can be removed; the 4 standard ones are fixed. */}
                    {r.type === 'CUSTOM' && <button className="text-slate-300 hover:text-red-500" onClick={() => setRows((x) => x!.filter((_, idx) => idx !== i))}>✕</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="flex items-center justify-between">
          <button className="btn-outline text-xs" onClick={addRow}>+ Add Drawing</button>
          {dirty && <span className="text-xs text-amber-600">Unsaved changes — attach documents after saving.</span>}
        </div>
      )}
    </div>
  );
}
