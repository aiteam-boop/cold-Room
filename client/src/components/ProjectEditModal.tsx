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

export interface EditableProject {
  id: string;
  name: string;
  clientName?: string | null;
  siteLocation?: string | null;
  clientPoNumber?: string | null;
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
    clientPoNumber: project.clientPoNumber ?? '',
    startDate: day(project.startDate),
    targetCompletionDate: day(project.targetCompletionDate),
    status: project.status ?? 'ACTIVE',
  });
  const [err, setErr] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      // Send every field so a cleared box actually clears the value.
      const payload = {
        name: form.name.trim(),
        clientName: form.clientName.trim() || null,
        siteLocation: form.siteLocation.trim() || null,
        clientPoNumber: form.clientPoNumber.trim() || null,
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
          <div><label className="label">Client PO Number</label><input className="input" value={form.clientPoNumber} onChange={set('clientPoNumber')} placeholder="Client's PO (shown on packing list)" /></div>
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
