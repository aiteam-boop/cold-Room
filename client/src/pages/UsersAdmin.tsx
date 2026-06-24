import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { Spinner } from '../components/ui';
import { SECTION_HINTS, type PageKey, type SectionKey } from '../lib/permissions';

interface Meta {
  roles: string[];
  roleLabels: Record<string, string>;
  projectRoles: string[];
  pages: { key: PageKey; label: string }[];
  sections: { key: SectionKey; label: string }[];
  projects: { id: string; name: string; clientName?: string }[];
}
interface UserRow {
  id: string; name: string; email: string; role: string; active: boolean;
  whatsapp: string;
  pageAccess: Partial<Record<PageKey, { view: boolean; edit: boolean }>>;
  sectionPerms: Partial<Record<SectionKey, boolean>>;
}
interface UserDetail extends UserRow { projects: { projectId: string; role: string }[] }

type ProjAccess = Record<string, { included: boolean; role: string }>;
interface Form {
  id?: string;
  name: string; email: string; password: string;
  role: string; active: boolean; whatsapp: string;
  grants: Partial<Record<PageKey, { view: boolean; edit: boolean }>>;
  sections: Partial<Record<SectionKey, boolean>>;
  projects: ProjAccess;
}

export default function UsersAdmin() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Form | null>(null);

  const metaQ = useQuery({ queryKey: ['users-meta'], queryFn: async () => (await api.get('/users/meta')).data as Meta });
  const usersQ = useQuery({ queryKey: ['users'], queryFn: async () => (await api.get('/users')).data.users as UserRow[] });

  if (metaQ.isLoading || usersQ.isLoading) return <Spinner label="Loading users…" />;
  const meta = metaQ.data!;
  const users = usersQ.data ?? [];
  const filtered = users.filter((u) => `${u.name} ${u.email} ${u.role}`.toLowerCase().includes(q.toLowerCase()));

  function blankProjects(): ProjAccess {
    return Object.fromEntries(meta.projects.map((p) => [p.id, { included: false, role: 'ENGINEER' }]));
  }

  function openNew() {
    setEditing({
      name: '', email: '', password: '', role: 'USER', active: true, whatsapp: '',
      grants: {}, sections: {}, projects: blankProjects(),
    });
  }

  async function openEdit(id: string) {
    const u = (await api.get(`/users/${id}`)).data.user as UserDetail;
    const projects = blankProjects();
    for (const p of u.projects) projects[p.projectId] = { included: true, role: p.role };
    setEditing({
      id: u.id, name: u.name, email: u.email, password: '', role: u.role, active: u.active,
      whatsapp: u.whatsapp || '', grants: u.pageAccess || {}, sections: u.sectionPerms || {}, projects,
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-navy">Settings · Users</h1>
        <p className="text-sm text-slate-500">Create accounts and choose which pages and data each user can see. Admins have full access to every page and project.</p>
      </div>

      <div className="flex items-center justify-between gap-2">
        <input className="input w-72" placeholder="Search users…" value={q} onChange={(e) => setQ(e.target.value)} type="search" name="user-search" autoComplete="off" />
        <button className="btn-primary" onClick={openNew}>+ New user</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr><th className="px-4 py-2">Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 font-medium text-slate-800">{u.name}</td>
                <td className="text-slate-500">{u.email}</td>
                <td><span className={`badge ${u.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>{u.role}</span></td>
                <td>{u.active ? <span className="badge bg-green-100 text-green-700">Active</span> : <span className="badge bg-red-100 text-red-700">Disabled</span>}</td>
                <td className="px-2 text-right"><button className="text-xs font-medium text-navy hover:underline" onClick={() => openEdit(u.id)}>Edit →</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <UserDrawer
          meta={meta}
          form={editing}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['users'] }); }}
        />
      )}
    </div>
  );
}

function UserDrawer({ meta, form, onChange, onClose, onSaved }: {
  meta: Meta; form: Form; onChange: (f: Form) => void; onClose: () => void; onSaved: () => void;
}) {
  const [err, setErr] = useState('');
  const isNew = !form.id;
  const isAdminRole = form.role === 'ADMIN';

  const grantedCount = useMemo(
    () => meta.pages.filter((p) => form.grants[p.key]?.view).length,
    [form.grants, meta.pages],
  );

  const save = useMutation({
    mutationFn: async () => {
      const includedProjects = Object.entries(form.projects)
        .filter(([, v]) => v.included)
        .map(([projectId, v]) => ({ projectId, role: v.role }));

      if (isNew) {
        await api.post('/users', {
          name: form.name, email: form.email, password: form.password,
          role: form.role, active: form.active, whatsapp: form.whatsapp,
          pageAccess: form.grants, sectionPerms: form.sections, projects: includedProjects,
        });
      } else {
        await api.patch(`/users/${form.id}`, {
          name: form.name, role: form.role, active: form.active, whatsapp: form.whatsapp,
          pageAccess: form.grants, sectionPerms: form.sections,
        });
        if (form.password) await api.post(`/users/${form.id}/password`, { password: form.password });
        await api.put(`/users/${form.id}/projects`, { projects: includedProjects });
      }
    },
    onSuccess: onSaved,
    onError: (e) => setErr(errMsg(e)),
  });

  const setGrant = (key: PageKey, patch: { view?: boolean; edit?: boolean }) => {
    const cur = form.grants[key] ?? { view: false, edit: false };
    const next = { ...cur, ...patch };
    if (!next.view) next.edit = false; // edit requires view
    onChange({ ...form, grants: { ...form.grants, [key]: next } });
  };
  const allSelected = grantedCount === meta.pages.length;
  const toggleAll = () => {
    const v = !allSelected;
    onChange({ ...form, grants: Object.fromEntries(meta.pages.map((p) => [p.key, { view: v, edit: v }])) });
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-bold text-navy">{isNew ? 'New user' : 'Edit user'}</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        <div className="space-y-5 p-5">
          {/* Identity. autoComplete is disabled so the browser doesn't drop the
              logged-in admin's saved email/password into the New-user form. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label">Name</label><input className="input" value={form.name} autoComplete="off" onChange={(e) => onChange({ ...form, name: e.target.value })} /></div>
            <div><label className="label">Email</label><input className="input" type="email" name="new-user-email" value={form.email} disabled={!isNew} autoComplete="off" onChange={(e) => onChange({ ...form, email: e.target.value })} /></div>
            <div>
              <label className="label">{isNew ? 'Password (min 8 chars)' : 'Reset password (optional)'}</label>
              <input className="input" type="password" name="new-user-password" value={form.password} placeholder={isNew ? '' : 'Leave blank to keep current'} autoComplete="new-password" onChange={(e) => onChange({ ...form, password: e.target.value })} />
            </div>
            <div>
              <label className="label">Role</label>
              <select className="input" value={form.role} onChange={(e) => onChange({ ...form, role: e.target.value })}>
                {meta.roles.map((r) => <option key={r} value={r}>{meta.roleLabels[r] ?? r}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2"><label className="label">WhatsApp number (optional)</label><input className="input" value={form.whatsapp} placeholder="e.g. 919812345678" onChange={(e) => onChange({ ...form, whatsapp: e.target.value })} /></div>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input type="checkbox" checked={form.active} onChange={(e) => onChange({ ...form, active: e.target.checked })} />
            Account active
          </label>

          {isAdminRole ? (
            <div className="rounded-lg bg-purple-50 px-3 py-3 text-sm text-purple-700">
              Admins always have full access to every page, section and project. Page &amp; section grants below don’t apply.
            </div>
          ) : (
            <>
              {/* Page access */}
              <div className="rounded-lg border border-slate-200 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-700">Page access</h3>
                  <button className="text-xs font-medium text-navy hover:underline" onClick={toggleAll}>{allSelected ? 'Clear all' : 'Select all'}</button>
                </div>
                <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1 text-sm">
                  <div></div>
                  <div className="text-center text-[10px] font-semibold uppercase text-slate-400">View</div>
                  <div className="text-center text-[10px] font-semibold uppercase text-slate-400">Edit</div>
                  {meta.pages.map((p) => {
                    const g = form.grants[p.key] ?? { view: false, edit: false };
                    return (
                      <div key={p.key} className="contents">
                        <div className="py-0.5 text-slate-600">{p.label}</div>
                        <div className="text-center"><input type="checkbox" checked={!!g.view} onChange={(e) => setGrant(p.key, { view: e.target.checked })} /></div>
                        <div className="text-center"><input type="checkbox" checked={!!g.edit} disabled={!g.view} onChange={(e) => setGrant(p.key, { edit: e.target.checked })} /></div>
                      </div>
                    );
                  })}
                </div>
                {grantedCount === 0 && <p className="mt-2 text-xs text-red-500">Nothing checked — this user will sign in but see no pages.</p>}
              </div>

              {/* Section permissions */}
              <div className="rounded-lg border border-slate-200 p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-700">Section permissions</h3>
                <div className="space-y-2">
                  {meta.sections.map((s) => (
                    <label key={s.key} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-0.5" checked={!!form.sections[s.key]} onChange={(e) => onChange({ ...form, sections: { ...form.sections, [s.key]: e.target.checked } })} />
                      <span>
                        <span className="font-medium text-slate-700">{s.label}</span>
                        <span className="block text-xs text-slate-400">{SECTION_HINTS[s.key]}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Project access (applies to USERs; admins see all anyway) */}
          {!isAdminRole && (
            <div className="rounded-lg border border-slate-200 p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-700">Project access</h3>
              {meta.projects.length === 0 ? (
                <p className="text-xs text-slate-400">No projects yet.</p>
              ) : (
                <div className="space-y-2">
                  {meta.projects.map((p) => {
                    const pa = form.projects[p.id] ?? { included: false, role: 'ENGINEER' };
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-2">
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={pa.included} onChange={(e) => onChange({ ...form, projects: { ...form.projects, [p.id]: { ...pa, included: e.target.checked } } })} />
                          <span className="text-slate-600">{p.name}</span>
                        </label>
                        <select className="rounded-lg border border-slate-300 px-2 py-1 text-xs" value={pa.role} disabled={!pa.included}
                          onChange={(e) => onChange({ ...form, projects: { ...form.projects, [p.id]: { ...pa, role: e.target.value } } })}>
                          {meta.projectRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
            <button className="btn-outline" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => { setErr(''); save.mutate(); }}>
              {save.isPending ? 'Saving…' : isNew ? 'Create user' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
