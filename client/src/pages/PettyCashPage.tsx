import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, KPI, Modal, Spinner } from '../components/ui';
import { fmtDate, inr } from '../lib/format';

// ── Petty Cash — site-manager float + expense ledger ─────────────────────────
// Custodian records expenses → submits to Accounts → Accounts confirm / reject.
// A top-up adds to the float. Company-wide, with an optional per-project filter.

const STATUS_PILL: Record<string, string> = {
  RECORDED: 'bg-slate-100 text-slate-600',
  SUBMITTED: 'bg-blue-100 text-blue-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-sky-100 text-sky-700',
  CONFIRMED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-rose-100 text-rose-700',
  VOID: 'bg-slate-200 text-slate-400 line-through',
};
const statusLabel = (s: string) => (s === 'CONFIRMED' ? 'Confirmed by Accounts' : s === 'APPROVED' ? 'Approved · Account pending' : s === 'PENDING_APPROVAL' ? 'Pending approval' : s === 'SUBMITTED' ? 'Accounts pending' : s === 'REJECTED' ? 'Rejected — correct & resend' : s === 'VOID' ? 'Voided' : 'Recorded');

// A short, colour-coded pill for each ledger head (like the reference "kind" tag).
const CATEGORY_PILL: Record<string, { label: string; cls: string }> = {
  'Advance to Technician': { label: 'ADVANCE', cls: 'bg-blue-100 text-blue-700' },
  'Spare Parts Purchase (Reefer/Depot Related)': { label: 'SPARES', cls: 'bg-purple-100 text-purple-700' },
  'Travel / Local Conveyance (taxi, bus, auto, etc.)': { label: 'TRAVEL', cls: 'bg-amber-100 text-amber-700' },
  'Security Deposit for Spare Parts (Consumable)': { label: 'DEPOSIT', cls: 'bg-teal-100 text-teal-700' },
  'Courier / Postage / Delivery Charges': { label: 'COURIER', cls: 'bg-cyan-100 text-cyan-700' },
  'Vendor / Labour Payments (Small Cash Settlements)': { label: 'VENDOR', cls: 'bg-indigo-100 text-indigo-700' },
  'Staff Welfare (Snacks, Refreshments, Beverages for Staff/Clients)': { label: 'WELFARE', cls: 'bg-green-100 text-green-700' },
  'Miscellaneous / Other Expenses': { label: 'MISC', cls: 'bg-slate-100 text-slate-600' },
};
const catPill = (e: any) => (e.type === 'TOPUP' ? { label: 'TOP-UP', cls: 'bg-emerald-100 text-emerald-700' } : (CATEGORY_PILL[e.category] || { label: 'EXPENSE', cls: 'bg-slate-100 text-slate-600' }));

type Doc = { kind: string; fileUrl: string; fileName?: string; at?: string };
// All documents on an entry — the `documents` array, falling back to the three
// original upload slots for entries created before the array existed.
const entryDocs = (e: any): Doc[] => {
  if (Array.isArray(e.documents) && e.documents.length) return e.documents;
  return [
    e.invoiceUrl && { kind: 'Bill', fileUrl: e.invoiceUrl },
    e.budgetUrl && { kind: 'Budget', fileUrl: e.budgetUrl },
    e.paymentUrl && { kind: 'Payment', fileUrl: e.paymentUrl },
  ].filter(Boolean) as Doc[];
};

export default function PettyCashPage() {
  const qc = useQueryClient();
  const { canEdit, can } = useAuth();
  const canManage = canEdit('pettycash'); // custodian records / tops up / submits
  const isAccounts = can('accountsTeam');  // Accounts confirm / reject / void (own flag, separate from FMS canMarkPaid)
  const isRaiser = can('raiseAdvance');    // the single authorized person who may ISSUE a fresh advance

  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [projectId, setProjectId] = useState('');
  const [catFilter, setCatFilter] = useState(''); // quick category/kind chip (client-side)

  const [recording, setRecording] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);
  const [raising, setRaising] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [uploadFor, setUploadFor] = useState<any | null>(null); // entry to add a document to
  const [commentsFor, setCommentsFor] = useState<any | null>(null); // entry for the Comments & audit modal
  const [custodianEdit, setCustodianEdit] = useState(false);
  const [showMonthly, setShowMonthly] = useState(false);

  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (projectId) params.set('projectId', projectId);

  const q = useQuery({ queryKey: ['petty', type, status, search, from, to, projectId], queryFn: async () => (await api.get(`/petty-cash?${params.toString()}`)).data as { entries: any[]; summary: any; categories: string[]; monthly: any[] } });
  const projectsQ = useQuery({ queryKey: ['petty-projects'], queryFn: async () => (await api.get('/projects')).data.projects as any[] });
  const cfgQ = useQuery({ queryKey: ['petty-config'], queryFn: async () => (await api.get('/petty-cash/config')).data.config as any });
  // Active users for the "for whom / recipient" dropdown + the per-person ledger.
  const peopleQ = useQuery({ queryKey: ['petty-people'], queryFn: async () => (await api.get('/petty-cash/people')).data.people as { id: string; name: string; email: string | null }[] });
  const [view, setView] = useState<'ledger' | 'byperson'>('ledger');

  const refresh = () => { qc.invalidateQueries({ queryKey: ['petty'] }); };
  // Quick actions triggered from the row kebab menu.
  const act = useMutation({ mutationFn: (v: { id: string; verb: string; body?: any }) => api.post(`/petty-cash/${v.id}/${v.verb}`, v.body ?? {}), onSuccess: () => refresh(), onError: (e) => alert(errMsg(e)) });
  const doAct = (id: string, verb: string) => {
    if (verb === 'reject') { const r = prompt('What needs correcting? (sent back to the custodian)'); if (!r?.trim()) return; act.mutate({ id, verb, body: { remark: r } }); return; }
    if (verb === 'void') { if (!confirm('Strike off (void) this entry? It stays in the ledger but no longer counts.')) return; act.mutate({ id, verb }); return; }
    act.mutate({ id, verb });
  };
  const submitAll = useMutation({ mutationFn: async () => (await api.post('/petty-cash/submit-all', {})).data as { submitted: number }, onSuccess: (r) => { refresh(); alert(`Submitted ${r.submitted} expense(s) to accounts.`); }, onError: (e) => alert(errMsg(e)) });
  // Pull VR/UTR the FMS team entered in the "Advance Account FMS" sheet back in now.
  const syncFms = useMutation({ mutationFn: async () => (await api.post('/petty-cash/advance-fms-sync', {})).data as { ok: boolean; rows?: number; message?: string }, onSuccess: (r) => { refresh(); alert(r.ok ? `Synced with FMS sheet (${r.rows ?? 0} advance row(s)). VR/UTR pulled in.` : `Sync: ${r.message}`); }, onError: (e) => alert(errMsg(e)) });
  const projects = projectsQ.data ?? [];
  const projName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? null;

  if (q.isLoading) return <div className="p-8"><Spinner label="Loading petty cash…" /></div>;
  const { entries = [], summary = {}, categories = [], monthly = [] } = q.data ?? {};
  const cfg = cfgQ.data;
  const people = peopleQ.data ?? [];
  const recordedCount = entries.filter((e: any) => e.type === 'EXPENSE' && e.status === 'RECORDED').length;
  const shown = catFilter ? entries.filter((e: any) => (catFilter === 'TOPUP' ? e.type === 'TOPUP' : e.category === catFilter)) : entries;

  const exportCsv = () => {
    const head = ['Petty #', 'Date', 'Type', 'Category', 'Technician', 'Paid to', 'Project', 'Job Order', 'Description', 'Amount', 'Status', 'Recorded by'];
    const rows = entries.map((e: any) => [e.entryNumber, fmtDate(e.date), e.type, e.type === 'TOPUP' ? (e.reason || 'Float') : e.category, e.technician || '', e.paidTo || '', projName(e.projectId) || '', e.jobOrder || '', (e.description || '').replace(/\n/g, ' '), (e.type === 'TOPUP' ? '' : '-') + (e.amount || 0), e.status, e.recordedByName || '']);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'petty-cash.csv'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-green-600 text-white">₹</span>
            <h1 className="text-2xl font-bold text-navy">New Advance</h1>
          </div>
          <p className="text-sm text-slate-500">Advances issued to each person, and what was spent against them.</p>
          <p className="mt-0.5 text-xs text-slate-400">
            Custodian: <span className="font-medium text-slate-600">{cfg?.custodianName || '—'}</span>{cfg?.custodianEmail ? ` (${cfg.custodianEmail})` : ''}
            {canManage && <button className="ml-2 text-navy hover:underline" onClick={() => setCustodianEdit(true)}>change</button>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isRaiser && <button className="btn-primary text-sm" onClick={() => setRaising(true)}>➕ Raise advance</button>}
          {canManage && <button className="btn-outline text-sm" onClick={() => setRecording(true)}>+ Record expense</button>}
          {canManage && recordedCount > 0 && <button className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600" disabled={submitAll.isPending} onClick={() => { if (confirm(`Submit all ${recordedCount} recorded expense(s) to accounts?`)) submitAll.mutate(); }}>➤ Submit {recordedCount} to accounts</button>}
          {canManage && <button className="btn-outline text-sm" onClick={() => setToppingUp(true)}>⊕ Add top-up</button>}
          {isAccounts && <button className="btn-outline text-sm" disabled={syncFms.isPending} onClick={() => syncFms.mutate()} title="Pull VR/UTR from the Advance Account FMS sheet">{syncFms.isPending ? 'Syncing…' : '↻ Sync FMS'}</button>}
          <button className="btn-outline text-sm" onClick={() => downloadFile(`/petty-cash/pdf?${params.toString()}`, 'petty-cash-ledger.pdf')}>📄 PDF</button>
          <button className="btn-outline text-sm" onClick={exportCsv}>📊 Excel</button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <KPI label="Cash on hand" value={inr(summary.cashOnHand)} accent={summary.cashOnHand < 0 ? '#dc2626' : '#16a34a'} sub="topups − expenses" />
        <KPI label="Expenses (entries)" value={inr(summary.expensesTotal)} accent="#2563eb" sub={`${summary.expensesCount} entries`} />
        <KPI label="Accounts confirmed" value={inr(summary.confirmedTotal)} accent="#16a34a" sub={`${summary.confirmedCount} entries`} />
        <KPI label="Accounts pending" value={inr(summary.pendingTotal)} accent="#d97706" sub={`${summary.pendingCount} entries`} />
        <KPI label="Top-ups added" value={inr(summary.topupsTotal)} accent="#16a34a" sub={`${summary.transactions} transactions`} />
      </div>

      {/* Ledger vs per-person view */}
      <div className="flex gap-2 border-b border-slate-200">
        <button onClick={() => setView('ledger')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${view === 'ledger' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Ledger</button>
        <button onClick={() => setView('byperson')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${view === 'byperson' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>By Person</button>
      </div>

      {view === 'byperson' ? <ByPersonView entries={entries} onOpen={setDetailId} /> : (<>
      {/* Month by month */}
      <div className="card p-3">
        <button className="flex w-full items-center justify-between text-sm font-semibold text-slate-600" onClick={() => setShowMonthly((s) => !s)}>
          <span>Month by month <span className="font-normal text-slate-400">· cash carried into the 1st, top-ups, expenses & closing</span></span>
          <span className="text-xs text-slate-400">{showMonthly ? '▲ hide' : '▼ show'}</span>
        </button>
        {showMonthly && (monthly.length === 0 ? <div className="mt-2 text-xs text-slate-400">No entries yet.</div> : (
          <div className="overflow-x-auto">
            <table className="mt-2 w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">Month</th><th className="text-right">Opening</th><th className="text-right">Top-ups</th><th className="text-right">Expenses</th><th className="text-right">Closing</th></tr></thead>
              <tbody>
                {monthly.map((m: any) => (
                  <tr key={m.month} className="border-t border-slate-100">
                    <td className="py-1.5 font-medium text-slate-600">{new Date(m.month + '-01').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</td>
                    <td className="text-right">{inr(m.opening)}</td>
                    <td className="text-right text-emerald-700">+{inr(m.topups)}</td>
                    <td className="text-right text-rose-600">−{inr(m.expenses)}</td>
                    <td className={`text-right font-semibold ${m.closing < 0 ? 'text-rose-600' : 'text-slate-700'}`}>{inr(m.closing)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="card p-3">
        <div className="mb-2 text-sm font-semibold text-slate-600">Find an entry</div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Chip active={!catFilter} onClick={() => setCatFilter('')}>All ({entries.length})</Chip>
          {categories.map((c: string) => { const cnt = entries.filter((e: any) => e.category === c).length; return cnt > 0 ? <Chip key={c} active={catFilter === c} onClick={() => setCatFilter(c)}>{CATEGORY_PILL[c]?.label || c} ({cnt})</Chip> : null; })}
          {entries.some((e: any) => e.type === 'TOPUP') && <Chip active={catFilter === 'TOPUP'} onClick={() => setCatFilter('TOPUP')}>TOP-UP ({entries.filter((e: any) => e.type === 'TOPUP').length})</Chip>}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input text-sm" placeholder="Search PETTY #, category, paid-to…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="input text-sm" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            <option value="EXPENSE">Expenses</option>
            <option value="TOPUP">Top-ups</option>
          </select>
          <select className="input text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All status</option>
            <option value="RECORDED">Recorded</option>
            <option value="SUBMITTED">Accounts pending</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="REJECTED">Rejected</option>
            <option value="VOID">Voided</option>
          </select>
          <select className="input text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs text-slate-500">From <input className="input text-sm" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="flex items-center gap-1 text-xs text-slate-500">To <input className="input text-sm" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </div>

      {/* Ledger */}
      {shown.length === 0 ? (
        <EmptyState title="No entries" hint={canManage ? 'Record an expense or add a float top-up to begin.' : 'No petty-cash entries yet.'} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full border-collapse text-sm [&_td]:border [&_td]:border-slate-200 [&_td]:px-3 [&_td]:py-2.5 [&_th]:border [&_th]:border-slate-200 [&_th]:px-3 [&_th]:py-2">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th>Petty #</th><th>Date</th><th>Job Order</th><th>Category</th>
                <th>Technician / Detail</th><th className="text-right">Amount</th><th>Status</th><th>Bill</th><th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e: any) => {
                const pill = catPill(e);
                const docs = entryDocs(e);
                const byKind: Record<string, Doc[]> = {};
                docs.forEach((d) => { (byKind[d.kind] ||= []).push(d); });
                return (
                  <tr key={e.id} className={`cursor-pointer border-b border-slate-100 align-top hover:bg-slate-50 ${e.status === 'VOID' ? 'opacity-50' : ''}`} onClick={() => setDetailId(e.id)}>
                    <td className="font-medium text-navy">{e.entryNumber}</td>
                    <td className="whitespace-nowrap text-slate-500">{fmtDate(e.date)}</td>
                    <td className="text-slate-500">{e.jobOrder || <span className="text-slate-300">—</span>}</td>
                    <td>
                      <span className={`badge ${pill.cls}`}>{pill.label}</span>
                      <div className="mt-0.5 max-w-[180px] truncate text-xs text-slate-500" title={e.type === 'TOPUP' ? (e.reason || 'Float') : e.category}>{e.type === 'TOPUP' ? (e.reason || 'Float') : e.category}</div>
                    </td>
                    <td>
                      <div className="text-slate-700">{e.type === 'TOPUP' ? (e.utrNumber ? `UTR ${e.utrNumber}` : 'Float top-up') : (e.technician || e.paidTo || '—')}</div>
                      {(e.description || (e.technician && e.paidTo)) && <div className="max-w-[240px] truncate text-xs text-slate-400" title={e.description || ''}>{e.technician && e.paidTo ? `${e.paidTo} · ` : ''}{e.description || ''}</div>}
                      {e.projectId && <span className="mt-0.5 inline-block rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">{projName(e.projectId) || 'project'}</span>}
                    </td>
                    <td className={`whitespace-nowrap text-right font-medium ${e.type === 'TOPUP' ? 'text-emerald-700' : 'text-slate-700'}`}>{e.type === 'TOPUP' ? '+' : '−'}{inr(e.amount)}</td>
                    <td>
                      {/* Who entered this — small uppercase label above the status. */}
                      {e.recordedByName && <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600">Entry by {e.recordedByName}</div>}
                      <span className={`badge mt-0.5 ${STATUS_PILL[e.status] || 'bg-slate-100 text-slate-600'}`}>{e.status === 'CONFIRMED' ? '✓ ' : ''}{statusLabel(e.status)}</span>
                      {/* Approval-chain progress for a raised advance awaiting approval. */}
                      {e.chain?.total > 0 && (
                        <div className="mt-0.5 text-[10px] text-amber-600">{e.chain.approved}/{e.chain.total} done{e.chain.pendingWith?.length ? ` · ⏳ ${e.chain.pendingWith.join(', ')}` : ''}</div>
                      )}
                      {/* VR / UTR pulled from the FMS sheet — shown as soon as they land. */}
                      {(e.vrNo || e.utrNumber) && (
                        <div className="mt-0.5 font-mono text-[10px] text-green-700">{e.vrNo ? `VR ${e.vrNo}` : ''}{e.vrNo && e.utrNumber ? ' · ' : ''}{e.utrNumber ? `UTR ${e.utrNumber}` : ''}</div>
                      )}
                      {/* Who confirmed / rejected it. */}
                      {e.decidedBy && (e.status === 'CONFIRMED' || e.status === 'REJECTED') && (
                        <div className="mt-0.5 text-[10px] text-slate-400">{e.decidedBy} {e.status === 'CONFIRMED' ? '✓' : '✕'}</div>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        {Object.entries(byKind).map(([kind, list]) => (
                          list.length === 1
                            ? <a key={kind} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-200" href={list[0].fileUrl} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>📎 {kind}</a>
                            : <button key={kind} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 hover:bg-slate-200" title="Open to view all" onClick={(ev) => { ev.stopPropagation(); setDetailId(e.id); }}>📎 {kind} ×{list.length}</button>
                        ))}
                        {canManage && e.type === 'EXPENSE' && <button className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-100" title="Add a document" onClick={(ev) => { ev.stopPropagation(); setUploadFor(e); }}>+</button>}
                        {docs.length === 0 && !(canManage && e.type === 'EXPENSE') && <span className="text-xs text-slate-300">—</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-navy" title="Comments & audit" onClick={(ev) => { ev.stopPropagation(); setCommentsFor(e); }}>💬</button>
                        <RowMenu e={e} canManage={canManage} isAccounts={isAccounts} onAct={(verb) => doAct(e.id, verb)} onOpen={() => setDetailId(e.id)} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </>)}

      {raising && <RaiseAdvanceModal projects={projects} people={people} onClose={() => setRaising(false)} onDone={() => { setRaising(false); refresh(); }} />}
      {recording && <ExpenseModal categories={categories} projects={projects} people={people} onClose={() => setRecording(false)} onDone={() => { setRecording(false); refresh(); }} />}
      {toppingUp && <TopupModal people={people} onClose={() => setToppingUp(false)} onDone={() => { setToppingUp(false); refresh(); }} />}
      {detailId && <DetailModal id={detailId} projName={projName} canManage={canManage} isAccounts={isAccounts} onClose={() => setDetailId(null)} onChanged={refresh} />}
      {uploadFor && <DocUploadModal entry={uploadFor} onClose={() => setUploadFor(null)} onDone={() => { setUploadFor(null); refresh(); }} />}
      {commentsFor && <CommentsModal entry={commentsFor} onClose={() => setCommentsFor(null)} onChanged={refresh} />}
      {custodianEdit && <CustodianModal current={cfg} onClose={() => setCustodianEdit(false)} onDone={() => { setCustodianEdit(false); qc.invalidateQueries({ queryKey: ['petty-config'] }); }} />}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${active ? 'bg-navy text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{children}</button>;
}

// ── By Person — per-person advance / top-up ledger ───────────────────────────
// Groups every non-void entry by the linked person (personId, else the typed
// technician name). Shows what each person has RECEIVED (advances + top-ups still
// in hand) plus, for context, what was spent on other heads. The "In hand" here is
// advances + top-ups received; a "Settle advance" step (Phase 2) will reduce it as
// cash is returned / accounted.
const ADVANCE_CAT = 'Advance to Technician';
function ByPersonView({ entries, onOpen }: { entries: any[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = new Map<string, { key: string; name: string; advance: number; topup: number; otherSpend: number; rows: any[] }>();
  for (const e of entries) {
    if (e.status === 'VOID') continue;
    const person = e.personId || (e.technician ? `name:${String(e.technician).toLowerCase().trim()}` : '');
    if (!person) continue; // entry not tied to any person
    const g = groups.get(person) ?? { key: person, name: e.technician || '—', advance: 0, topup: 0, otherSpend: 0, rows: [] as any[] };
    if (!g.name || g.name === '—') g.name = e.technician || g.name;
    const amt = Number(e.amount) || 0;
    if (e.type === 'TOPUP') g.topup += amt;
    else if (e.category === ADVANCE_CAT) g.advance += amt;
    else g.otherSpend += amt;
    g.rows.push(e);
    groups.set(person, g);
  }
  const list = [...groups.values()]
    .map((g) => ({ ...g, received: g.advance + g.topup }))
    .sort((a, b) => b.received - a.received);

  if (list.length === 0) return <EmptyState title="No per-person entries yet" hint="Record an advance / top-up and pick the person (from the dropdown) — their balance shows up here." />;

  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800"><strong>In hand</strong> = advances + top-ups received by the person. A <strong>“Settle advance”</strong> step (coming next) will reduce it as cash is returned or accounted.</p>
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse text-sm [&_td]:border [&_td]:border-slate-200 [&_td]:px-3 [&_td]:py-2.5 [&_th]:border [&_th]:border-slate-200 [&_th]:px-3 [&_th]:py-2">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr><th>Person</th><th className="text-right">Advance received</th><th className="text-right">Top-ups</th><th className="text-right">Other spend</th><th className="text-right">In hand</th><th></th></tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <Fragment key={g.key}>
                <tr className="hover:bg-slate-50">
                  <td className="font-medium text-slate-700">{g.name}</td>
                  <td className="text-right text-blue-700">{inr(g.advance)}</td>
                  <td className="text-right text-emerald-700">{inr(g.topup)}</td>
                  <td className="text-right text-slate-500">{inr(g.otherSpend)}</td>
                  <td className={`text-right font-semibold ${g.received > 0 ? 'text-navy' : 'text-slate-400'}`}>{inr(g.received)}</td>
                  <td className="text-right"><button className="text-xs font-medium text-navy hover:underline" onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}>{open[g.key] ? '▲ hide' : `▼ ${g.rows.length} entr${g.rows.length === 1 ? 'y' : 'ies'}`}</button></td>
                </tr>
                {open[g.key] && (
                  <tr>
                    <td colSpan={6} className="bg-slate-50 !p-0">
                      <table className="w-full text-xs [&_td]:px-3 [&_td]:py-1.5">
                        <tbody>
                          {g.rows.map((e) => (
                            <tr key={e.id} className="border-t border-slate-100">
                              <td className="font-medium text-navy"><button className="hover:underline" onClick={() => onOpen(e.id)}>{e.entryNumber}</button></td>
                              <td>{fmtDate(e.date)}</td>
                              <td>{e.type === 'TOPUP' ? 'Top-up' : e.category}</td>
                              <td className="max-w-[240px] truncate text-slate-500" title={e.description || ''}>{e.description || ''}</td>
                              <td className={`text-right font-medium ${e.type === 'TOPUP' ? 'text-emerald-700' : 'text-slate-700'}`}>{e.type === 'TOPUP' ? '+' : ''}{inr(e.amount)}</td>
                              <td className="text-slate-400">{e.status}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Set / change the company-wide custodian.
function CustodianModal({ current, onClose, onDone }: { current: any; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(current?.custodianName ?? '');
  const [email, setEmail] = useState(current?.custodianEmail ?? '');
  const [err, setErr] = useState('');
  const save = useMutation({ mutationFn: async () => (await api.put('/petty-cash/config', { custodianName: name || null, custodianEmail: email || null })).data.config, onSuccess: onDone, onError: (e) => setErr(errMsg(e)) });
  return (
    <Modal title="Custodian" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="space-y-3">
        <p className="text-xs text-slate-400">Who holds the petty-cash float. Shown on the page header and the ledger PDF.</p>
        <div><label className="label">Custodian name</label><input className="input" placeholder="e.g. Service Manager (Sitaram)" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label">Email (optional)</label><input className="input" type="email" placeholder="service@crystalgroup.in" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Comments & audit — a focused thread for the custodian ⇄ accounts back-and-forth,
// separate from the full entry view.
function CommentsModal({ entry, onClose, onChanged }: { entry: any; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canManage = canEdit('pettycash');
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const q = useQuery({ queryKey: ['petty-entry', entry.id], queryFn: async () => (await api.get(`/petty-cash/${entry.id}`)).data.entry as any });

  const add = useMutation({
    mutationFn: async (t: string) => (await api.post(`/petty-cash/${entry.id}/comment`, { text: t })).data.entry,
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['petty-entry', entry.id] }); onChanged(); },
    onError: (e) => alert(errMsg(e)),
  });

  const comments = q.data?.comments ?? [];
  return (
    <Modal title={`Comments & audit · ${entry.entryNumber}`} onClose={onClose} wide>
      <div className="space-y-4">
        {comments.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">
            <div className="mb-2 text-2xl">💬</div>
            No comments yet. Add one below for the custodian to act on.
          </div>
        ) : (
          <ol className="max-h-64 space-y-2 overflow-y-auto">
            {comments.map((c: any, i: number) => (
              <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <div className="text-slate-700">{c.text}</div>
                <div className="mt-0.5 text-[11px] text-slate-400">{c.byName} · {fmtDate(c.at)}</div>
              </li>
            ))}
          </ol>
        )}

        <div>
          <textarea ref={taRef} className="input text-sm" rows={3} placeholder="Add a comment for the custodian…" value={text} onChange={(e) => setText(e.target.value)} disabled={!canManage} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button className="btn-primary text-sm" disabled={!canManage || !text.trim() || add.isPending} onClick={() => add.mutate(text.trim())}>➤ Add comment</button>
            {canManage && (
              <>
                <span className="text-xs text-slate-400">· or act:</span>
                <button className="btn-outline text-sm" disabled={add.isPending} onClick={() => add.mutate('✓ Acknowledged')}>✓ Acknowledge</button>
                <button className="btn-outline text-sm text-green-700" disabled={add.isPending} onClick={() => add.mutate('✓✓ Resolved')}>✓✓ Resolve</button>
              </>
            )}
          </div>
          {canManage && <button className="btn-outline mt-2 text-sm" onClick={() => taRef.current?.focus()}>↩ Reply</button>}
        </div>
      </div>
    </Modal>
  );
}

// Row kebab menu — the working ⋮ actions (Submit / Confirm / Reject / Void).
function RowMenu({ e, canManage, isAccounts, onAct, onOpen }: { e: any; canManage: boolean; isAccounts: boolean; onAct: (verb: string) => void; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (ev: MouseEvent) => { if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const closed = e.status === 'VOID';
  const item = 'block w-full whitespace-nowrap px-3 py-1.5 text-left hover:bg-slate-50';
  return (
    <div ref={ref} className="relative inline-block">
      <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-navy" title="Actions" onClick={(ev) => { ev.stopPropagation(); setOpen((o) => !o); }}>⋮</button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg" onClick={(ev) => ev.stopPropagation()}>
          <button className={item} onClick={() => { setOpen(false); onOpen(); }}>Open details</button>
          {e.type === 'EXPENSE' && canManage && (e.status === 'RECORDED' || e.status === 'REJECTED') && (
            <button className={`${item} font-medium text-navy`} onClick={() => { setOpen(false); onAct('submit'); }}>➤ Submit to accounts</button>
          )}
          {e.type === 'EXPENSE' && isAccounts && !closed && (e.status === 'SUBMITTED' || e.status === 'RECORDED') && (
            <>
              <button className={`${item} text-green-700`} onClick={() => { setOpen(false); onAct('confirm'); }}>✓ Confirm (release / reimburse)</button>
              <button className={`${item} text-rose-600`} onClick={() => { setOpen(false); onAct('reject'); }}>✕ Reject &amp; resend to custodian</button>
            </>
          )}
          {isAccounts && !closed && <button className={`${item} text-rose-600`} onClick={() => { setOpen(false); onAct('void'); }}>⊘ Strike off (void)</button>}
        </div>
      )}
    </div>
  );
}

// Add a document (the Bill "+") — pick a kind and upload a file.
function DocUploadModal({ entry, onClose, onDone }: { entry: any; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState('Bill');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: async () => { const fd = new FormData(); fd.append('kind', kind); if (file) fd.append('file', file); return (await api.post(`/petty-cash/${entry.id}/document`, fd)).data.entry; },
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });
  return (
    <Modal title={`Add a document — ${entry.entryNumber}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); if (!file) { setErr('Choose a file.'); return; } save.mutate(); }} className="space-y-3">
        <div><label className="label">Document type</label>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            {['Bill', 'Budget', 'Payment', 'Quotation', 'Other'].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div><label className="label">File (PDF or image)</label><input className="input text-xs" type="file" accept=".pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || !file}>{save.isPending ? 'Uploading…' : 'Upload'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Record expense ───────────────────────────────────────────────────────────
function ExpenseModal({ categories, projects, people, onClose, onDone }: { categories: string[]; projects: any[]; people: { id: string; name: string; email: string | null }[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ category: categories[0] || '', amount: '', date: new Date().toISOString().slice(0, 10), technician: '', personId: '', paidTo: '', projectId: '', jobOrder: '', description: '' });
  const [files, setFiles] = useState<{ invoice?: File; budget?: File; payment?: File }>({});
  const [err, setErr] = useState('');
  const set = (patch: any) => setF((p: any) => ({ ...p, ...patch }));

  const save = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      Object.entries({ category: f.category, amount: f.amount, date: f.date, technician: f.technician, personId: f.personId, paidTo: f.paidTo, projectId: f.projectId, jobOrder: f.jobOrder, description: f.description }).forEach(([k, v]) => { if (v) fd.append(k, String(v)); });
      if (files.invoice) fd.append('invoice', files.invoice);
      if (files.budget) fd.append('budget', files.budget);
      if (files.payment) fd.append('payment', files.payment);
      return (await api.post('/petty-cash/expense', fd)).data.entry;
    },
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });

  const missing = [!f.amount && 'Amount', !f.description?.trim() && 'Description'].filter(Boolean);

  return (
    <Modal title="Record petty-cash expense" onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="space-y-3">
        <div><label className="label">Ledger head / expense category *</label>
          <select className="input" value={f.category} onChange={(e) => set({ category: e.target.value })}>{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Amount (₹) *</label><input className="input" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></div>
          <div><label className="label">Date</label><input className="input" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></div>
          <div><label className="label">Technician (for whom)</label>
            <select className="input" value={f.personId} onChange={(e) => { const u = people.find((p) => p.id === e.target.value); set({ personId: e.target.value, technician: u?.name ?? '' }); }}>
              <option value="">— Select person —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div><label className="label">Paid to</label><input className="input" placeholder="Vendor / person" value={f.paidTo} onChange={(e) => set({ paidTo: e.target.value })} /></div>
          <div><label className="label">Project (optional)</label>
            <select className="input" value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </div>
          <div><label className="label">Job Order (optional)</label><input className="input" placeholder="JO no / client" value={f.jobOrder} onChange={(e) => set({ jobOrder: e.target.value })} /></div>
        </div>
        <div><label className="label">Description *</label><textarea className="input" rows={2} placeholder="What the cash was for…" value={f.description} onChange={(e) => set({ description: e.target.value })} /></div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label">Supporting invoice</label><input className="input text-xs" type="file" accept=".pdf,image/*" onChange={(e) => setFiles((p) => ({ ...p, invoice: e.target.files?.[0] }))} /></div>
          <div><label className="label">Budget approval copy</label><input className="input text-xs" type="file" accept=".pdf,image/*" onChange={(e) => setFiles((p) => ({ ...p, budget: e.target.files?.[0] }))} /></div>
          <div><label className="label">Payment screenshot</label><input className="input text-xs" type="file" accept=".pdf,image/*" onChange={(e) => setFiles((p) => ({ ...p, payment: e.target.files?.[0] }))} /></div>
        </div>
        {missing.length > 0 && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Missing: <strong>{missing.join(', ')}</strong></div>}
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || missing.length > 0}>{save.isPending ? 'Recording…' : 'Record expense'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Raise advance (issue fresh cash to a person) ─────────────────────────────
function RaiseAdvanceModal({ projects, people, onClose, onDone }: { projects: any[]; people: { id: string; name: string; email: string | null }[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ personId: '', technician: '', amount: '', projectId: '', date: new Date().toISOString().slice(0, 10), description: '' });
  const [err, setErr] = useState('');
  const set = (patch: any) => setF((p: any) => ({ ...p, ...patch }));
  const save = useMutation({
    mutationFn: async () => (await api.post('/petty-cash/advance', { ...f, amount: Number(f.amount), projectId: f.projectId || null })).data.entry,
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });
  const missing = [!f.personId && 'Person', !f.amount && 'Amount'].filter(Boolean);
  return (
    <Modal title="Raise advance" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="space-y-3">
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">Cash handed to a person as an advance. It shows in their per-person balance &amp; cash-in-hand, and against their trips.</p>
        <div><label className="label">Person (for whom) *</label>
          <select className="input" value={f.personId} onChange={(e) => { const u = people.find((p) => p.id === e.target.value); set({ personId: e.target.value, technician: u?.name ?? '' }); }}>
            <option value="">— Select person —</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Amount (₹) *</label><input className="input" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></div>
          <div><label className="label">Date</label><input className="input" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></div>
          <div className="sm:col-span-2"><label className="label">Site / Project (optional)</label>
            <select className="input" value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </div>
        </div>
        <div><label className="label">Note</label><textarea className="input" rows={2} placeholder="What this advance is for…" value={f.description} onChange={(e) => set({ description: e.target.value })} /></div>
        {missing.length > 0 && <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Missing: <strong>{missing.join(', ')}</strong></div>}
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || missing.length > 0}>{save.isPending ? 'Raising…' : 'Raise advance'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Add top-up ───────────────────────────────────────────────────────────────
function TopupModal({ people, onClose, onDone }: { people: { id: string; name: string; email: string | null }[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ amount: '', reason: 'Float', date: new Date().toISOString().slice(0, 10), utrNumber: '', description: '', technician: '', personId: '' });
  const [err, setErr] = useState('');
  const set = (patch: any) => setF((p: any) => ({ ...p, ...patch }));
  const save = useMutation({ mutationFn: async () => (await api.post('/petty-cash/topup', { ...f, amount: Number(f.amount) })).data.entry, onSuccess: onDone, onError: (e) => setErr(errMsg(e)) });
  return (
    <Modal title="Add float top-up" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="space-y-3">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Cash given to the custodian by Accounts — increases the on-hand float.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label className="label">Amount (₹) *</label><input className="input" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></div>
          <div><label className="label">Reason</label>
            <select className="input" value={f.reason} onChange={(e) => set({ reason: e.target.value })}>
              <option value="Float">Float</option>
              <option value="Reimbursement">Reimbursement</option>
            </select>
          </div>
          <div><label className="label">Date</label><input className="input" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} /></div>
          <div><label className="label">UTR / Ref No.</label><input className="input" placeholder="Bank transfer ref (optional)" value={f.utrNumber} onChange={(e) => set({ utrNumber: e.target.value })} /></div>
          <div className="sm:col-span-2"><label className="label">Recipient (person) — optional</label>
            <select className="input" value={f.personId} onChange={(e) => { const u = people.find((p) => p.id === e.target.value); set({ personId: e.target.value, technician: u?.name ?? '' }); }}>
              <option value="">— none (general float) —</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <p className="mt-1 text-[11px] text-slate-400">If this top-up is money handed to a specific person, pick them — it shows in their per-person balance.</p>
          </div>
        </div>
        <div><label className="label">Remark</label><textarea className="input" rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending || !f.amount}>{save.isPending ? 'Adding…' : 'Add top-up'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ── Entry detail + approval actions + trail + comments ───────────────────────
function DetailModal({ id, projName, canManage, isAccounts, onClose, onChanged }: { id: string; projName: (id: string | null) => string | null; canManage: boolean; isAccounts: boolean; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const [remark, setRemark] = useState('');
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState('');
  const detailQ = useQuery({ queryKey: ['petty-entry', id], queryFn: async () => (await api.get(`/petty-cash/${id}`)).data.entry as any });
  // Approval chain for a RAISED advance (docType 'ADVANCE'). Empty for other entries.
  const isAdvance = detailQ.data?.category === 'Advance to Technician';
  const chainQ = useQuery({ queryKey: ['petty-chain', id], queryFn: async () => (await api.get(`/petty-cash/${id}/chain`)).data as { total: number; approved: number; steps: any[] }, enabled: isAdvance });

  const act = useMutation({
    mutationFn: async (v: { verb: string; body?: any }) => (await api.post(`/petty-cash/${id}/${v.verb}`, v.body ?? {})).data.entry,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['petty-entry', id] }); onChanged(); setRemark(''); setComment(''); setMsg('Done.'); },
    onError: (e) => setMsg(errMsg(e)),
  });

  if (detailQ.isLoading || !detailQ.data) return <Modal title="Entry" onClose={onClose}><Spinner label="Loading…" /></Modal>;
  const e = detailQ.data;
  const isExpense = e.type === 'EXPENSE';
  const docs = entryDocs(e);

  return (
    <Modal title={`${e.entryNumber} · ${isExpense ? 'Expense' : 'Top-up'}`} onClose={onClose} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${STATUS_PILL[e.status] || 'bg-slate-100 text-slate-600'}`}>{statusLabel(e.status)}</span>
          {e.recordedByName && <span className="text-xs text-slate-400">by {e.recordedByName}</span>}
        </div>
        <div className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <Field label="Type" v={isExpense ? 'Expense' : 'Top-up'} />
          <Field label="Date" v={fmtDate(e.date)} />
          {isExpense ? <Field label="Category" v={e.category} /> : <Field label="Reason" v={e.reason || 'Float'} />}
          <Field label="Amount" v={inr(e.amount)} />
          {isExpense && <Field label="Technician" v={e.technician || '—'} />}
          {isExpense && <Field label="Paid to" v={e.paidTo || '—'} />}
          {isExpense && <Field label="Project" v={projName(e.projectId) || '—'} />}
          {isExpense && <Field label="Job Order" v={e.jobOrder || '—'} />}
          {isAdvance && e.vrNo && <Field label="VR No." v={e.vrNo} />}
          {isAdvance && e.utrNumber && <Field label="UTR / Payment Ref" v={e.utrNumber} />}
          {!isExpense && <Field label="UTR / Ref" v={e.utrNumber || '—'} />}
          {e.sanctionedAmount != null && e.status === 'CONFIRMED' && <Field label="Sanctioned" v={inr(e.sanctionedAmount)} />}
        </div>
        {e.description && <div className="text-sm text-slate-600"><span className="text-xs uppercase text-slate-400">Description</span><div>{e.description}</div></div>}

        {/* Approval chain (raised advance) — who signs, in order, and whose turn. */}
        {isAdvance && (chainQ.data?.total ?? 0) > 0 && (() => {
          const c = chainQ.data!;
          const pending = c.steps.filter((s) => s.status === 'PENDING');
          return (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase text-slate-400">Approval chain <span className={`rounded px-1.5 py-0.5 text-[10px] ${c.approved >= c.total ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{c.approved}/{c.total} done{c.total - c.approved > 0 ? ` · ${c.total - c.approved} pending` : ''}</span></div>
              <div className="space-y-1">
                {c.steps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${s.status === 'APPROVED' || s.status === 'SKIPPED' ? 'bg-green-100 text-green-700' : s.status === 'PENDING' ? 'bg-amber-100 text-amber-700' : s.status === 'ON_HOLD' ? 'bg-orange-100 text-orange-700' : 'bg-slate-100 text-slate-400'}`}>{s.status === 'APPROVED' || s.status === 'SKIPPED' ? '✓' : s.status === 'ON_HOLD' ? '⏸' : s.order}</span>
                    <span className="font-medium text-slate-700">{s.name}</span>
                    {s.role && <span className="text-xs text-slate-400">· {s.role}</span>}
                    <span className="ml-auto text-xs text-slate-400">{s.status === 'PENDING' ? 'Pending' : s.status === 'APPROVED' ? `✓ ${s.actedAt ? fmtDate(s.actedAt) : ''}` : s.status}</span>
                  </div>
                ))}
              </div>
              {pending.length > 0 && <div className="mt-1.5 text-xs text-amber-600">⏳ Pending with: <span className="font-medium">{pending.map((s) => s.name).join(', ')}</span></div>}
            </div>
          );
        })()}

        {docs.length > 0 && (
          <div>
            <div className="mb-1 text-xs uppercase text-slate-400">Documents ({docs.length})</div>
            <div className="flex flex-wrap gap-2">
              {docs.map((d, i) => <a key={i} className="btn-outline text-xs" href={d.fileUrl} target="_blank" rel="noreferrer">📎 {d.kind}{d.fileName ? ` · ${d.fileName}` : ''}</a>)}
            </div>
          </div>
        )}

        {e.decisionRemark && <div className={`rounded-lg px-3 py-2 text-sm ${e.status === 'REJECTED' ? 'bg-rose-50 text-rose-800' : 'bg-green-50 text-green-800'}`}>{e.status === 'REJECTED' ? 'Rejected' : 'Accounts'}: “{e.decisionRemark}”{e.decidedBy ? ` — ${e.decidedBy}` : ''}</div>}

        {/* Action trail */}
        {e.trail?.length > 0 && (
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Action trail</div>
            <ol className="space-y-1 text-xs">
              {e.trail.map((t: any, i: number) => (
                <li key={i} className="flex gap-2"><span className="text-slate-400">{fmtDate(t.at)}</span><span className="font-medium text-slate-600">{t.action}</span><span className="text-slate-400">— {t.byName}{t.remark ? ` · “${t.remark}”` : ''}</span></li>
              ))}
            </ol>
          </div>
        )}

        {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}

        {/* Actions */}
        {e.status !== 'VOID' && (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            {(isAccounts || canManage) && (e.status === 'SUBMITTED' || e.status === 'RECORDED' || e.status === 'REJECTED') && (
              <textarea className="input text-sm" rows={2} placeholder="Remark (required to reject; optional otherwise)" value={remark} onChange={(ev) => setRemark(ev.target.value)} />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {isExpense && canManage && (e.status === 'RECORDED' || e.status === 'REJECTED') && (
                <button className="btn-primary text-sm" disabled={act.isPending} onClick={() => act.mutate({ verb: 'submit' })}>Submit to accounts</button>
              )}
              {isExpense && isAccounts && (e.status === 'SUBMITTED' || e.status === 'RECORDED') && (
                <>
                  <button className="btn-primary text-sm" disabled={act.isPending} onClick={() => act.mutate({ verb: 'confirm', body: { remark } })}>✓ Confirm</button>
                  <button className="rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600" disabled={act.isPending || !remark.trim()} onClick={() => act.mutate({ verb: 'reject', body: { remark } })}>Reject &amp; resend</button>
                </>
              )}
              {isAccounts && <button className="btn-danger text-sm" disabled={act.isPending} onClick={() => { if (confirm('Strike off (void) this entry?')) act.mutate({ verb: 'void', body: { remark } }); }}>Strike off (void)</button>}
            </div>
          </div>
        )}

        {/* Comments */}
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Comments</div>
          {(e.comments ?? []).length === 0 ? <div className="text-xs text-slate-400">No comments yet.</div> : (
            <ol className="mb-2 space-y-1 text-xs">{e.comments.map((c: any, i: number) => <li key={i}><span className="font-medium text-slate-600">{c.byName}</span> <span className="text-slate-400">{fmtDate(c.at)}</span>: {c.text}</li>)}</ol>
          )}
          {canManage && (
            <div className="flex gap-2">
              <input className="input text-sm" placeholder="Add a comment…" value={comment} onChange={(ev) => setComment(ev.target.value)} />
              <button className="btn-outline text-sm" disabled={!comment.trim() || act.isPending} onClick={() => act.mutate({ verb: 'comment', body: { text: comment } })}>Add</button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, v }: { label: string; v: any }) {
  return <div><span className="text-[11px] uppercase text-slate-400">{label}</span><div className="font-medium text-slate-700">{v}</div></div>;
}
