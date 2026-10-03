import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { Spinner } from '../components/ui';
import ApprovalMatrix from '../components/ApprovalMatrix';
import ApprovalChainConfig from '../components/ApprovalChainConfig';
import { SECTION_HINTS, APPROVAL_TYPE_LABELS, type PageKey, type SectionKey, type ApproverProfile } from '../lib/permissions';

interface Meta {
  roles: string[];
  roleLabels: Record<string, string>;
  projectRoles: string[];
  pages: { key: PageKey; label: string }[];
  sections: { key: SectionKey; label: string }[];
  approvalRoles: string[];
  approvalTypes: string[];
  projects: { id: string; name: string; clientName?: string }[];
}
interface UserRow {
  id: string; name: string; email: string; role: string; active: boolean;
  whatsapp: string;
  employeeCode: string;
  mLevel?: string;
  aadharNo?: string;
  aadharFileUrl?: string;
  pageAccess: Partial<Record<PageKey, { view: boolean; edit: boolean }>>;
  sectionPerms: Partial<Record<SectionKey, boolean>>;
  approver?: ApproverProfile;
  lastLoginAt?: string | null;
  lastLogoutAt?: string | null;
}

const fmtDateTime = (s: string) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
interface UserDetail extends UserRow { projects: { projectId: string; role: string }[] }

type ProjAccess = Record<string, { included: boolean; role: string }>;
interface Form {
  id?: string;
  name: string; email: string; password: string;
  role: string; active: boolean; whatsapp: string; employeeCode: string; mLevel: string;
  aadharNo: string; aadharFileUrl: string;
  grants: Partial<Record<PageKey, { view: boolean; edit: boolean }>>;
  sections: Partial<Record<SectionKey, boolean>>;
  projects: ProjAccess;
}

export default function UsersAdmin() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Form | null>(null);
  const [activityFor, setActivityFor] = useState<UserRow | null>(null);
  const [attendanceFor, setAttendanceFor] = useState<UserRow | null>(null);

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
      name: '', email: '', password: '', role: 'USER', active: true, whatsapp: '', employeeCode: '', mLevel: '',
      aadharNo: '', aadharFileUrl: '',
      grants: {}, sections: {}, projects: blankProjects(),
    });
  }

  async function openEdit(id: string) {
    const u = (await api.get(`/users/${id}`)).data.user as UserDetail;
    const projects = blankProjects();
    for (const p of u.projects) projects[p.projectId] = { included: true, role: p.role };
    setEditing({
      id: u.id, name: u.name, email: u.email, password: '', role: u.role, active: u.active,
      whatsapp: u.whatsapp || '', employeeCode: u.employeeCode || '', mLevel: u.mLevel || '',
      aadharNo: u.aadharNo || '', aadharFileUrl: u.aadharFileUrl || '',
      grants: u.pageAccess || {}, sections: u.sectionPerms || {}, projects,
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
        <div className="flex items-center gap-2">
          <SyncSheetsButton />
          <button className="btn-primary" onClick={openNew}>+ New user</button>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr><th className="px-4 py-2">Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th>Last logout</th><th className="text-right">Actions</th></tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 font-medium text-slate-800">{u.name}</td>
                <td className="text-slate-500">{u.email}</td>
                <td><span className={`badge ${u.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>{u.role}</span></td>
                <td>{u.active ? <span className="badge bg-green-100 text-green-700">Active</span> : <span className="badge bg-red-100 text-red-700">Disabled</span>}</td>
                {/* Stamped on every login; "—" means this account has never signed in. */}
                <td className="text-slate-500">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : <span className="text-slate-300">never</span>}</td>
                {/* Stamped when the user clicks Log out. */}
                <td className="text-slate-500">{u.lastLogoutAt ? fmtDateTime(u.lastLogoutAt) : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 text-right">
                  <div className="flex justify-end gap-3">
                    <button className="text-xs font-medium text-navy hover:underline" onClick={() => setActivityFor(u)}>Activity</button>
                    <button className="text-xs font-medium text-navy hover:underline" onClick={() => setAttendanceFor(u)}>Attendance</button>
                    <button className="text-xs font-medium text-navy hover:underline" onClick={() => openEdit(u.id)}>Edit →</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {activityFor && <ActivityModal user={activityFor} onClose={() => setActivityFor(null)} />}
      {attendanceFor && <AttendanceModal user={attendanceFor} onClose={() => setAttendanceFor(null)} />}

      <ApprovalPermissions users={users} meta={meta} onSaved={() => qc.invalidateQueries({ queryKey: ['users'] })} />

      {/* Who may approve is set above; at what value they must approve is set here. */}
      <ApprovalMatrix />
      {/* Fixed, user-based chain — sits directly below the value matrix. */}
      <ApprovalChainConfig />

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

// Manual "Sync now" — pushes the whole database to the Google Sheet on demand
// (live auto-sync also runs after every change).
function SyncSheetsButton() {
  const sync = useMutation({
    mutationFn: async () => (await api.post('/sync-sheets/sheets')).data as { total: number },
    onSuccess: (d) => alert(`Synced to Google Sheets — ${d.total} rows updated.`),
    onError: (e) => alert(errMsg(e)),
  });
  return (
    <button className="btn-outline" disabled={sync.isPending} onClick={() => sync.mutate()} title="Push all data to Google Sheets now">
      {sync.isPending ? 'Syncing…' : '⟳ Sync Sheets'}
    </button>
  );
}

// ── Approval Permissions ──────────────────────────────────────────────────────
// Designates which users are authorized approvers (the single source of truth
// for approval chains). Below the Users list per the spec.
const CUSTOM = '__custom__';

function ApprovalPermissions({ users, meta, onSaved }: { users: UserRow[]; meta: Meta; onSaved: () => void }) {
  return (
    <div className="card overflow-x-auto">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">Approval Permissions</h2>
        <p className="text-xs text-slate-500">Mark who can approve documents and what they can approve. These users become selectable when building an approval chain on a PO / WO / GRN.</p>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
          <tr><th className="px-4 py-2">User</th><th>Can approve</th><th>Approval role</th><th>Level</th><th>Types</th><th></th></tr>
        </thead>
        <tbody>
          {users.map((u) => <ApproverRow key={u.id} user={u} meta={meta} onSaved={onSaved} />)}
        </tbody>
      </table>
    </div>
  );
}

function ApproverRow({ user, meta, onSaved }: { user: UserRow; meta: Meta; onSaved: () => void }) {
  const base: ApproverProfile = user.approver ?? { canApprove: false, approvalRole: null, level: 1, types: [] };
  const [draft, setDraft] = useState<ApproverProfile>(base);
  const [savedMsg, setSavedMsg] = useState(false);
  const isAdmin = user.role === 'ADMIN';
  const presetMatch = draft.approvalRole && meta.approvalRoles.includes(draft.approvalRole);
  const roleSelectValue = draft.approvalRole == null ? '' : presetMatch ? draft.approvalRole : CUSTOM;

  const save = useMutation({
    mutationFn: () => api.patch(`/users/${user.id}`, { approver: draft }),
    onSuccess: () => { setSavedMsg(true); setTimeout(() => setSavedMsg(false), 1500); onSaved(); },
  });

  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const toggleType = (t: string) => {
    if (t === 'ALL') { setDraft({ ...draft, types: draft.types.includes('ALL') ? [] : ['ALL'] }); return; }
    const next = draft.types.filter((x) => x !== 'ALL');
    setDraft({ ...draft, types: next.includes(t as never) ? next.filter((x) => x !== t) : [...next, t as never] });
  };

  if (isAdmin) {
    return (
      <tr className="border-b border-slate-100">
        <td className="px-4 py-2"><div className="font-medium text-slate-800">{user.name}</div><div className="text-xs text-slate-400">{user.email}</div></td>
        <td colSpan={5} className="text-xs text-purple-600">Admins can approve anything — no explicit approver setup needed.</td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="px-4 py-2"><div className="font-medium text-slate-800">{user.name}</div><div className="text-xs text-slate-400">{user.email}</div></td>
      <td className="py-2"><input type="checkbox" checked={draft.canApprove} onChange={(e) => setDraft({ ...draft, canApprove: e.target.checked })} /></td>
      <td className="py-2 pr-2">
        {draft.canApprove ? (
          <div className="space-y-1">
            <select className="input text-xs" value={roleSelectValue}
              onChange={(e) => setDraft({ ...draft, approvalRole: e.target.value === CUSTOM ? '' : e.target.value || null })}>
              <option value="">—</option>
              {meta.approvalRoles.map((r) => <option key={r} value={r}>{r}</option>)}
              <option value={CUSTOM}>Custom…</option>
            </select>
            {roleSelectValue === CUSTOM && (
              <input className="input text-xs" placeholder="Custom role" value={draft.approvalRole ?? ''} onChange={(e) => setDraft({ ...draft, approvalRole: e.target.value })} />
            )}
          </div>
        ) : <span className="text-xs text-slate-300">—</span>}
      </td>
      <td className="py-2 pr-2">
        {draft.canApprove ? <input type="number" min={1} className="input w-16 text-xs" value={draft.level} onChange={(e) => setDraft({ ...draft, level: Number(e.target.value) || 1 })} /> : <span className="text-xs text-slate-300">—</span>}
      </td>
      <td className="py-2 pr-2">
        {draft.canApprove ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {(['ALL', ...meta.approvalTypes] as string[]).map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input type="checkbox" checked={draft.types.includes('ALL') ? t === 'ALL' : draft.types.includes(t as never)} onChange={() => toggleType(t)} />
                {APPROVAL_TYPE_LABELS[t] ?? t}
              </label>
            ))}
          </div>
        ) : <span className="text-xs text-slate-300">—</span>}
      </td>
      <td className="px-2 text-right">
        {savedMsg ? <span className="text-xs text-green-600">Saved ✓</span> : (
          <button className="text-xs font-medium text-navy hover:underline disabled:text-slate-300" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
        )}
      </td>
    </tr>
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
          role: form.role, active: form.active, whatsapp: form.whatsapp, employeeCode: form.employeeCode, mLevel: form.mLevel,
          aadharNo: form.aadharNo, aadharFileUrl: form.aadharFileUrl,
          pageAccess: form.grants, sectionPerms: form.sections, projects: includedProjects,
        });
      } else {
        await api.patch(`/users/${form.id}`, {
          name: form.name, role: form.role, active: form.active, whatsapp: form.whatsapp, employeeCode: form.employeeCode, mLevel: form.mLevel,
          aadharNo: form.aadharNo, aadharFileUrl: form.aadharFileUrl,
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
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(5,35,121,0.34)]" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-lg" onClick={(e) => e.stopPropagation()}>
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
            <div>
              <label className="label">Employee ID / Code (optional)</label>
              <input className="input" value={form.employeeCode} placeholder="e.g. 9035"
                onChange={(e) => onChange({ ...form, employeeCode: e.target.value })} />
              {/* External systems (e.g. the Spares portal) identify a person by this
                  code, so filling it lets them match this user's tasks over the API. */}
              <p className="mt-1 text-xs text-slate-400">The company employee code. Lets integrations match this person’s tasks via the API.</p>
            </div>
            <div><label className="label">WhatsApp number (optional)</label><input className="input" value={form.whatsapp} placeholder="e.g. 919812345678" onChange={(e) => onChange({ ...form, whatsapp: e.target.value })} /></div>
            <div>
              <label className="label">M-Level (optional)</label>
              <input className="input" value={form.mLevel} placeholder="e.g. M1, M2" onChange={(e) => onChange({ ...form, mLevel: e.target.value })} />
              {/* Auto-filled into the Travel module when this user is the traveller. */}
              <p className="mt-1 text-xs text-slate-400">Management level — shown automatically when this person is selected in Travel Planning.</p>
            </div>
            <div>
              <label className="label">Aadhaar number (optional)</label>
              <input className="input" value={form.aadharNo} placeholder="12-digit — or upload the card to auto-read" onChange={(e) => onChange({ ...form, aadharNo: e.target.value })} />
              <div className="mt-1 flex items-center gap-2">
                <label className="cursor-pointer rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-navy hover:bg-slate-50">
                  📎 {form.aadharFileUrl ? 'Replace Aadhaar card' : 'Upload Aadhaar card'}
                  <input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => {
                    const input = e.currentTarget; const f = input.files?.[0]; if (!f) return;
                    try {
                      const fd = new FormData(); fd.append('file', f);
                      const r = (await api.post('/users/aadhar-upload', fd)).data as { fileUrl: string; aadhaar?: string | null };
                      onChange({ ...form, aadharFileUrl: r.fileUrl, ...(r.aadhaar ? { aadharNo: r.aadhaar } : {}) });
                    } catch (err) { alert(errMsg(err)); }
                    finally { input.value = ''; }
                  }} />
                </label>
                {form.aadharFileUrl && <a href={form.aadharFileUrl} target="_blank" rel="noreferrer" className="text-xs text-navy hover:underline">View ✓</a>}
              </div>
              {/* Captured once here; auto-filled into Travel when this user is the traveller. */}
              <p className="mt-1 text-xs text-slate-400">Single-time capture — auto-fills into Travel Planning when this person is selected. Upload auto-reads the number.</p>
            </div>
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

// ── Per-user activity (admin) ────────────────────────────────────────────────
// "What has this person actually done?" — what they raised (POs/WOs/GRNs/payments),
// what they approved or rejected, and the full action trail from the audit log.
interface Activity {
  user: { id: string; name: string; email: string; role: string; lastLoginAt: string | null };
  summary: {
    lastLoginAt: string | null;
    lastLogoutAt: string | null;
    loginCount: number;
    totalActions: number;
    created: { PO: number; WO: number; GRN: number; PAYMENT: number; VENDOR: number; CHANGE_ORDER: number };
    approved: Record<string, number>;
    onHold: Record<string, number>;
    totalApproved: number;
    totalOnHold: number;
  };
  attendance: { loginAt: string; logoutAt: string | null; durationMs: number | null }[];
  actions: { id: string; action: string; entity: string | null; entityId: string | null; details: any; at: string; projectName: string | null }[];
}

// "2h 14m" style duration for an attendance session.
const fmtDuration = (ms: number | null) => {
  if (ms == null || ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};
const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
const fmtTime = (s: string) => new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// Audit actions are stored as CONSTANT_CASE — render them as readable English.
const prettyAction = (a: string) => a.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function Stat({ label, value, accent = 'text-navy' }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-semibold ${accent}`}>{value}</div>
    </div>
  );
}

function ActivityModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['user-activity', user.id],
    queryFn: async () => (await api.get(`/users/${user.id}/activity`)).data as Activity,
  });

  const byType = (m: Record<string, number>) =>
    Object.entries(m).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ') || '—';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(5,35,121,0.34)] p-6" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-lg bg-white shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-lg font-bold text-navy">Activity — {user.name}</h3>
            <p className="text-sm text-slate-500">{user.email}</p>
          </div>
          <button className="text-2xl leading-none text-slate-400 hover:text-slate-600" onClick={onClose}>×</button>
        </div>

        {isLoading && <div className="p-6"><Spinner label="Loading activity…" /></div>}
        {error && <div className="p-6 text-sm text-red-600">{errMsg(error)}</div>}

        {data && (
          <div className="space-y-4 p-5">
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Overview</div>
              <div className="grid gap-2 sm:grid-cols-4">
                <Stat label="Last login" value={data.summary.lastLoginAt ? fmtDateTime(data.summary.lastLoginAt) : 'never'} accent="text-slate-700" />
                <Stat label="Last logout" value={data.summary.lastLogoutAt ? fmtDateTime(data.summary.lastLogoutAt) : '—'} accent="text-slate-700" />
                <Stat label="Logins" value={data.summary.loginCount} accent="text-slate-700" />
                <Stat label="Approved" value={data.summary.totalApproved} accent="text-green-600" />
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Documents they raised</div>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="POs" value={data.summary.created.PO} />
                <Stat label="WOs" value={data.summary.created.WO} />
                <Stat label="GRNs" value={data.summary.created.GRN} />
                <Stat label="Payments" value={data.summary.created.PAYMENT} />
                <Stat label="Vendors" value={data.summary.created.VENDOR} />
                <Stat label="Change orders" value={data.summary.created.CHANGE_ORDER} />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-green-700">Approved by document type</div>
                <div className="text-sm text-green-900">{byType(data.summary.approved)}</div>
              </div>
              <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-orange-700">Put on hold by document type</div>
                <div className="text-sm text-orange-900">{byType(data.summary.onHold)}</div>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Attendance — login / logout sessions</div>
              {data.attendance.length === 0 ? (
                <div className="rounded-lg border border-slate-200 px-3 py-6 text-center text-sm text-slate-400">No login sessions recorded yet.</div>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-400">
                      <tr><th className="px-3 py-2">Date</th><th>Login</th><th>Logout</th><th>Duration</th></tr>
                    </thead>
                    <tbody>
                      {data.attendance.map((s, i) => (
                        <tr key={i} className="border-t border-slate-100">
                          <td className="px-3 py-2 text-slate-700">{fmtDate(s.loginAt)}</td>
                          <td className="text-green-700">{fmtTime(s.loginAt)}</td>
                          <td className={s.logoutAt ? 'text-slate-600' : 'text-amber-600'}>{s.logoutAt ? fmtTime(s.logoutAt) : 'still signed in / unknown'}</td>
                          <td className="text-slate-500">{fmtDuration(s.durationMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Action history — {data.summary.totalActions} total{data.summary.totalActions > data.actions.length ? `, showing the latest ${data.actions.length}` : ''}
              </div>
              {data.actions.length === 0 ? (
                <div className="rounded-lg border border-slate-200 px-3 py-6 text-center text-sm text-slate-400">No recorded activity yet.</div>
              ) : (
                <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase text-slate-400">
                      <tr><th className="px-3 py-2">When</th><th>Action</th><th>Entity</th><th>Project</th></tr>
                    </thead>
                    <tbody>
                      {data.actions.map((a) => (
                        <tr key={a.id} className="border-t border-slate-100">
                          <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{fmtDateTime(a.at)}</td>
                          <td className="font-medium text-slate-700">{prettyAction(a.action)}</td>
                          <td className="text-slate-500">{a.entity || '—'}</td>
                          <td className="text-slate-500">{a.projectName || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Per-user attendance calendar (admin) ─────────────────────────────────────
// A month grid built from the login/logout audit trail: each day shows the
// first login and the last logout, with Present / Late / Absent / Weekly-off.
interface AttendanceData {
  user: { id: string; name: string; email: string };
  month: string; // YYYY-MM
  today: string; // YYYY-MM-DD (India time)
  days: { date: string; login: string | null; logout: string | null }[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LATE_AFTER = '09:30'; // first login later than this HH:mm ⇒ marked late

function AttendanceModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month0, setMonth0] = useState(now.getMonth()); // 0-based
  const monthStr = `${year}-${String(month0 + 1).padStart(2, '0')}`;

  const { data, isLoading, error } = useQuery({
    queryKey: ['user-attendance', user.id, monthStr],
    queryFn: async () => (await api.get(`/users/${user.id}/attendance?month=${monthStr}`)).data as AttendanceData,
  });

  const step = (delta: number) => {
    const d = new Date(year, month0 + delta, 1);
    setYear(d.getFullYear());
    setMonth0(d.getMonth());
  };

  // Map YYYY-MM-DD → { login, logout } for quick per-cell lookup.
  const byDate: Record<string, { login: string | null; logout: string | null }> = {};
  (data?.days || []).forEach((d) => { byDate[d.date] = { login: d.login, logout: d.logout }; });
  const today = data?.today || '';

  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const firstWeekday = new Date(year, month0, 1).getDay(); // 0=Sun
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  // Present / Late / Absent / Weekly-off + a "no data yet" future state.
  function evaluate(day: number) {
    const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`;
    const weekday = new Date(year, month0, day).getDay();
    const rec = byDate[dateStr];
    const isFuture = !!today && dateStr > today;
    if (rec?.login) {
      const late = rec.login > LATE_AFTER;
      return { code: 'P' as const, late, login: rec.login, logout: rec.logout };
    }
    if (weekday === 0) return { code: 'WO' as const, late: false, login: null, logout: null }; // Sunday off
    if (isFuture) return { code: '' as const, late: false, login: null, logout: null };
    return { code: 'AB' as const, late: false, login: null, logout: null };
  }

  const Badge = ({ code, late }: { code: string; late: boolean }) => {
    if (!code) return null;
    const cls =
      code === 'P' ? 'bg-green-100 text-green-700' :
      code === 'AB' ? 'bg-red-100 text-red-700' :
      'bg-amber-100 text-amber-700'; // WO
    return (
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${cls}`}>
        {code}{code === 'P' && late ? ' LT' : ''}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(5,35,121,0.34)] p-6" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-lg bg-white shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-lg font-bold text-navy">Attendance — {user.name}</h3>
            <p className="text-sm text-slate-500">{user.email}</p>
          </div>
          <button className="text-2xl leading-none text-slate-400 hover:text-slate-600" onClick={onClose}>×</button>
        </div>

        <div className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button className="btn-outline px-2 py-1 text-sm" onClick={() => step(-1)}>←</button>
              <div className="min-w-[130px] text-center text-base font-semibold text-navy">{MONTH_NAMES[month0]} {year}</div>
              <button className="btn-outline px-2 py-1 text-sm" onClick={() => step(1)}>→</button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="flex items-center gap-1"><span className="rounded bg-green-100 px-1.5 py-0.5 font-bold text-green-700">P</span> Present</span>
              <span className="flex items-center gap-1"><span className="rounded bg-green-100 px-1.5 py-0.5 font-bold text-green-700">P LT</span> Late</span>
              <span className="flex items-center gap-1"><span className="rounded bg-red-100 px-1.5 py-0.5 font-bold text-red-700">AB</span> Absent</span>
              <span className="flex items-center gap-1"><span className="rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-700">WO</span> Week off</span>
            </div>
          </div>

          {isLoading && <div className="p-6"><Spinner label="Loading attendance…" /></div>}
          {error && <div className="p-6 text-sm text-red-600">{errMsg(error)}</div>}

          {data && (
            <div className="overflow-x-auto">
              <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-slate-200 text-sm">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="border-b border-slate-200 bg-slate-50 px-2 py-2 text-center text-xs font-semibold text-slate-500">{w}</div>
                ))}
                {cells.map((day, i) => {
                  if (day === null) return <div key={i} className="min-h-[74px] border-b border-r border-slate-100 bg-slate-50/40" />;
                  const e = evaluate(day);
                  const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`;
                  const isToday = dateStr === today;
                  return (
                    <div key={i} className={`min-h-[74px] border-b border-r border-slate-100 px-2 py-1.5 ${isToday ? 'bg-blue-50' : ''}`}>
                      <div className="flex items-start justify-between">
                        <span className="text-xs font-semibold text-slate-600">{String(day).padStart(2, '0')}</span>
                        <Badge code={e.code} late={e.late} />
                      </div>
                      {(e.code === 'P' || e.code === 'WO' || e.code === 'AB') && (
                        <div className={`mt-2 rounded px-1 py-0.5 text-center text-[11px] ${e.code === 'P' ? 'bg-sky-50 text-slate-600' : 'bg-slate-50 text-slate-400'}`}>
                          {e.login || '00:00'} - {e.logout || '00:00'}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-slate-400">
                Times are India time (IST). Login = first sign-in of the day, Logout = last sign-out. Logout is recorded only when the user clicks “Log out”.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
