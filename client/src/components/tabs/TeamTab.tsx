import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Modal } from '../ui';

interface Member { id: string; role: string; user: { id: string; name: string; email: string; role: string } }
const ROLES = ['ENGINEER', 'SUPERVISOR', 'CLIENT', 'MANAGEMENT', 'ADMIN'];

const ROLE_PILL: Record<string, string> = {
  ADMIN: 'bg-purple-100 text-purple-700',
  ENGINEER: 'bg-blue-100 text-blue-700',
  SUPERVISOR: 'bg-teal-100 text-teal-700',
  CLIENT: 'bg-slate-100 text-slate-600',
  MANAGEMENT: 'bg-amber-100 text-amber-700',
};

export default function TeamTab({ projectId, members }: { projectId: string; role: string; members: Member[] }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const isAdmin = canEdit('team');
  const [show, setShow] = useState(false);

  const remove = useMutation({
    mutationFn: (userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-slate-600">Project Team ({members.length})</h2>
        {isAdmin && <button className="btn-primary" onClick={() => setShow(true)}>+ Invite Member</button>}
      </div>
      <div className="card divide-y divide-slate-100">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-navy text-sm font-semibold text-white">{m.user.name.slice(0, 1)}</div>
              <div>
                <div className="font-medium text-slate-800">{m.user.name}</div>
                <div className="text-xs text-slate-400">{m.user.email}</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className={`badge ${ROLE_PILL[m.role] || 'bg-slate-100'}`}>{m.role}</span>
              {isAdmin && <button className="text-xs text-slate-300 hover:text-red-500" onClick={() => remove.mutate(m.user.id)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      {show && <InviteModal projectId={projectId} onClose={() => setShow(false)} onDone={() => { setShow(false); qc.invalidateQueries({ queryKey: ['project', projectId] }); }} />}
    </div>
  );
}

function InviteModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('ENGINEER');
  const [err, setErr] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/members`, { email, role }),
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });
  return (
    <Modal title="Invite Member" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); m.mutate(); }} className="space-y-3">
        <p className="text-xs text-slate-500">The user must already have an account. Enter their email and assign a project role.</p>
        <div><label className="label">Email</label><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label className="label">Role</label><select className="input" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={m.isPending}>{m.isPending ? 'Adding…' : 'Add Member'}</button>
        </div>
      </form>
    </Modal>
  );
}
