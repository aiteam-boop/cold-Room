import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { Spinner } from '../components/ui';

// ── Types ─────────────────────────────────────────────────────────────────────
interface RealmDef { key: string; label: string; desc: string; requiresScope?: string }
interface ScopeDef { key: string; label: string; desc: string; always?: boolean }
interface Meta { realms: RealmDef[]; scopes: ScopeDef[] }

interface Flag { code: string; severity: 'high' | 'medium'; detail: string }
interface KeyRow {
  id: string; name: string; prefix: string; mode: string;
  realms: string[]; scopes: string[]; rateLimitPerMin: number; ipAllowlist: string[];
  expiresAt: string | null; active: boolean; revokedAt: string | null; revokedByName: string | null; rotatedAt: string | null;
  callCount: number; createdAt: string; lastUsedAt: string | null;
  createdByName: string | null; flags: Flag[];
  status: 'active' | 'revoked' | 'expired';
}
interface Summary { total: number; active: number; revoked: number; callsServed: number; flagged: number }

const fmt = (s: string | null) =>
  s ? new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'Never';
const fmtDay = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

const REALM_COLOR: Record<string, string> = {
  projects: 'bg-blue-100 text-blue-700', procurement: 'bg-indigo-100 text-indigo-700',
  timeline: 'bg-teal-100 text-teal-700', finance: 'bg-amber-100 text-amber-700', vendors: 'bg-rose-100 text-rose-700',
  approvals: 'bg-orange-100 text-orange-700', travel: 'bg-emerald-100 text-emerald-700',
};
const scopeColor = (s: string) => (s === 'read:core' ? 'bg-slate-100 text-slate-600' : 'bg-violet-100 text-violet-700');

// ── One-time key reveal banner ────────────────────────────────────────────────
function Reveal({ created, onClose }: { created: { name: string; key: string; rotated?: boolean }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card border-2 border-green-300 bg-green-50 p-4">
      <div className="text-sm font-semibold text-green-800">
        Key “{created.name}” {created.rotated ? 'rotated' : 'created'} — copy it now.
      </div>
      <div className="mt-1 text-xs text-green-700">This is the only time the full key is shown. Store it safely; you can’t see it again.</div>
      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-lg border border-green-300 bg-white px-3 py-2 font-mono text-sm text-navy">{created.key}</code>
        <button className="btn-primary shrink-0" onClick={() => { navigator.clipboard?.writeText(created.key); setCopied(true); }}>{copied ? 'Copied ✓' : 'Copy'}</button>
        <button className="btn-outline shrink-0" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, tone }: { label: string; value: number; sub: string; tone: string }) {
  return (
    <div className={`rounded-lg border p-4 ${tone}`}>
      <div className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
      <div className="mt-0.5 text-xs opacity-60">{sub}</div>
    </div>
  );
}

// One labelled field in the expanded row detail.
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 text-slate-600">{value}</div>
    </div>
  );
}

export default function ApiKeysAdmin() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string; rotated?: boolean } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [usageFor, setUsageFor] = useState<KeyRow | null>(null);
  const [editFor, setEditFor] = useState<KeyRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const metaQ = useQuery({ queryKey: ['api-keys-meta'], queryFn: async () => (await api.get('/api-keys/meta')).data as Meta });
  const listQ = useQuery({ queryKey: ['api-keys'], queryFn: async () => (await api.get('/api-keys')).data as { keys: KeyRow[]; summary: Summary } });

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api-keys/${id}/revoke`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }), onError: (e) => alert(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api-keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }), onError: (e) => alert(errMsg(e)),
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api.post(`/api-keys/${id}/rotate`),
    onSuccess: (r) => { setCreated({ name: r.data.name, key: r.data.key, rotated: true }); qc.invalidateQueries({ queryKey: ['api-keys'] }); },
    onError: (e) => alert(errMsg(e)),
  });

  if (metaQ.isLoading || listQ.isLoading) return <Spinner label="Loading API keys…" />;
  const meta = metaQ.data!;
  const keys = listQ.data?.keys ?? [];
  const summary = listQ.data?.summary ?? { total: 0, active: 0, revoked: 0, callsServed: 0, flagged: 0 };

  const filtered = keys.filter((k) =>
    `${k.name} ${k.prefix} ${k.realms.join(' ')} ${k.scopes.join(' ')} ${k.mode}`.toLowerCase().includes(q.toLowerCase()));

  function exportCsv() {
    const head = ['Name', 'Key', 'Mode', 'Realms', 'Scopes', 'Rate/min', 'Status', 'Calls', 'Last used', 'Expires', 'Created'];
    const lines = filtered.map((k) => [
      k.name, k.prefix, k.mode, k.realms.join('|'), k.scopes.join('|'), k.rateLimitPerMin, k.status, k.callCount,
      fmt(k.lastUsedAt), k.expiresAt ? fmtDay(k.expiresAt) : 'Never', fmt(k.createdAt),
    ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const u = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = u; a.download = 'crmcts-api-keys.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-navy">API Keys</h1>
          <p className="text-sm text-slate-500">Who can read our data through the public API, and what they may see.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/integration-kit" className="btn-outline">📖 Integration Kit</Link>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>+ Create key</button>
        </div>
      </div>

      {created && <Reveal created={created} onClose={() => setCreated(null)} />}

      {/* Stat cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Keys" value={summary.total} sub="Every key ever minted" tone="border-blue-200 bg-blue-50 text-blue-800" />
        <Stat label="Active" value={summary.active} sub="Working right now" tone="border-emerald-200 bg-emerald-50 text-emerald-800" />
        <Stat label="Revoked / expired" value={summary.revoked} sub="Cannot authenticate" tone="border-rose-200 bg-rose-50 text-rose-800" />
        <Stat label="Calls served" value={summary.callsServed} sub="Lifetime, across all keys" tone="border-violet-200 bg-violet-50 text-violet-800" />
        <Stat label="Flagged" value={summary.flagged} sub="Anomaly in last 24h" tone={summary.flagged ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-500'} />
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-navy">Keys</span>
            <span className="text-xs text-slate-400">Only a SHA-256 hash is stored 🔒</span>
          </div>
          <div className="flex items-center gap-2">
            <input className="input h-8 w-56 text-sm" placeholder="Search name, prefix, realm…" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="text-xs text-slate-400">{filtered.length} rows</span>
            <button className="btn-outline h-8 px-2 text-xs" onClick={exportCsv}>↓ Export</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="w-8 px-2 py-2" />
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Key</th>
                <th className="px-3 py-2 font-semibold">Realms</th>
                <th className="px-3 py-2 font-semibold">Scopes</th>
                <th className="px-3 py-2 text-right font-semibold">Rate/min</th>
                <th className="px-3 py-2 font-semibold">Last used</th>
                <th className="px-3 py-2 text-right font-semibold">Calls</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-400">No API keys. Create one to get started.</td></tr>
              )}
              {filtered.map((k) => (
                <Fragment key={k.id}>
                <tr className={`border-t border-slate-100 align-top ${expanded === k.id ? 'bg-navy/5' : ''}`}>
                  <td className="px-2 py-2">
                    <button className="grid h-5 w-5 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-navy"
                      onClick={() => setExpanded(expanded === k.id ? null : k.id)}
                      title={expanded === k.id ? 'Collapse' : 'Show details'}>
                      <span className={`transition ${expanded === k.id ? 'rotate-90' : ''}`}>›</span>
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-navy">{k.name}</span>
                      {k.flags.length > 0 && (
                        <span className={`badge ${k.flags.some((f) => f.severity === 'high') ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}
                          title={k.flags.map((f) => `${f.code}: ${f.detail}`).join('\n')}>⚠ {k.flags.length}</span>
                      )}
                    </div>
                    <span className={`badge mt-0.5 ${k.mode === 'test' ? 'bg-slate-200 text-slate-600' : 'bg-emerald-100 text-emerald-700'}`}>{k.mode}</span>
                  </td>
                  <td className="px-3 py-2"><code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">{k.prefix}</code></td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[180px] flex-wrap gap-1">
                      {k.realms.map((r) => <span key={r} className={`badge ${REALM_COLOR[r] || 'bg-slate-100 text-slate-600'}`}>{r}</span>)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex max-w-[160px] flex-wrap gap-1">
                      {k.scopes.map((s) => <span key={s} className={`badge ${scopeColor(s)}`}>{s.replace('read:', '')}</span>)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{k.rateLimitPerMin}</td>
                  <td className="px-3 py-2 text-slate-500">{fmt(k.lastUsedAt)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600">{k.callCount}</td>
                  <td className="px-3 py-2">
                    {k.status === 'active' && <span className="badge bg-green-100 text-green-700">Active</span>}
                    {k.status === 'revoked' && <span className="badge bg-slate-200 text-slate-500">Revoked</span>}
                    {k.status === 'expired' && <span className="badge bg-amber-100 text-amber-700">Expired</span>}
                    {k.expiresAt && k.status === 'active' && <div className="mt-0.5 text-[10px] text-slate-400">exp {fmtDay(k.expiresAt)}</div>}
                    {k.ipAllowlist.length > 0 && <div className="mt-0.5 text-[10px] text-slate-400">🔒 {k.ipAllowlist.length} IP{k.ipAllowlist.length > 1 ? 's' : ''}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1 text-xs">
                      <button className="text-left font-medium text-slate-500 hover:text-navy hover:underline" onClick={() => setUsageFor(k)}>📈 Usage</button>
                      {k.active && <button className="text-left font-medium text-navy hover:underline" onClick={() => setEditFor(k)}>🔑 Edit</button>}
                      {k.active && <button className="text-left font-medium text-amber-600 hover:underline"
                        onClick={() => confirm(`Rotate “${k.name}”? The current secret stops working immediately and you get a new one.`) && rotate.mutate(k.id)}>♻ Rotate</button>}
                      {k.active
                        ? <button className="text-left font-medium text-rose-600 hover:underline"
                            onClick={() => confirm(`Revoke “${k.name}”? Any integration using it stops immediately.`) && revoke.mutate(k.id)}>⛔ Revoke</button>
                        : <button className="text-left font-medium text-slate-400 hover:text-red-500 hover:underline"
                            onClick={() => confirm(`Delete “${k.name}” permanently?`) && del.mutate(k.id)}>Delete</button>}
                    </div>
                  </td>
                </tr>
                {expanded === k.id && (
                  <tr className="border-t border-slate-100 bg-navy/5">
                    <td />
                    <td colSpan={9} className="px-3 pb-3 pt-1">
                      <div className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                        <Detail label="Created" value={fmt(k.createdAt)} />
                        <Detail label="Created by" value={k.createdByName || '—'} />
                        <Detail label="Expires" value={k.expiresAt ? fmtDay(k.expiresAt) : 'Never'} />
                        <Detail label="Last used" value={fmt(k.lastUsedAt)} />
                        <Detail label="Last rotated" value={k.rotatedAt ? fmt(k.rotatedAt) : '—'} />
                        <Detail label="Revoked" value={k.revokedAt ? `${fmt(k.revokedAt)}${k.revokedByName ? ` · ${k.revokedByName}` : ''}` : '—'} />
                        <Detail label="Lifetime calls" value={String(k.callCount)} />
                        <Detail label="Rate limit" value={`${k.rateLimitPerMin} / min`} />
                        <div className="sm:col-span-2 lg:col-span-3">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">IP allowlist</div>
                          {k.ipAllowlist.length === 0
                            ? <div className="mt-0.5 text-slate-500">Any IP</div>
                            : <div className="mt-1 flex flex-wrap gap-1">{k.ipAllowlist.map((ip) => <code key={ip} className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-600 ring-1 ring-slate-200">{ip}</code>)}</div>}
                        </div>
                        <div className="sm:col-span-2 lg:col-span-3">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Full realms &amp; scopes</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {k.realms.map((r) => <span key={r} className={`badge ${REALM_COLOR[r] || 'bg-slate-100 text-slate-600'}`}>{r}</span>)}
                            {k.scopes.map((s) => <span key={s} className={`badge ${scopeColor(s)}`}>{s}</span>)}
                          </div>
                        </div>
                        {k.flags.length > 0 && (
                          <div className="sm:col-span-2 lg:col-span-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Anomaly flags (last 24h)</div>
                            <ul className="mt-1 space-y-1">
                              {k.flags.map((f) => (
                                <li key={f.code} className={`rounded px-2 py-1 text-xs ${f.severity === 'high' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'}`}>
                                  <span className="font-mono font-semibold">{f.code}</span> — {f.detail}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showCreate && <CreateModal meta={meta} onClose={() => setShowCreate(false)} onCreated={(c) => { setCreated(c); setShowCreate(false); qc.invalidateQueries({ queryKey: ['api-keys'] }); }} />}
      {editFor && <CreateModal meta={meta} editKey={editFor} onClose={() => setEditFor(null)} onCreated={() => {}} onSaved={() => { setEditFor(null); qc.invalidateQueries({ queryKey: ['api-keys'] }); }} />}
      {usageFor && <UsageModal keyRow={usageFor} onClose={() => setUsageFor(null)} />}
    </div>
  );
}

// ── Create modal ──────────────────────────────────────────────────────────────
function CreateModal({ meta, onClose, onCreated, editKey, onSaved }: { meta: Meta; onClose: () => void; onCreated: (c: { name: string; key: string }) => void; editKey?: KeyRow; onSaved?: () => void }) {
  const isEdit = !!editKey;
  const [name, setName] = useState(editKey?.name ?? '');
  const [mode, setMode] = useState<'live' | 'test'>((editKey?.mode as 'live' | 'test') ?? 'live');
  const [realms, setRealms] = useState<string[]>(editKey?.realms ?? []);
  const [scopes, setScopes] = useState<string[]>(editKey?.scopes ?? ['read:core']);
  const [rate, setRate] = useState(String(editKey?.rateLimitPerMin ?? 600));
  const [expires, setExpires] = useState(editKey?.expiresAt ? editKey.expiresAt.slice(0, 10) : '');
  const [ips, setIps] = useState((editKey?.ipAllowlist ?? []).join('\n'));
  const [err, setErr] = useState('');

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  // Create (POST) mints a new secret; Edit (PATCH) changes ONLY what the SAME key
  // can reach — the secret is never touched.
  const create = useMutation({
    mutationFn: async () => {
      const ipAllowlist = ips.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const body = {
        name: name.trim(), realms, scopes,
        rateLimitPerMin: Number(rate) || 600,
        expiresAt: expires ? new Date(expires + 'T23:59:59').toISOString() : null,
        ipAllowlist,
      };
      if (isEdit) { await api.patch(`/api-keys/${editKey!.id}`, body); return null; }
      return (await api.post('/api-keys', { ...body, mode })).data as { name: string; key: string };
    },
    onSuccess: (d) => { if (isEdit) onSaved?.(); else onCreated(d as { name: string; key: string }); },
    onError: (e) => setErr(errMsg(e)),
  });

  // Live hint: realms that need a scope the user hasn't picked.
  const missingScope = realms
    .map((r) => meta.realms.find((m) => m.key === r))
    .filter((r): r is RealmDef => !!r?.requiresScope && !scopes.includes(r.requiresScope!));

  const canSubmit = name.trim() && realms.length > 0 && !create.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(5,35,121,0.34)] p-4">
      <div className="my-8 w-full max-w-2xl rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-bold text-navy">{isEdit ? `Edit permissions — ${editKey!.name}` : 'Create an API key'}</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4">
          {isEdit && (
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
              The key’s secret is <b>not</b> changed — the same <code className="font-mono">{editKey!.prefix}…</code> keeps working. You’re only changing what it can reach. To let this key fetch every realm, tick them all below.
            </div>
          )}
          {/* Name */}
          <div>
            <label className="label">Name</label>
            <input className="input" placeholder="Power BI — Finance" value={name} onChange={(e) => setName(e.target.value)} />
            <p className="mt-1 text-xs text-slate-400">Name it after the integration that will hold it. One key per integration — never share a key between two systems, or you can’t revoke one without breaking the other.</p>
          </div>

          {/* Realms */}
          <div>
            <div className="label">Realms <span className="font-normal text-slate-400">— what data the key can reach</span></div>
            <div className="grid gap-2 sm:grid-cols-2">
              {meta.realms.map((r) => {
                const on = realms.includes(r.key);
                return (
                  <button key={r.key} type="button" onClick={() => toggle(realms, setRealms, r.key)}
                    className={`rounded-lg border p-2.5 text-left transition ${on ? 'border-navy bg-navy/5' : 'border-slate-200 hover:border-slate-300'}`}>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={on} readOnly className="pointer-events-none" />
                      <span className="text-sm font-semibold text-navy">{r.label}</span>
                      {r.requiresScope && <span className="badge bg-amber-100 text-[10px] text-amber-700">needs {r.requiresScope}</span>}
                    </div>
                    <div className="mt-0.5 pl-6 text-xs text-slate-500">{r.desc}</div>
                  </button>
                );
              })}
            </div>
            {realms.length === 0 && <p className="mt-1 text-xs font-medium text-rose-500">Grant at least one realm.</p>}
            <p className="mt-1 text-xs text-slate-400">Finance &amp; Vendors are special: their scope isn’t optional. Without it every endpoint in the realm answers <code className="font-mono">forbidden_scope (403)</code> — the key would look right and work for nothing.</p>
          </div>

          {/* Scopes */}
          <div>
            <div className="label">Scopes <span className="font-normal text-slate-400">— which sensitive fields come back</span></div>
            <div className="grid gap-2 sm:grid-cols-2">
              {meta.scopes.map((s) => {
                const on = scopes.includes(s.key) || s.always;
                return (
                  <button key={s.key} type="button" disabled={s.always} onClick={() => !s.always && toggle(scopes, setScopes, s.key)}
                    className={`rounded-lg border p-2.5 text-left transition ${on ? 'border-navy bg-navy/5' : 'border-slate-200 hover:border-slate-300'} ${s.always ? 'opacity-70' : ''}`}>
                    <div className="flex items-center gap-2">
                      <input type="checkbox" checked={on} readOnly className="pointer-events-none" />
                      <span className="font-mono text-sm font-semibold text-navy">{s.label}</span>
                      {s.always && <span className="badge bg-slate-100 text-[10px] text-slate-500">baseline — always on</span>}
                    </div>
                    <div className="mt-0.5 pl-6 text-xs text-slate-500">{s.desc}</div>
                  </button>
                );
              })}
            </div>
            {missingScope.length > 0 && (
              <p className="mt-1 text-xs font-medium text-amber-600">
                Add {missingScope.map((r) => r.requiresScope).join(', ')} — required by the {missingScope.map((r) => r.label).join(', ')} realm.
              </p>
            )}
            <p className="mt-1 text-xs text-slate-400">A field the key lacks the scope for is omitted, not an error — the response’s <code className="font-mono">_meta.withheld</code> lists what was dropped.</p>
          </div>

          {/* Limits */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">Rate limit <span className="font-normal text-slate-400">(requests / minute)</span></label>
              <input className="input" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div>
              <label className="label">Expires <span className="font-normal text-slate-400">(optional)</span></label>
              <input className="input" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </div>
          </div>

          {/* IP allowlist */}
          <div>
            <label className="label">IP allowlist <span className="font-normal text-slate-400">(optional — one per line, or comma separated)</span></label>
            <textarea className="input min-h-[64px] font-mono text-xs" placeholder={'203.0.113.7\n198.51.100.0/24'} value={ips} onChange={(e) => setIps(e.target.value)} />
            <p className="mt-1 text-xs text-slate-400">Leave empty to allow any IP. A call from outside the list is rejected with <code className="font-mono">ip_not_allowed (403)</code>. Plain IPv4 and CIDR supported.</p>
          </div>

          {/* Mode — only on create; a key's mode is fixed once minted (it's in the prefix). */}
          {!isEdit && (
            <div>
              <label className="label">Mode</label>
              <div className="flex gap-2">
                {(['live', 'test'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)}
                    className={`rounded-lg border px-4 py-1.5 font-mono text-sm ${mode === m ? 'border-navy bg-navy/5 text-navy' : 'border-slate-200 text-slate-500'}`}>crmk_{m}_…</button>
                ))}
              </div>
            </div>
          )}

          {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-600">{err}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSubmit} onClick={() => { setErr(''); create.mutate(); }}>
            {create.isPending ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save permissions' : 'Create key')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Usage modal — per-request audit log ───────────────────────────────────────
interface CallRow { at: string; method: string; route: string; status: number; ms: number; ip: string }

function UsageModal({ keyRow, onClose }: { keyRow: KeyRow; onClose: () => void }) {
  const [q, setQ] = useState('');
  const usageQ = useQuery({
    queryKey: ['api-key-usage', keyRow.id],
    queryFn: async () => (await api.get(`/api-keys/${keyRow.id}/usage?limit=200`)).data as
      { totalCalls: number; lastUsedAt: string | null; rateLimitPerMin: number; calls: CallRow[] },
  });
  const calls = usageQ.data?.calls ?? [];
  const filtered = calls.filter((c) => `${c.route} ${c.ip} ${c.method} ${c.status}`.toLowerCase().includes(q.toLowerCase()));
  const when = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function exportCsv() {
    const head = ['When', 'Method', 'Route', 'Status', 'MS', 'IP'];
    const lines = filtered.map((c) => [when(c.at), c.method, c.route, c.status, c.ms, c.ip].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const u = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = u; a.download = `usage-${keyRow.name}.csv`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 5000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(5,35,121,0.34)] p-4">
      <div className="my-6 flex max-h-[88vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-base font-bold text-navy">Usage — {keyRow.name}</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose}>✕</button>
        </div>

        {/* Stat cards */}
        <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Lifetime calls" value={usageQ.data?.totalCalls ?? keyRow.callCount} sub="Counted on the key itself" tone="border-blue-200 bg-blue-50 text-blue-800" />
          <div className="rounded-lg border border-violet-200 bg-violet-50 p-4 text-violet-800">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Last used</div>
            <div className="mt-1 text-lg font-bold">{keyRow.lastUsedAt ? fmtDay(keyRow.lastUsedAt) : 'Never'}</div>
            <div className="mt-0.5 text-xs opacity-60">Most recent authenticated call</div>
          </div>
          <div className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-teal-800">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70">Rate limit</div>
            <div className="mt-1 text-lg font-bold">{usageQ.data?.rateLimitPerMin ?? keyRow.rateLimitPerMin}/min</div>
            <div className="mt-0.5 text-xs opacity-60">Per key, per minute</div>
          </div>
          <Stat label="Recent calls shown" value={calls.length} sub="Newest 200 from the audit log" tone="border-amber-200 bg-amber-50 text-amber-800" />
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-2">
          <input className="input h-8 w-64 text-sm" placeholder="Search route, IP…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">{filtered.length} rows</span>
            <button className="btn-outline h-8 px-2 text-xs" onClick={exportCsv} disabled={!filtered.length}>↓ Export</button>
          </div>
        </div>

        {/* Log table */}
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          {usageQ.isLoading ? <Spinner label="Loading usage…" /> : calls.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">No calls recorded yet for this key.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">Method</th>
                  <th className="px-3 py-2 font-semibold">Route</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 text-right font-semibold">MS</th>
                  <th className="px-3 py-2 font-semibold">IP</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">{when(c.at)}</td>
                    <td className="px-3 py-1.5"><span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-slate-600">{c.method}</span></td>
                    <td className="px-3 py-1.5 font-mono text-xs text-navy">{c.route}</td>
                    <td className="px-3 py-1.5">
                      <span className={`badge ${c.status >= 200 && c.status < 300 ? 'bg-emerald-100 text-emerald-700' : c.status < 500 ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>{c.status}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{c.ms}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-500">{c.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
