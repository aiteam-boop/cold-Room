// Edit a project's core details — name, client, site, start date, target date,
// status. Reachable from the project card and the workspace header, so any field
// left blank at creation can be filled in later with a click.
//
// PATCH /api/projects/:id is gated on the project ADMIN role, so this is only
// rendered for users who can actually save.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { Modal } from './ui';

export interface ClientPo { number: string; proofUrl?: string | null }
export interface EditableProject {
  id: string;
  name: string;
  clientName?: string | null;
  siteLocation?: string | null;
  clientPoNumber?: string | null;
  clientPos?: ClientPo[] | null;
  startDate?: string | null;
  targetCompletionDate?: string | null;
  status?: string;
}

const STATUSES = ['DRAFT', 'ACTIVE', 'ON_HOLD', 'COMPLETED'] as const;
const day = (d?: string | null) => (d ? String(d).slice(0, 10) : '');

export default function ProjectEditModal({ project, onClose, onSaved }: {
  project: EditableProject;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: project.name ?? '',
    clientName: project.clientName ?? '',
    siteLocation: project.siteLocation ?? '',
    startDate: day(project.startDate),
    targetCompletionDate: day(project.targetCompletionDate),
    status: project.status ?? 'ACTIVE',
  });
  // Multiple client PO numbers (each with an optional uploaded proof). Seeded from the
  // new `clientPos`, else the legacy single `clientPoNumber`, else one blank row.
  const [pos, setPos] = useState<ClientPo[]>(() => {
    const arr = Array.isArray(project.clientPos) ? project.clientPos : null;
    if (arr && arr.length) return arr.map((p) => ({ number: p.number || '', proofUrl: p.proofUrl || null }));
    if (project.clientPoNumber) return [{ number: project.clientPoNumber, proofUrl: null }];
    return [{ number: '', proofUrl: null }];
  });
  const [uploading, setUploading] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const setPo = (i: number, patch: Partial<ClientPo>) => setPos((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const addPo = () => setPos((prev) => [...prev, { number: '', proofUrl: null }]);
  const delPo = (i: number) => setPos((prev) => prev.filter((_, j) => j !== i));
  const uploadProof = async (i: number, file: File) => {
    setUploading(i);
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await api.post(`/projects/${project.id}/client-po-proof`, fd);
      setPo(i, { proofUrl: res.data?.fileUrl || null });
    } catch (e) { setErr(errMsg(e)); } finally { setUploading(null); }
  };

  const save = useMutation({
    mutationFn: async () => {
      // Send every field so a cleared box actually clears the value.
      const payload = {
        name: form.name.trim(),
        clientName: form.clientName.trim() || null,
        siteLocation: form.siteLocation.trim() || null,
        clientPos: pos.filter((p) => p.number.trim()).map((p) => ({ number: p.number.trim(), proofUrl: p.proofUrl || null })),
        startDate: form.startDate || null,
        targetCompletionDate: form.targetCompletionDate || null,
        status: form.status,
      };
      return (await api.patch(`/projects/${project.id}`, payload)).data;
    },
    onSuccess: () => {
      // Refresh both the list cards and the open workspace header.
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project', project.id] });
      onSaved?.();
      onClose();
    },
    onError: (e) => setErr(errMsg(e)),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <Modal title="Edit project" onClose={onClose}>
      <div className="space-y-3">
        {err && <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}

        <div>
          <label className="label">Project name *</label>
          <input className="input" value={form.name} onChange={set('name')} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Client name</label><input className="input" value={form.clientName} onChange={set('clientName')} placeholder="Not set" /></div>
          <div><label className="label">Site location</label><input className="input" value={form.siteLocation} onChange={set('siteLocation')} placeholder="Not set" /></div>
        </div>

        {/* Client PO number(s) — a project may have several; each can carry a proof.
            Shown on the packing list; a GRN picks WHICH one in its "Against" section. */}
        <div>
          <label className="label">Client PO Number(s) <span className="text-[10px] font-normal text-slate-400">shown on the packing list · pick per-GRN when there are several</span></label>
          <div className="space-y-2">
            {pos.map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input className="input min-w-[160px] flex-1" value={p.number} onChange={(e) => setPo(i, { number: e.target.value })} placeholder="Client's PO number" />
                {p.proofUrl && <a href={p.proofUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-navy hover:underline">📄 Proof</a>}
                <label className="cursor-pointer text-xs font-medium text-navy hover:underline">
                  {uploading === i ? 'Uploading…' : p.proofUrl ? 'Replace' : '⬆ Upload proof'}
                  <input type="file" className="hidden" accept="application/pdf,.pdf,image/*" disabled={uploading === i} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadProof(i, f); e.currentTarget.value = ''; }} />
                </label>
                {pos.length > 1 && <button type="button" className="text-rose-400 hover:text-rose-600" onClick={() => delPo(i)} title="Remove">✕</button>}
              </div>
            ))}
          </div>
          <button type="button" className="mt-1.5 text-xs font-medium text-navy hover:underline" onClick={addPo}>+ Add PO number</button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Start date</label><input className="input" type="date" value={form.startDate} onChange={set('startDate')} /></div>
          <div><label className="label">Target completion</label><input className="input" type="date" value={form.targetCompletionDate} onChange={set('targetCompletionDate')} /></div>
        </div>

        <div>
          <label className="label">Status</label>
          <select className="input" value={form.status} onChange={set('status')}>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!form.name.trim() || save.isPending} onClick={() => { setErr(''); save.mutate(); }}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
