import { useEffect, useMemo, useState, type ReactNode, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Spinner } from '../components/ui';
import { fmtDate, inr } from '../lib/format';

// ── Travel Planning & Booking ────────────────────────────────────────────────
// One connected flow per trip: request → approval (Approval Chains: docType
// 'Travel Request') → booking → expense upload → expense approval (docType
// 'Travel Expense') → the employee is notified + can download the approval PDF.
// Approvers are whoever the "Approval Chains" config lists for those two types.

type Employee = { id: string; name: string; email: string | null; mLevel: string | null; whatsapp: string | null };
type Advance = { amount: number; fileUrl?: string | null };
type ExpenseItem = { date?: string | null; details: string; paymentMode: 'Online' | 'Cash'; amount: number; supportingUrl?: string | null };

const PLAN_PILL: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600',
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  SUBMITTED: 'bg-amber-100 text-amber-700',
  APPROVED: 'bg-green-100 text-green-700',
  ON_HOLD: 'bg-orange-100 text-orange-700',
  CLOSED: 'bg-rose-100 text-rose-600',
};
const planLabel = (s: string) => (s === 'ON_HOLD' ? 'On Hold' : s === 'SUBMITTED' ? 'Awaiting approval' : s.charAt(0) + s.slice(1).toLowerCase());
const BOOK_PILL: Record<string, string> = { NOT_BOOKED: 'bg-slate-100 text-slate-500', BOOKED: 'bg-emerald-100 text-emerald-700', CANCELLED: 'bg-rose-100 text-rose-600' };

async function uploadFile(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  return (await api.post('/travel/upload', fd)).data.fileUrl as string;
}

// Upload an Aadhaar card and auto-read its number (best-effort).
async function uploadAadhar(file: File): Promise<{ fileUrl: string; aadhaar: string | null; note?: string }> {
  const fd = new FormData();
  fd.append('file', file);
  return (await api.post('/travel/upload-aadhar', fd)).data;
}

// Readable original filename from an /uploads/<ts>-<rand>-<name> url.
const fileNameFromUrl = (u?: string) => (u ? decodeURIComponent((u.split('/').pop() || '').replace(/^\d+-\d+-/, '')) : '');

// Small inline "attach a bill" paperclip: upload → 📎¹ → click opens a popover with
// the file (open ↗ / remove ✕), like the reference.
function CellAttach({ url, title, onUpload, onClear }: { url?: string; title: string; onUpload: (url: string) => void; onClear?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget; const f = input.files?.[0]; if (!f) return;
    setBusy(true);
    try { const u = await uploadFile(f); onUpload(u); }
    catch (err) { alert('Attach failed: ' + errMsg(err)); }
    finally { setBusy(false); try { input.value = ''; } catch { /* ignore */ } }
  };
  if (busy) return <span className="shrink-0 text-xs text-amber-500" title="Uploading…">⏳</span>;
  if (url) {
    return (
      <span className="relative inline-flex shrink-0 items-center leading-none">
        <button type="button" className="inline-flex items-center gap-0.5 hover:opacity-80" onClick={() => setMenu((v) => !v)} title="View attachment"><span className="text-sm text-blue-600">📎</span><span className="text-sm font-bold text-blue-700">1</span></button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute left-0 top-full z-20 mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 text-left shadow-lg">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
              <div className="mt-1 flex items-center gap-2">
                <a href={url} target="_blank" rel="noreferrer" className="flex-1 truncate text-xs font-medium text-navy hover:underline" title={fileNameFromUrl(url)}>↗ {fileNameFromUrl(url) || 'View file'}</a>
                {onClear && <button type="button" className="rounded px-1 text-xs text-rose-500 hover:bg-rose-50 hover:text-rose-700" title="Remove" onClick={() => { onClear(); setMenu(false); }}>✕</button>}
              </div>
              <label className="mt-1 block cursor-pointer text-[11px] text-slate-500 hover:text-navy">
                ↻ Replace file
                <input type="file" className="hidden" accept="image/*,.pdf" onChange={(e) => { setMenu(false); pick(e); }} />
              </label>
            </div>
          </>
        )}
      </span>
    );
  }
  return (
    <label className="shrink-0 cursor-pointer text-xs leading-none" title={title}>
      <span className="text-slate-400 hover:text-navy">📎</span>
      <input type="file" className="hidden" accept="image/*,.pdf" onChange={pick} />
    </label>
  );
}

export default function TravelPlanningPage() {
  const { canEdit } = useAuth();
  const canManage = canEdit('travel');
  const [tab, setTab] = useState<'plan' | 'planhist' | 'ticket' | 'tech' | 'approvals' | 'accounts'>('planhist');
  const tabCls = (t: string) => `rounded-lg px-4 py-1.5 font-medium ${tab === t ? 'bg-navy text-white' : 'text-slate-600'}`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-navy">Travel Planning &amp; Booking</h1>
        <p className="text-sm text-slate-500">Who is travelling, what we sanctioned, and what it actually cost — request → approval → booking → expenses.</p>
      </div>
      <div className="mb-4 flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 text-sm w-fit">
        {canManage && <button onClick={() => setTab('plan')} className={tabCls('plan')}>+ New plan</button>}
        <button onClick={() => setTab('planhist')} className={tabCls('planhist')}>Plan history</button>
        <button onClick={() => setTab('ticket')} className={tabCls('ticket')}>✈ Ticket request</button>
        <button onClick={() => setTab('tech')} className={tabCls('tech')}>📝 Tech entry</button>
        <button onClick={() => setTab('approvals')} className={tabCls('approvals')}>✅ Approvals</button>
        <button onClick={() => setTab('accounts')} className={tabCls('accounts')}>💳 Accounts</button>
      </div>
      {tab === 'plan' && canManage ? <NewSanctionTab onDone={() => setTab('planhist')} />
        : tab === 'ticket' ? <TicketRequestTab canManage={canManage} />
        : tab === 'tech' ? <TechEntryTab canManage={canManage} />
        : tab === 'approvals' ? <ApprovalsTab canManage={canManage} />
        : tab === 'accounts' ? <AccountsTab canManage={canManage} />
        : <HistoryTab kind="PLAN" canManage={canManage} />}
    </div>
  );
}

// Ticket request grouping: New request + Request history (their own list), like the
// reference "Ticket request" tab.
function TicketRequestTab({ canManage }: { canManage: boolean }) {
  const [sub, setSub] = useState<'new' | 'hist'>(canManage ? 'new' : 'hist');
  const subCls = (t: string) => `border-b-2 px-3 py-1.5 text-sm font-medium ${sub === t ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`;
  return (
    <div>
      <div className="mb-4 flex gap-2 border-b border-slate-200">
        {canManage && <button onClick={() => setSub('new')} className={subCls('new')}>New request</button>}
        <button onClick={() => setSub('hist')} className={subCls('hist')}>Request history</button>
      </div>
      {sub === 'new' && canManage ? <NewPlanTab onDone={() => setSub('hist')} /> : <HistoryTab kind="REQUEST" canManage={canManage} />}
    </div>
  );
}

// ── Tech entry: file day-wise ACTUAL spend for CLOSED plans (Spare-AI style) ──
type ActualDay = { day: number; date: string; bus: number; auto: number; food: number; hotel: number; other: number; misc: number; notes: string };
const CATS = ['bus', 'auto', 'food', 'hotel', 'other', 'misc'] as const;
const CAT_LABEL: Record<string, string> = { bus: 'Bus', auto: 'Auto', food: 'Food', hotel: 'Hotel', other: 'Other', misc: 'Misc' };
function buildActuals(days: number, fromDate: string, prev: ActualDay[]): ActualDay[] {
  const out: ActualDay[] = [];
  for (let i = 0; i < days; i++) {
    const p = prev[i];
    const d = new Date(fromDate); d.setDate(d.getDate() + i);
    out.push(p ? { ...p, day: i + 1, date: p.date || d.toISOString().slice(0, 10) } : { day: i + 1, date: d.toISOString().slice(0, 10), bus: 0, auto: 0, food: 0, hotel: 0, other: 0, misc: 0, notes: '' });
  }
  return out;
}
const dayActualTotal = (d: ActualDay) => (+d.bus || 0) + (+d.auto || 0) + (+d.food || 0) + (+d.hotel || 0) + (+d.other || 0) + (+d.misc || 0);
const techLabel = (s?: string) => (s === 'SUBMITTED' ? 'Submitted' : s === 'APPROVED' ? 'Approved' : 'Expenses not filed');
const techPill = (s?: string) => (s === 'SUBMITTED' ? 'bg-blue-100 text-blue-700' : s === 'APPROVED' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700');

function TechEntryTab({ canManage }: { canManage: boolean }) {
  const plansQ = useQuery({ queryKey: ['travel-plans', 'PLAN'], queryFn: async () => (await api.get('/travel?kind=PLAN')).data.plans as any[] });
  const [open, setOpen] = useState<string | null>(null);
  const [tech, setTech] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  if (plansQ.isLoading) return <Spinner label="Loading closed trips…" />;
  const allClosed = (plansQ.data ?? []).filter((p) => p.status === 'CLOSED');
  const closed = allClosed.filter((p) => {
    if (tech && p.employeeName !== tech) return false;
    const d = new Date(p.fromDate);
    if (month !== '' && d.getMonth() !== Number(month)) return false;
    if (year !== '' && d.getFullYear() !== Number(year)) return false;
    return true;
  });
  const techs = [...new Set(allClosed.map((p) => p.employeeName))];
  const years = [...new Set(allClosed.map((p) => new Date(p.fromDate).getFullYear()).filter(Boolean))].sort((a, b) => b - a);
  const filed = closed.filter((p) => p.techEntryStatus === 'SUBMITTED' || p.techEntryStatus === 'APPROVED').length;

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div><div className="font-semibold text-navy">Closed trips — file your expenses</div><div className="text-xs text-slate-400">What did each finished trip actually cost, and where is it in review?</div></div>
        <div className="flex items-center gap-2 text-xs">
          <select className="input h-8 text-xs" value={month} onChange={(e) => setMonth(e.target.value)}><option value="">All months</option>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
          <select className="input h-8 text-xs" value={year} onChange={(e) => setYear(e.target.value)}><option value="">All years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
          <select className="input h-8 text-xs" value={tech} onChange={(e) => setTech(e.target.value)}><option value="">All technicians</option>{techs.map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <span className="text-slate-400">{closed.length} trip(s) · {filed} submission(s)</span>
        </div>
      </div>
      {closed.length === 0 ? <div className="px-4 py-8 text-center text-sm text-slate-400">No closed trips yet. Close a plan from <span className="font-medium">Plan history</span> to file its expenses.</div> : (
        <div className="divide-y divide-slate-100">
          {closed.map((p) => (
            <div key={p.id}>
              <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <span className="text-slate-400">{open === p.id ? '▾' : '▸'}</span>
                <span className="font-medium text-navy">{p.planNumber}</span>
                <span className="text-sm text-slate-500">· {p.employeeName} · {fmtDate(p.fromDate)} → {fmtDate(p.toDate)} <span className="text-xs">({p.days}d · {(p.jobOrders ?? []).filter((j: any) => j.jo).length} projects)</span></span>
                <span className="badge ml-1 bg-slate-200 text-slate-600">CLOSED</span>
                <span className="ml-auto flex items-center gap-2 text-xs">
                  <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">Adv {inr(p.totalAdvance || 0)}</span>
                  {(() => { const spent = (p.actualDayCosts || []).reduce((s: number, d: any) => s + dayActualTotal(d), 0); return spent > 0 ? <span className="font-medium text-slate-700">Spent {inr(spent)}</span> : null; })()}
                  <span className={`badge ${techPill(p.techEntryStatus)}`}>{techLabel(p.techEntryStatus)}</span>
                </span>
              </button>
              {open === p.id && <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3"><TechEntryEditor plan={p} canManage={canManage} onDone={() => { setOpen(null); plansQ.refetch(); }} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TechEntryEditor({ plan, canManage, onDone }: { plan: any; canManage: boolean; onDone: () => void }) {
  const readOnly = !canManage || plan.techEntryStatus === 'APPROVED';
  const pc = plan.planCosts || {};
  const from = plan.fromDate ? new Date(plan.fromDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const [rows, setRows] = useState<ActualDay[]>(() => plan.actualDayCosts?.length ? plan.actualDayCosts.map((d: any, i: number) => ({ day: i + 1, date: d.date || '', bus: +d.bus || 0, auto: +d.auto || 0, food: +d.food || 0, hotel: +d.hotel || 0, other: +d.other || 0, misc: +d.misc || 0, notes: d.notes || '' })) : buildActuals(plan.days || 1, from, []));
  const [notes, setNotes] = useState(plan.techEntryNotes || '');
  const [atts, setAtts] = useState<Record<string, string>>(() => { const m: Record<string, string> = {}; (plan.techAttachments || []).forEach((a: any) => { m[`${a.day}:${a.category}`] = a.fileUrl; }); return m; });
  const [err, setErr] = useState('');
  const set = (i: number, patch: Partial<ActualDay>) => setRows(rows.map((d, j) => j === i ? { ...d, ...patch } : d));

  const act = { travel: rows.reduce((s, d) => s + (+d.bus || 0) + (+d.auto || 0), 0), food: rows.reduce((s, d) => s + (+d.food || 0), 0), hotel: rows.reduce((s, d) => s + (+d.hotel || 0), 0), other: rows.reduce((s, d) => s + (+d.other || 0) + (+d.misc || 0), 0) };
  const actGrand = act.travel + act.food + act.hotel + act.other;
  const planGrand = (+pc.travel || 0) + (+pc.food || 0) + (+pc.hotel || 0) + (+pc.other || 0);
  const advReceived = plan.totalAdvance || 0;
  const balance = advReceived - actGrand;
  const m0 = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      const attachments = Object.entries(atts).filter(([, v]) => v).map(([k, fileUrl]) => { const [day, category] = k.split(':'); return { day: Number(day), category, fileUrl }; });
      return api.post(`/travel/${plan.id}/tech-entry`, { actualDayCosts: rows, notes, attachments, submit });
    },
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });

  const pvA = (label: string, planV: number, actV: number) => (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5"><div className="text-[10px] uppercase text-slate-400">{label}</div><div className="text-xs text-slate-500">Plan: <span className="font-medium">{m0(planV)}</span></div><div className="text-xs text-slate-500">Act: <span className="font-medium">{m0(actV)}</span></div><div className={`text-xs font-semibold ${actV - planV > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{actV - planV >= 0 ? '+' : ''}{m0(actV - planV)}</div></div>
  );

  return (
    <div className="space-y-4">
      {err && <div className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {/* Plan vs Actual */}
      <div><div className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Plan vs actual</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{pvA('Travel', +pc.travel || 0, act.travel)}{pvA('Food', +pc.food || 0, act.food)}{pvA('Hotel', +pc.hotel || 0, act.hotel)}{pvA('Other', +pc.other || 0, act.other)}<div className="rounded-lg border border-navy/20 bg-navy/5 p-2.5"><div className="text-[10px] uppercase text-navy/60">Grand</div><div className="text-xs">Plan: <span className="font-medium">{m0(planGrand)}</span></div><div className="text-xs">Act: <span className="font-bold text-navy">{m0(actGrand)}</span></div></div></div>
      </div>

      {/* Day-wise actual grid */}
      <fieldset disabled={readOnly}>
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm">
        <thead className="text-left text-[10px] uppercase text-slate-400"><tr><th className="py-1">Day</th><th>Date</th>{CATS.map((c) => <th key={c} className="text-right">{CAT_LABEL[c]}</th>)}<th>Notes</th><th className="text-right pr-2">Total</th></tr></thead>
        <tbody>
          {rows.map((d, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="py-1 font-medium text-slate-600">Day {d.day}</td>
              <td className="text-xs text-slate-500">{d.date}</td>
              {CATS.map((c) => { const key = `${d.day}:${c}`; return (
                <td key={c} className="pr-1">
                  <div className="flex items-center gap-1">
                    <input type="number" min={0} className="input h-8 w-14 text-right text-xs" value={(d[c] as number) || ''} onChange={(e) => set(i, { [c]: Number(e.target.value) } as any)} placeholder="0" />
                    <CellAttach url={atts[key]} title={`${CAT_LABEL[c]} · Day ${d.day}`} onUpload={(u) => setAtts((m) => ({ ...m, [key]: u }))} onClear={() => setAtts((m) => { const n = { ...m }; delete n[key]; return n; })} />
                  </div>
                </td>
              ); })}
              <td className="pr-2"><input className="input h-8 text-xs" value={d.notes} onChange={(e) => set(i, { notes: e.target.value })} placeholder="—" /></td>
              <td className="pr-2 text-right font-medium">{m0(dayActualTotal(d))}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-navy"><td colSpan={2} className="py-2">Total</td>{CATS.map((c) => <td key={c} className="text-right">{m0(rows.reduce((s, d) => s + (+d[c] || 0), 0))}</td>)}<td></td><td className="pr-2 text-right">{m0(actGrand)}</td></tr>
        </tbody>
      </table></div>
      <textarea className="input mt-2 min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Trip-level notes (optional)" />
      </fieldset>

      {/* Advance reconciliation */}
      <div><div className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Advance reconciliation</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-2.5"><div className="text-xs text-blue-700">Advance received</div><div className="text-lg font-bold text-blue-800">{m0(advReceived)}</div></div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5"><div className="text-xs text-slate-600">Actual spent</div><div className="text-lg font-bold text-slate-700">{m0(actGrand)}</div></div>
          <div className={`rounded-lg border p-2.5 ${balance < 0 ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50'}`}><div className="text-xs text-amber-700">Balance</div><div className="text-lg font-bold text-amber-800">{m0(Math.abs(balance))}</div><div className="text-[10px] text-amber-500">{balance < 0 ? 'reimburse to tech' : 'due back to company'}</div></div>
          <div className="rounded-lg border border-slate-200 bg-white p-2.5"><div className="text-xs text-slate-500">Status</div><div className="text-lg font-bold text-slate-700">{techLabel(plan.techEntryStatus)}</div></div>
        </div>
        {/* Advance source breakdown (from the trip plan). */}
        <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-[10px] uppercase text-slate-400"><tr><th className="px-3 py-1.5">Advance source</th><th className="px-3 py-1.5 text-right">Amount</th><th className="px-3 py-1.5 text-right">Proof</th></tr></thead>
            <tbody>
              {[0, 1, 2, 3, 4].map((i) => { const a = (plan.advances || [])[i] || {}; return (
                <tr key={i} className="border-t border-slate-100"><td className="px-3 py-1.5 text-slate-600">Advance {i + 1}</td><td className="px-3 py-1.5 text-right font-medium">{m0(+a.amount || 0)}</td><td className="px-3 py-1.5 text-right">{a.fileUrl ? <a href={a.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-navy hover:underline">View</a> : <span className="text-xs text-slate-300">—</span>}</td></tr>
              ); })}
            </tbody>
          </table>
        </div>
      </div>

      {!readOnly && (
        <div className="flex gap-2">
          <button className="btn-outline" disabled={save.isPending} onClick={() => save.mutate(false)}>Save draft</button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>✈ {plan.techEntryStatus === 'SUBMITTED' ? 'Resubmit' : 'Submit'}</button>
        </div>
      )}
    </div>
  );
}

// ── Approvals: manager review of a submitted tech entry ──────────────────────
const submittedTotals = (rows: any[]) => rows.reduce((a, d) => ({ travel: a.travel + (+d.bus || 0) + (+d.auto || 0), food: a.food + (+d.food || 0), hotel: a.hotel + (+d.hotel || 0), other: a.other + (+d.other || 0), misc: a.misc + (+d.misc || 0) }), { travel: 0, food: 0, hotel: 0, other: 0, misc: 0 });
const catGrand = (t: any) => (+t.travel || 0) + (+t.food || 0) + (+t.hotel || 0) + (+t.other || 0) + (+t.misc || 0);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ApprovalsTab({ canManage }: { canManage: boolean }) {
  const plansQ = useQuery({ queryKey: ['travel-plans', 'PLAN'], queryFn: async () => (await api.get('/travel?kind=PLAN')).data.plans as any[] });
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [month, setMonth] = useState<string>(''); // '' = all
  const [year, setYear] = useState<string>('');
  if (plansQ.isLoading) return <Spinner label="Loading…" />;
  const all = (plansQ.data ?? []).filter((p) => ['SUBMITTED', 'APPROVED', 'REJECTED'].includes(p.techEntryStatus));
  const years = [...new Set(all.map((p) => new Date(p.fromDate).getFullYear()).filter(Boolean))].sort((a, b) => b - a);
  const rows = all.filter((p) => {
    if (status && p.techEntryStatus !== status) return false;
    const d = new Date(p.fromDate);
    if (month !== '' && d.getMonth() !== Number(month)) return false;
    if (year !== '' && d.getFullYear() !== Number(year)) return false;
    return true;
  });

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div><div className="font-semibold text-navy">Submitted expenses — awaiting a decision</div><div className="text-xs text-slate-400">What did each technician claim, and who still has to sign it off?</div></div>
        <div className="flex items-center gap-2 text-xs">
          <select className="input h-8 text-xs" value={month} onChange={(e) => setMonth(e.target.value)}><option value="">All months</option>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select>
          <select className="input h-8 text-xs" value={year} onChange={(e) => setYear(e.target.value)}><option value="">All years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
          <select className="input h-8 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="SUBMITTED">Awaiting decision</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select>
          <span className="text-slate-400">{rows.length} entry(s)</span>
        </div>
      </div>
      {rows.length === 0 ? <div className="px-4 py-8 text-center text-sm text-slate-400">No submitted expenses. They appear here once a technician submits from <span className="font-medium">Tech entry</span>.</div> : (
        <div className="divide-y divide-slate-100">
          {rows.map((p) => { const sub = submittedTotals(p.actualDayCosts || []); const appr = p.techApproved ? catGrand(p.techApproved) : null;
            return (
            <div key={p.id}>
              <button className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <span className="text-slate-400">{open === p.id ? '▾' : '▸'}</span>
                <span className="font-medium text-navy">{p.planNumber}</span>
                <span className="text-sm text-slate-600">· {p.employeeName}</span>
                <span className="ml-auto flex items-center gap-3 text-xs">
                  <span>Submitted <span className="font-semibold">{inr(catGrand(sub))}</span></span>
                  {appr != null && <span className="text-green-700">Approved <span className="font-semibold">{inr(appr)}</span></span>}
                  <span className={`badge ${p.techEntryStatus === 'APPROVED' ? 'bg-green-100 text-green-700' : p.techEntryStatus === 'REJECTED' ? 'bg-rose-100 text-rose-600' : 'bg-amber-100 text-amber-700'}`}>{p.techEntryStatus === 'SUBMITTED' ? 'Awaiting decision' : p.techEntryStatus.charAt(0) + p.techEntryStatus.slice(1).toLowerCase()}</span>
                </span>
              </button>
              {open === p.id && <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3"><ApprovalReviewEditor plan={p} canManage={canManage} onDone={() => { setOpen(null); plansQ.refetch(); }} /></div>}
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}

type StageCats = { travel: number; food: number; hotel: number; other: number; misc: number };
const APPR_CATS = ['travel', 'food', 'hotel', 'other', 'misc'] as const;
const APPR_LABEL: Record<string, string> = { travel: 'Travel', food: 'Food', hotel: 'Hotel', other: 'Other', misc: 'Misc' };
const techDayVals = (d: any): StageCats => ({ travel: (+d.bus || 0) + (+d.auto || 0), food: +d.food || 0, hotel: +d.hotel || 0, other: +d.other || 0, misc: +d.misc || 0 });
const catSum = (days: any[]): StageCats => days.reduce((a: StageCats, d: any) => ({ travel: a.travel + (+d.travel || 0), food: a.food + (+d.food || 0), hotel: a.hotel + (+d.hotel || 0), other: a.other + (+d.other || 0), misc: a.misc + (+d.misc || 0) }), { travel: 0, food: 0, hotel: 0, other: 0, misc: 0 });

function ApprovalReviewEditor({ plan, canManage, onDone }: { plan: any; canManage: boolean; onDone: () => void }) {
  const rows: any[] = plan.actualDayCosts || [];
  const planDays: any[] = plan.planDayCosts || [];
  const s1 = plan.techStage1; const s2 = plan.techStage2;
  const decided = plan.techEntryStatus === 'APPROVED' || plan.techEntryStatus === 'REJECTED';
  const stage1Done = !!s1 && s1.status === 'APPROVED';
  const currentStage: 1 | 2 | null = decided ? null : (stage1Done ? 2 : 1);
  const readOnly = !canManage || currentStage == null;
  const m0 = (n: any) => `₹${Math.round(+n || 0).toLocaleString('en-IN')}`;
  const atts: any[] = plan.techAttachments || [];
  const [comment, setComment] = useState('');
  const [verdict, setVerdict] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [err, setErr] = useState('');

  // The editable stage's per-day amounts. Stage 1 starts from the technician's
  // submitted figures; the Final stage starts from Stage-1's approved figures.
  const initDays = useMemo(() => {
    const base = currentStage === 2 ? (s2?.days ?? s1?.days ?? []) : (s1?.days ?? []);
    return rows.map((d: any, i: number) => { const t = techDayVals(d); const b = base[i] || {}; return { day: i + 1, travel: b.travel ?? t.travel, food: b.food ?? t.food, hotel: b.hotel ?? t.hotel, other: b.other ?? t.other, misc: b.misc ?? t.misc, remark: b.remark ?? '' }; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [days, setDays] = useState<any[]>(initDays);
  // Per-category override the reviewer can type (Spare-AI "override per category").
  // Auto-tracks the grid sum until the reviewer edits it directly.
  const [override, setOverride] = useState<StageCats>(() => (currentStage === 1 && s1?.totals) || (currentStage === 2 && s2?.totals) || catSum(initDays));
  const [ovTouched, setOvTouched] = useState(false);
  const setCell = (i: number, c: string, v: number) => { const nd = days.map((d, j) => j === i ? { ...d, [c]: v } : d); setDays(nd); if (!ovTouched) setOverride(catSum(nd)); };
  const setRemark = (i: number, v: string) => setDays(days.map((d, j) => j === i ? { ...d, remark: v } : d));

  const advDay = (i: number): StageCats => { const p = planDays[i] || {}; return { travel: +p.travel || 0, food: +p.food || 0, hotel: +p.hotel || 0, other: +p.other || 0, misc: 0 }; };
  const s1Cell = (i: number, c: string): number | null => stage1Done ? (s1.days?.[i]?.[c] ?? 0) : (currentStage === 1 ? (days[i]?.[c] ?? 0) : null);
  const s2Cell = (i: number, c: string): number | null => currentStage === 2 ? (days[i]?.[c] ?? 0) : (s2 ? (s2.days?.[i]?.[c] ?? 0) : null);

  const advReceived = plan.totalAdvance || 0;
  const techSum = catSum(rows.map(techDayVals));
  const s1Sum = stage1Done ? (s1.totals ?? catSum(s1.days || [])) : (currentStage === 1 ? override : null);
  const finalSum = currentStage === 2 ? override : (s2 ? (s2.totals ?? catSum(s2.days || [])) : null);
  const finalGrand = finalSum ? catGrand(finalSum) : (s1Sum ? catGrand(s1Sum) : catGrand(techSum));

  const decide = useMutation({
    mutationFn: async () => api.post(`/travel/${plan.id}/tech-stage-decide`, { stage: currentStage, status: verdict, days: verdict === 'APPROVED' ? days : [], totals: verdict === 'APPROVED' ? override : undefined, comment }),
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });

  const stageLabel = (n: number) => (n === 1 ? 'Reviewer' : 'Final');
  const chainBadge = (done: boolean, pending: boolean) => (done ? <span className="rounded bg-green-100 px-1.5 text-[10px] text-green-700">Approved</span> : pending ? <span className="rounded bg-amber-100 px-1.5 text-[10px] text-amber-700">Pending</span> : <span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-500">Waiting</span>);

  const CatCell = ({ i, c }: { i: number; c: string }) => {
    const adv = advDay(i)[c as keyof StageCats]; const tech = techDayVals(rows[i])[c as keyof StageCats];
    const s1v = s1Cell(i, c); const s2v = s2Cell(i, c);
    const editRow = currentStage; // 1 → edit Reviewer row, 2 → edit Final row
    const inp = (val: number) => <input type="number" min={0} className="w-14 rounded border border-amber-300 bg-amber-50 px-1 text-right text-[10px]" value={val || ''} onChange={(e) => setCell(i, c, Number(e.target.value))} placeholder="0" />;
    return (
      <div className="rounded border border-slate-200 bg-white p-1 text-[10px]">
        <div className="flex justify-between text-slate-400"><span>ADV</span><span>{m0(adv)}</span></div>
        <div className="flex justify-between text-blue-600"><span>TECH</span><span>{m0(tech)}</span></div>
        <div className="flex items-center justify-between text-green-600"><span>REV</span><span>{editRow === 1 && !readOnly ? inp(days[i]?.[c] || 0) : (s1v == null ? '—' : m0(s1v))}</span></div>
        <div className="flex items-center justify-between text-amber-700"><span>FINAL</span><span>{editRow === 2 && !readOnly ? inp(days[i]?.[c] || 0) : (s2v == null ? '—' : m0(s2v))}</span></div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {err && <div className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      <div className="text-xs text-slate-500">Submitted {plan.techEntrySubmittedAt ? fmtDate(plan.techEntrySubmittedAt) : ''} · {plan.days} day(s)</div>

      {/* Advance reconciliation */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-2.5"><div className="text-xs text-blue-700">Advance received</div><div className="text-lg font-bold text-blue-800">{m0(advReceived)}</div></div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5"><div className="text-xs text-slate-600">Actual spent</div><div className="text-lg font-bold text-slate-700">{m0(catGrand(techSum))}</div></div>
        <div className={`rounded-lg border p-2.5 ${advReceived - finalGrand < 0 ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50'}`}><div className="text-xs text-amber-700">Balance</div><div className="text-lg font-bold text-amber-800">{m0(Math.abs(advReceived - finalGrand))}</div><div className="text-[10px] text-amber-500">{advReceived - finalGrand < 0 ? 'owed to tech' : 'due back'}</div></div>
        <div className="rounded-lg border border-slate-200 bg-white p-2.5"><div className="text-xs text-slate-500">Status</div><div className="text-base font-bold text-slate-700">{decided ? (plan.techEntryStatus === 'APPROVED' ? 'Approved' : 'Rejected') : stage1Done ? 'Awaiting Final' : 'Open'}</div></div>
      </div>

      {/* Day-wise 2-stage approval grid */}
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div className="text-xs font-semibold text-navy">Day-wise approval · each cell shows Advance / Technician / Reviewer / Final</div>{currentStage && <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">You are editing the {stageLabel(currentStage)} row</span>}</div>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm">
          <thead className="text-left text-[10px] uppercase text-slate-400"><tr><th className="py-1">Day</th>{APPR_CATS.map((c) => <th key={c}>{APPR_LABEL[c]}</th>)}<th>Day total</th></tr></thead>
          <tbody>
            {rows.map((d: any, i: number) => (
              <tr key={i} className="border-t border-slate-100 align-top">
                <td className="py-1 pr-2">
                  <div className="font-medium text-slate-600">Day {d.day}</div>
                  <div className="text-[10px] text-slate-400">{d.date}</div>
                  {d.notes && <div className="mt-0.5 max-w-[150px] text-[10px] text-slate-400">{d.notes}</div>}
                  {currentStage && !readOnly && <input className="input mt-1 h-7 text-[10px]" placeholder={`${stageLabel(currentStage)}'s remark for Day ${d.day}…`} value={days[i]?.remark || ''} onChange={(e) => setRemark(i, e.target.value)} />}
                </td>
                {APPR_CATS.map((c) => <td key={c} className="pr-1"><CatCell i={i} c={c} /></td>)}
                <td className="pr-1">{(() => {
                  const rev = (stage1Done || currentStage === 1) ? APPR_CATS.reduce((s, c) => s + (s1Cell(i, c) ?? 0), 0) : null;
                  const fin = (currentStage === 2 || !!s2) ? APPR_CATS.reduce((s, c) => s + (s2Cell(i, c) ?? 0), 0) : null;
                  return (
                    <div className="rounded border border-slate-200 bg-slate-50 p-1 text-[10px] font-semibold">
                      <div className="flex justify-between text-slate-400"><span>ADV</span><span>{m0(catGrand(advDay(i)))}</span></div>
                      <div className="flex justify-between text-blue-600"><span>TECH</span><span>{m0(catGrand(techDayVals(d)))}</span></div>
                      <div className="flex justify-between text-green-600"><span>REV</span><span>{rev == null ? '—' : m0(rev)}</span></div>
                      <div className="flex justify-between text-amber-700"><span>FINAL</span><span>{fin == null ? '—' : m0(fin)}</span></div>
                    </div>
                  );
                })()}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-navy"><td className="py-2">Total</td>{APPR_CATS.map((c) => <td key={c} className="text-[10px]"><div>ADV {m0(rows.reduce((s: number, _d: any, i: number) => s + advDay(i)[c], 0))}</div><div className="text-blue-600">TECH {m0(techSum[c])}</div><div className="text-green-600">REV {s1Sum ? m0(s1Sum[c]) : '—'}</div><div className="text-amber-700">FINAL {finalSum ? m0(finalSum[c]) : '—'}</div></td>)}<td></td></tr>
          </tbody>
        </table></div>
      </div>

      {/* Bills & proofs */}
      {atts.length > 0 && (
        <div><div className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Bills &amp; proofs ({atts.length}) · click to view</div>
          <div className="flex flex-wrap gap-2">{atts.map((a, i) => (<a key={i} href={a.fileUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] text-slate-500 hover:bg-slate-50" title={fileNameFromUrl(a.fileUrl)}>🧾 {CAT_LABEL[a.category] || a.category} · Day {a.day}</a>))}</div>
        </div>
      )}

      {/* Approval chain */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
        <span className="font-semibold text-slate-500">Approval chain:</span>
        <span>1. Reviewer {chainBadge(stage1Done, currentStage === 1)}{stage1Done && s1Sum ? ` ${m0(catGrand(s1Sum))}` : ''}</span>
        <span className="text-slate-300">→</span>
        <span>2. Final {chainBadge(plan.techEntryStatus === 'APPROVED', currentStage === 2)}</span>
        {!decided && <span className="ml-auto font-medium text-amber-600">{stage1Done ? 'Awaiting Final' : 'Awaiting Reviewer'}</span>}
      </div>

      {/* Stage breakdown + decision */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <div className="bg-slate-50 px-3 py-1.5 text-[10px] font-semibold uppercase text-slate-400">Stage breakdown · per category</div>
          <table className="w-full text-sm"><thead className="text-left text-[10px] uppercase text-slate-400"><tr><th className="px-3 py-1">Category</th><th className="px-3 py-1 text-right">Submitted</th><th className="px-3 py-1 text-right">Reviewer</th><th className="px-3 py-1 text-right">Final</th></tr></thead>
            <tbody>{APPR_CATS.map((c) => (<tr key={c} className="border-t border-slate-100"><td className="px-3 py-1 capitalize text-slate-600">{c}</td><td className="px-3 py-1 text-right">{m0(techSum[c])}</td><td className="px-3 py-1 text-right text-green-700">{s1Sum ? m0(s1Sum[c]) : '—'}</td><td className="px-3 py-1 text-right text-amber-700">{finalSum ? m0(finalSum[c]) : '—'}</td></tr>))}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-navy"><td className="px-3 py-1.5">Total</td><td className="px-3 py-1.5 text-right">{m0(catGrand(techSum))}</td><td className="px-3 py-1.5 text-right">{s1Sum ? m0(catGrand(s1Sum)) : '—'}</td><td className="px-3 py-1.5 text-right">{finalSum ? m0(catGrand(finalSum)) : '—'}</td></tr>
            </tbody></table>
        </div>
        <div className={`rounded-lg border p-3 ${readOnly ? 'border-slate-200 bg-slate-50' : 'border-amber-300 bg-amber-50'}`}>
          <div className="mb-2 text-xs font-semibold text-amber-800">{decided ? 'Approved rate (final)' : `Your ${currentStage ? stageLabel(currentStage) : ''} rate — override per category`}</div>
          <div className="space-y-1.5 text-sm">{APPR_CATS.map((c) => (
            <div key={c} className="flex items-center justify-between gap-2">
              <span className="text-slate-600">{APPR_LABEL[c]}</span>
              {readOnly
                ? <span className="font-medium">{m0((finalSum || s1Sum || techSum)[c])}</span>
                : <input type="number" min={0} className="input h-8 w-28 text-right text-xs" value={override[c] || ''} onChange={(e) => { setOvTouched(true); setOverride({ ...override, [c]: Number(e.target.value) }); }} placeholder="0" />}
            </div>))}
            <div className="flex items-center justify-between border-t border-amber-200 pt-1.5 font-bold text-navy"><span>Total</span><span>{m0(readOnly ? catGrand(finalSum || s1Sum || techSum) : catGrand(override))}</span></div>
          </div>
          <div className="mt-1 text-[10px] text-amber-600">Submitted: {m0(catGrand(techSum))} — edit the grid cells above or override here; your figure is final.</div>
        </div>
      </div>

      {decided ? (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{plan.techEntryStatus === 'APPROVED' ? '✓ Approved' : '✗ Rejected'}{plan.techApprovedBy ? ` by ${plan.techApprovedBy}` : ''}{plan.techApproveComment ? ` — “${plan.techApproveComment}”` : ''}.</div>
      ) : !readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <select className="input h-9 w-44 text-sm" value={verdict} onChange={(e) => setVerdict(e.target.value as any)}><option value="APPROVED">Approve → {currentStage === 1 ? 'send to Final' : 'done'}</option><option value="REJECTED">Reject → back to tech</option></select>
          <input className="input h-9 flex-1" placeholder={verdict === 'REJECTED' ? 'Reason (required)' : 'Comments (optional)'} value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn-primary" disabled={decide.isPending || (verdict === 'REJECTED' && !comment.trim())} onClick={() => decide.mutate()}>{verdict === 'APPROVED' ? `✓ Approve as ${currentStage ? stageLabel(currentStage) : ''}` : '✗ Reject'}</button>
        </div>
      )}
    </div>
  );
}

// ── Accounts: finalise an approved trip (invoice + indent + payment) ─────────
function AccountsTab({ canManage }: { canManage: boolean }) {
  const plansQ = useQuery({ queryKey: ['travel-plans', 'PLAN'], queryFn: async () => (await api.get('/travel?kind=PLAN')).data.plans as any[] });
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'finalized' | 'all'>('pending');
  if (plansQ.isLoading) return <Spinner label="Loading…" />;
  const approved = (plansQ.data ?? []).filter((p) => p.techEntryStatus === 'APPROVED');
  const rows = approved.filter((p) => filter === 'all' || (filter === 'finalized' ? p.accountsFinalized : !p.accountsFinalized));
  const fbtn = (t: string) => `rounded-full px-3 py-0.5 text-xs font-medium ${filter === t ? 'bg-navy text-white' : 'text-slate-500'}`;

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div><div className="font-semibold text-navy">Approved trips — ready to pay</div><div className="text-xs text-slate-400">What has been signed off, and what still needs an invoice?</div></div>
        <div className="flex items-center gap-2 text-xs">
          <div className="flex gap-1 rounded-full bg-slate-100 p-0.5">{(['pending', 'finalized', 'all'] as const).map((t) => <button key={t} className={fbtn(t)} onClick={() => setFilter(t)}>{t}</button>)}</div>
          <span className="text-slate-400">{rows.length} entry(s)</span>
        </div>
      </div>
      {rows.length === 0 ? <div className="px-4 py-8 text-center text-sm text-slate-400">Nothing here. Trips appear once <span className="font-medium">Approvals</span> signs them off.</div> : (
        <div className="divide-y divide-slate-100">
          {rows.map((p) => (
            <div key={p.id}>
              <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <span className="text-slate-400">{open === p.id ? '▾' : '▸'}</span>
                <span className="font-medium text-navy">{p.planNumber}</span>
                <span className="text-sm text-slate-600">· {p.employeeName}</span>
                {p.accountsFinalized && <span className="badge bg-green-100 text-green-700">✓ Processed</span>}
                <span className="ml-auto font-semibold text-navy">{inr(p.techApproved ? catGrand(p.techApproved) : 0)}</span>
              </button>
              {open === p.id && <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-3"><AccountsEditor plan={p} canManage={canManage} onDone={() => { setOpen(null); plansQ.refetch(); }} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ACC_FIELDS: { k: string; label: string; type?: string }[] = [
  { k: 'glCode', label: 'GL Code' }, { k: 'jobType', label: 'Job Type' }, { k: 'indentNo', label: 'Indent No (Final)' }, { k: 'issueNoteNo', label: 'Issue Note No' },
  { k: 'poLink', label: 'PO Link' }, { k: 'invoiceNo', label: 'Invoice No' }, { k: 'invoiceAmount', label: 'Invoice Amount (₹)', type: 'number' }, { k: 'costCenter', label: 'Cost Center' },
  { k: 'gstPct', label: 'GST %', type: 'number' }, { k: 'gstAmt', label: 'GST ₹', type: 'number' }, { k: 'tdsPct', label: 'TDS %', type: 'number' }, { k: 'tdsAmt', label: 'TDS ₹', type: 'number' },
  { k: 'paymentMode', label: 'Payment Mode' }, { k: 'bankRef', label: 'Bank Account Ref' }, { k: 'paymentDate', label: 'Payment Date', type: 'date' }, { k: 'notes', label: 'Notes' },
];

function AccountsEditor({ plan, canManage, onDone }: { plan: any; canManage: boolean; onDone: () => void }) {
  const finalized = !!plan.accountsFinalized;
  const readOnly = !canManage || finalized;
  const m0 = (n: any) => `₹${Math.round(+n || 0).toLocaleString('en-IN')}`;
  const pc = plan.planCosts || {};
  const planGrand = (+pc.travel || 0) + (+pc.food || 0) + (+pc.hotel || 0) + (+pc.other || 0);
  const techGrand = catGrand(submittedTotals(plan.actualDayCosts || []));
  const revGrand = plan.techStage1 ? catGrand(plan.techStage1.totals ?? {}) : null;
  const finalGrand = plan.techApproved ? catGrand(plan.techApproved) : 0;
  const advPaid = plan.totalAdvance || 0;
  const [form, setForm] = useState<any>(() => ({ invoiceAmount: finalGrand, gstPct: 0, gstAmt: 0, tdsPct: 0, tdsAmt: 0, ...(plan.accountsData || {}) }));
  const [err, setErr] = useState('');
  const netPayable = finalGrand + (+form.gstAmt || 0) - (+form.tdsAmt || 0) - advPaid;
  const atts: any[] = plan.techAttachments || [];
  const advs: any[] = (plan.advances || []).filter((a: any) => (+a.amount || 0) > 0 || a.fileUrl);

  const save = useMutation({
    mutationFn: async (finalize: boolean) => api.post(`/travel/${plan.id}/tech-accounts`, { data: form, finalize }),
    onSuccess: onDone, onError: (e) => setErr(errMsg(e)),
  });
  const reopen = useMutation({ mutationFn: async () => api.post(`/travel/${plan.id}/tech-accounts`, { unfinalize: true }), onSuccess: onDone });

  const card = (label: string, val: any, sub: string, cls: string) => (<div className={`rounded-lg border p-2.5 ${cls}`}><div className="text-[11px] text-slate-500">{label}</div><div className="text-lg font-bold">{m0(val)}</div><div className="text-[10px] text-slate-400">{sub}</div></div>);

  return (
    <div className="space-y-4">
      {err && <div className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}
      {/* Money trail */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {card('Plan (sanctioned)', planGrand, 'Budget set when planned', 'border-blue-200 bg-blue-50')}
        {card('Tech entered', techGrand, 'What the technician claimed', 'border-slate-200 bg-slate-50')}
        {card('Reviewer approved', revGrand ?? 0, 'Stage 1 sign-off', 'border-emerald-200 bg-emerald-50')}
        {card('Final', finalGrand, 'Final sign-off — what we pay', 'border-green-200 bg-green-50')}
        {card('Advance paid', advPaid, 'Handed over before the trip', 'border-amber-200 bg-amber-50')}
      </div>

      {/* Net payable */}
      <div className="rounded-lg border border-green-200 bg-green-50/60 p-3">
        <div className="text-[10px] font-semibold uppercase text-green-800">Net payable to the technician</div>
        <div className="mt-0.5 text-sm text-slate-600">{m0(finalGrand)} + GST {m0(form.gstAmt)} − TDS {m0(form.tdsAmt)} − advance already paid <span className="text-amber-700">{m0(advPaid)}</span> = <span className="text-lg font-bold text-navy">{m0(netPayable)}</span></div>
      </div>

      {/* Bills */}
      {(atts.length > 0 || advs.length > 0) && (
        <div className="flex flex-wrap gap-2 text-[10px]">
          {advs.map((a, i) => a.fileUrl && <a key={`a${i}`} href={a.fileUrl} target="_blank" rel="noreferrer" className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 hover:bg-amber-100">💰 Advance {inr(a.amount)}</a>)}
          {atts.map((a, i) => <a key={`t${i}`} href={a.fileUrl} target="_blank" rel="noreferrer" className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-500 hover:bg-slate-50">🧾 {CAT_LABEL[a.category] || a.category} · Day {a.day}</a>)}
        </div>
      )}

      {/* Finalize form */}
      <fieldset disabled={readOnly}>
        <div className="grid gap-2 sm:grid-cols-4">
          {ACC_FIELDS.map((f) => (
            <div key={f.k}><label className="label">{f.label}</label><input type={f.type || 'text'} className="input h-9 text-sm" value={form[f.k] ?? ''} onChange={(e) => setForm({ ...form, [f.k]: f.type === 'number' ? Number(e.target.value) : e.target.value })} /></div>
          ))}
        </div>
      </fieldset>

      {finalized ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          <span>✓ Processed{plan.accountsFinalizedBy ? ` by ${plan.accountsFinalizedBy}` : ''}{plan.accountsFinalizedAt ? ` · ${fmtDate(plan.accountsFinalizedAt)}` : ''}.</span>
          {canManage && <button className="btn-outline text-xs" disabled={reopen.isPending} onClick={() => reopen.mutate()}>↻ Re-open</button>}
        </div>
      ) : !readOnly && (
        <div className="flex gap-2">
          <button className="btn-outline" disabled={save.isPending} onClick={() => save.mutate(false)}>Save draft</button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>✓ Mark processed</button>
        </div>
      )}
    </div>
  );
}

// ── New plan (Spare-AI sanctioning style: technician · job orders · per-day cost) ──
type JobOrder = { jo: string; cn: string; loc: string; cont: string; ms: string };
type DayCost = { day: number; date: string; travel: number; food: number; hotel: number; other: number; jobOrderNos: string[]; remark: string };
const daysBetween = (from: string, to: string) => Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1);
function buildDayCosts(days: number, fromDate: string, prev: DayCost[]): DayCost[] {
  const out: DayCost[] = [];
  for (let i = 0; i < days; i++) {
    const p = prev[i];
    const d = new Date(fromDate); d.setDate(d.getDate() + i);
    out.push(p ? { ...p, day: i + 1, date: d.toISOString().slice(0, 10) } : { day: i + 1, date: d.toISOString().slice(0, 10), travel: 0, food: 0, hotel: 0, other: 0, jobOrderNos: [], remark: '' });
  }
  return out;
}
const dayTotals = (dc: DayCost[]) => dc.reduce((a, d) => ({ travel: a.travel + (+d.travel || 0), food: a.food + (+d.food || 0), hotel: a.hotel + (+d.hotel || 0), other: a.other + (+d.other || 0) }), { travel: 0, food: 0, hotel: 0, other: 0 });

// Per-day multi-select of the trip's projects: selected chips (✕) + a "+ Add"
// dropdown listing the projects added in the section above (one or more per day).
function DayProjectPicker({ available, selected, onChange }: { available: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  if (available.length === 0) return <span className="text-[10px] text-slate-300">add a project above</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {selected.map((jo) => (
        <span key={jo} className="inline-flex items-center gap-1 rounded bg-navy/10 px-1.5 py-0.5 text-[10px] text-navy">
          {jo}<button type="button" className="text-navy/60 hover:text-navy" onClick={() => onChange(selected.filter((x) => x !== jo))}>✕</button>
        </span>
      ))}
      <div className="relative">
        <button type="button" className="rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50" onClick={() => setOpen((v) => !v)}>+ Add</button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full z-20 mt-1 max-h-52 w-52 overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
              {available.map((jo) => {
                const on = selected.includes(jo);
                return (
                  <button key={jo} type="button" onClick={() => onChange(on ? selected.filter((x) => x !== jo) : [...selected, jo])} className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-50 ${on ? 'font-medium text-navy' : 'text-slate-600'}`}>
                    <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] ${on ? 'border-navy bg-navy text-white' : 'border-slate-300'}`}>{on ? '✓' : ''}</span>
                    {jo}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NewSanctionTab({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const empQ = useQuery({ queryKey: ['travel-employees'], queryFn: async () => (await api.get('/travel/employees')).data.employees as Employee[] });
  const numQ = useQuery({ queryKey: ['travel-next-number'], queryFn: async () => (await api.get('/travel/next-number')).data.planNumber as string });
  const projectsQ = useQuery({ queryKey: ['travel-projects'], queryFn: async () => (await api.get('/projects')).data.projects as any[] });
  // New plan is now the ORIGIN of a trip: it generates its own unique Trip ID. The
  // Ticket Request links to a plan (not the other way round), so there's no picker here.
  const employees = empQ.data ?? [];
  const projects = projectsQ.data ?? [];

  const [employeeId, setEmployeeId] = useState('');
  const [employeeName, setName] = useState('');
  const [employeeEmail, setEmail] = useState('');
  const [mLevel, setMLevel] = useState('');
  const [senderName, setSender] = useState('');
  const [fromDate, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [toDate, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [jobOrders, setJobOrders] = useState<JobOrder[]>([{ jo: '', cn: '', loc: '', cont: '', ms: '' }]);
  const [dayCosts, setDayCosts] = useState<DayCost[]>(() => buildDayCosts(1, new Date().toISOString().slice(0, 10), []));
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [err, setErr] = useState('');

  const days = useMemo(() => daysBetween(fromDate, toDate), [fromDate, toDate]);
  // Keep the per-day grid sized to the trip.
  useEffect(() => { setDayCosts((prev) => buildDayCosts(days, fromDate, prev)); }, [days, fromDate]);
  const totals = dayTotals(dayCosts);
  const grand = totals.travel + totals.food + totals.hotel + totals.other;
  const totalAdvance = advances.reduce((s, a) => s + (+a.amount || 0), 0);
  const joNos = jobOrders.map((j) => j.jo).filter(Boolean);

  function pickEmployee(id: string) {
    setEmployeeId(id);
    const e = employees.find((x) => x.id === id);
    if (e) { setName(e.name); setEmail(e.email || ''); setMLevel(e.mLevel || ''); }
  }
  const setDay = (i: number, patch: Partial<DayCost>) => setDayCosts(dayCosts.map((d, j) => j === i ? { ...d, ...patch } : d));
  const setJo = (i: number, patch: Partial<JobOrder>) => setJobOrders(jobOrders.map((j, k) => k === i ? { ...j, ...patch } : j));

  // New plan is a SANCTIONING record — it just saves to plan history (no approval
  // chain; that's for the ticket request / expense).
  const save = useMutation({
    mutationFn: async () => {
      if (!employeeName.trim()) throw new Error('Select a technician');
      const body = {
        kind: 'PLAN' as const,
        employeeId: employeeId || null, employeeName, employeeEmail, mLevel, senderName,
        fromDate, toDate, days,
        jobOrders: jobOrders.filter((j) => j.jo.trim()),
        planCosts: totals, planDayCosts: dayCosts, advances,
      };
      return (await api.post('/travel', body)).data.plan;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['travel-plans'] }); qc.invalidateQueries({ queryKey: ['travel-next-number'] }); onDone(); },
    onError: (e) => setErr(errMsg(e)),
  });

  const money0 = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

  return (
    <div className="space-y-4 pb-16">
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

      {/* Trip details */}
      <Section title="Trip details" hint="Auto-assigned ID + sanctioning basics" accent="#f59e0b">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Trip ID <span className="text-[10px] font-normal text-slate-400">(auto-assigned)</span></label>
            <input className="input font-mono text-navy bg-slate-50" value={numQ.data ? `🆕 ${numQ.data}` : '…'} readOnly />
            <p className="mt-1 text-[11px] text-slate-400">New unique Trip ID — the Ticket Request links to this.</p>
          </div>
          <div>
            <label className="label">Technician name *</label>
            <select className="input" value={employeeId} onChange={(e) => pickEmployee(e.target.value)}>
              <option value="">— Select technician —</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div><label className="label">Sender name</label><input className="input" value={senderName} onChange={(e) => setSender(e.target.value)} placeholder="Who dispatched" /></div>
          <div><label className="label">From date *</label><input type="date" className="input" value={fromDate} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="label">To date *</label><input type="date" className="input" value={toDate} onChange={(e) => setTo(e.target.value)} /></div>
          <div><label className="label">Total days</label><input className="input bg-slate-50" value={`${days} day${days === 1 ? '' : 's'}`} readOnly /></div>
        </div>
        {mLevel && <div className="mt-2 text-xs text-slate-500">M-Level: <span className="font-medium">{mLevel}</span></div>}
      </Section>

      {/* Projects (CRMCTS uses projects, not job orders) */}
      <Section title="Projects" hint="Which projects this trip covers" accent="#f59e0b">
        <div className="mb-2 flex justify-end"><button className="text-sm font-medium text-navy hover:underline" onClick={() => setJobOrders([...jobOrders, { jo: '', cn: '', loc: '', cont: '', ms: '' }])}>+ Add project</button></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-[10px] uppercase text-slate-400"><tr><th className="w-8">#</th><th>Project *</th><th>Client</th><th>Location</th><th></th></tr></thead>
            <tbody>
              {jobOrders.map((j, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 text-slate-400">{i + 1}</td>
                  <td className="pr-2">
                    <select className="input h-8 text-xs" value={j.jo} onChange={(e) => {
                      const p = projects.find((x) => x.name === e.target.value);
                      setJo(i, { jo: e.target.value, cn: p?.clientName || '', loc: p?.siteLocation || '' });
                    }}>
                      <option value="">— Select project —</option>
                      {projects.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                    </select>
                  </td>
                  <td className="pr-2 text-xs text-slate-500">{j.cn || '—'}</td>
                  <td className="pr-2 text-xs text-slate-500">{j.loc || '—'}</td>
                  <td><button className="text-rose-400 hover:text-rose-600" onClick={() => setJobOrders(jobOrders.filter((_, k) => k !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Sanctioned amounts — per day */}
      <Section title="Sanctioned amounts" hint="Per-day sanction; total is the column sum" accent="#f59e0b">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="text-left text-[10px] uppercase text-slate-400">
              <tr><th className="py-1">Day</th><th>Date</th><th>Projects</th><th>Remarks</th><th className="text-right">Travel</th><th className="text-right">Food</th><th className="text-right">Hotel</th><th className="text-right">Other</th><th className="text-right pr-2">Day total</th></tr>
            </thead>
            <tbody>
              {dayCosts.map((d, i) => {
                const dt = (+d.travel || 0) + (+d.food || 0) + (+d.hotel || 0) + (+d.other || 0);
                return (
                  <tr key={i} className="border-t border-slate-100 align-top">
                    <td className="py-1 font-medium text-slate-600">Day {d.day}</td>
                    <td className="text-xs text-slate-500">{d.date}</td>
                    <td className="pr-2"><DayProjectPicker available={joNos} selected={d.jobOrderNos} onChange={(next) => setDay(i, { jobOrderNos: next })} /></td>
                    <td className="pr-2"><input className="input h-8 text-xs" value={d.remark} onChange={(e) => setDay(i, { remark: e.target.value })} placeholder="Why this day differs…" /></td>
                    {(['travel', 'food', 'hotel', 'other'] as const).map((k) => (
                      <td key={k} className="pr-1"><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={(d[k] as number) || ''} onChange={(e) => setDay(i, { [k]: Number(e.target.value) } as any)} placeholder="0" /></td>
                    ))}
                    <td className="pr-2 text-right font-medium">{money0(dt)}</td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-navy">
                <td className="py-2" colSpan={4}>Total sanctioned</td>
                <td className="text-right">{money0(totals.travel)}</td>
                <td className="text-right">{money0(totals.food)}</td>
                <td className="text-right">{money0(totals.hotel)}</td>
                <td className="text-right">{money0(totals.other)}</td>
                <td className="pr-2 text-right">{money0(grand)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      {/* Advances */}
      <Section title="Advance" hint="Optional — sanctioned money" accent="#f59e0b">
        <button className="mb-2 text-sm font-medium text-navy hover:underline" onClick={() => setAdvances([...advances, { amount: 0 }])}>+ Add advance</button>
        {advances.length === 0 ? <p className="text-sm text-slate-400">No advance requested.</p> : (
          <div className="space-y-2">
            {advances.map((a, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="number" min={0} className="input w-36" value={a.amount || ''} onChange={(e) => setAdvances(advances.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x))} placeholder="Amount" />
                <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-navy hover:bg-slate-50">{a.fileUrl ? 'Replace' : 'Proof'}<input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const url = await uploadFile(f); setAdvances(advances.map((x, j) => j === i ? { ...x, fileUrl: url } : x)); } }} /></label>
                {a.fileUrl && <a href={a.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-navy hover:underline">View</a>}
                <button className="text-xs text-rose-500" onClick={() => setAdvances(advances.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Footer */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow">
        <div className="flex flex-wrap gap-4 text-xs text-slate-500">
          <span>🛡 {joNos.length} project{joNos.length === 1 ? '' : 's'}</span>
          <span>💼 Sanctioned {money0(grand)}</span>
          <span>💳 Advance {money0(totalAdvance)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save plan</button>
        </div>
      </div>
    </div>
  );
}

// ── New request (rich Ticket-Request style: Employee · Itinerary · Costs) ─────
const MODES = ['Flight', 'Train', 'Bus', 'Taxi'] as const;
const MODE_ICON: Record<string, string> = { Flight: '✈', Train: '🚆', Bus: '🚌', Taxi: '🚕' };

function Section({ title, hint, accent, children }: { title: string; hint?: string; accent?: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-baseline gap-2 border-l-4 px-4 py-2.5" style={{ borderColor: accent || '#052379' }}>
        <h2 className="text-sm font-bold text-navy">{title}</h2>
        {hint && <span className="text-xs text-slate-400">{hint}</span>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function NewPlanTab({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const empQ = useQuery({ queryKey: ['travel-employees'], queryFn: async () => (await api.get('/travel/employees')).data.employees as Employee[] });
  // A Ticket Request is raised either fresh (its own new Trip ID) or AGAINST an
  // existing New plan — the Trip ID picker lists the plans.
  const numQ = useQuery({ queryKey: ['travel-next-number'], queryFn: async () => (await api.get('/travel/next-number')).data.planNumber as string });
  const plansQ = useQuery({ queryKey: ['travel-plans', 'PLAN'], queryFn: async () => (await api.get('/travel?kind=PLAN')).data.plans as any[] });
  const employees = empQ.data ?? [];
  const plans = plansQ.data ?? [];

  const [isNonCrystal, setNonCrystal] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const [employeeName, setName] = useState('');
  const [employeeEmail, setEmail] = useState('');
  const [employeePhone, setPhone] = useState('');
  const [mLevel, setMLevel] = useState('');
  const [designation, setDesignation] = useState('');
  const [department, setDepartment] = useState('');
  const [grade, setGrade] = useState('');
  const [aadharNo, setAadharNo] = useState('');
  const [aadharFileUrl, setAadharFile] = useState<string>('');
  const [aadharReading, setAadharReading] = useState(false);
  const [aadharNote, setAadharNote] = useState('');
  const [fromDate, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [toDate, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [origin, setOrigin] = useState('');
  const [destination, setDest] = useState('');
  const [travelMode, setMode] = useState('');
  const [requestedTicketUrl, setRequestedTicket] = useState<string>('');
  const [purpose, setPurpose] = useState('');
  const [remarks, setRemarks] = useState('');
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [linkedPlanId, setLinkedPlanId] = useState('');
  const [linkedTripNumber, setLinkedTrip] = useState('');
  const [err, setErr] = useState('');

  const days = useMemo(() => Math.max(1, Math.ceil((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000) + 1), [fromDate, toDate]);
  const totalAdvance = advances.reduce((s, a) => s + (Number(a.amount) || 0), 0);

  function pickEmployee(id: string) {
    setEmployeeId(id);
    const e = employees.find((x) => x.id === id);
    if (e) { setName(e.name); setEmail(e.email || ''); setMLevel(e.mLevel || ''); setPhone(e.whatsapp || ''); }
  }
  // Raise this request AGAINST an existing New plan: link to it + prefill the traveller
  // and dates from the plan. Leave the picker on "New" to raise a fresh request with
  // its own Trip ID instead.
  function linkFromPlan(planId: string) {
    setLinkedPlanId(planId);
    if (!planId) { setLinkedTrip(''); return; }
    const p = plans.find((x) => x.id === planId);
    if (!p) return;
    setLinkedTrip(p.planNumber || '');
    if (p.employeeId) { setNonCrystal(false); setEmployeeId(p.employeeId); }
    if (p.employeeName) setName(p.employeeName);
    if (p.employeeEmail) setEmail(p.employeeEmail);
    if (p.mLevel) setMLevel(p.mLevel);
    if (p.employeePhone) setPhone(p.employeePhone);
    if (p.fromDate) setFrom(new Date(p.fromDate).toISOString().slice(0, 10));
    if (p.toDate) setTo(new Date(p.toDate).toISOString().slice(0, 10));
  }

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      if (!employeeName.trim()) throw new Error('Traveller name is required');
      const body = {
        kind: 'REQUEST' as const,
        linkedTripNumber: linkedTripNumber || null,
        employeeId: isNonCrystal ? null : (employeeId || null), employeeName, employeeEmail, employeePhone, mLevel,
        designation, department, grade, aadharNo, aadharFileUrl,
        isNonCrystal, fromDate, toDate, days, origin, destination, purpose, remarks,
        travelMode, requestedTicketUrl, advances,
      };
      const plan = (await api.post('/travel', body)).data.plan;
      if (submit) await api.post(`/travel/${plan.id}/submit`);
      return plan;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['travel-plans'] }); qc.invalidateQueries({ queryKey: ['travel-next-number'] }); onDone(); },
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <div className="space-y-4 pb-16">
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

      {/* Trip ID — fresh, or book this request against an existing New plan */}
      <Section title="Trip details" hint="Fresh Trip ID, or book against a New plan" accent="#f59e0b">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Trip ID <span className="text-[10px] font-normal text-slate-400">(new, or against a plan)</span></label>
            <select className="input font-mono text-navy" value={linkedPlanId} onChange={(e) => linkFromPlan(e.target.value)}>
              <option value="">🆕 New — {numQ.data || '…'}</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.planNumber} · {p.employeeName}</option>)}
            </select>
            {linkedTripNumber && <p className="mt-1 text-[11px] font-medium text-emerald-600">🔗 Against plan {linkedTripNumber}</p>}
          </div>
        </div>
      </Section>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Employee details */}
        <Section title="Employee details" hint="Who is travelling" accent="#f59e0b">
          <label className="mb-3 flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={isNonCrystal} onChange={(e) => { setNonCrystal(e.target.checked); if (e.target.checked) setEmployeeId(''); }} />
            Other / Non-Crystal Group
          </label>
          <div className="space-y-3">
            {!isNonCrystal ? (
              <div>
                <label className="label">Employee name *</label>
                <select className="input" value={employeeId} onChange={(e) => pickEmployee(e.target.value)}>
                  <option value="">— Select employee —</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <p className="mt-1 text-[11px] text-slate-400">{employees.length} employees · M-Level auto-fills</p>
              </div>
            ) : (
              <div><label className="label">Traveller name *</label><input className="input" value={employeeName} onChange={(e) => setName(e.target.value)} placeholder="Full name" /></div>
            )}
            <div><label className="label">M-Level {isNonCrystal ? '' : '(auto)'}</label><input className="input" value={mLevel} onChange={(e) => setMLevel(e.target.value)} readOnly={!isNonCrystal} placeholder="—" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Phone</label><input className="input" value={employeePhone} onChange={(e) => setPhone(e.target.value)} placeholder="—" /></div>
              <div><label className="label">Department</label><input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="—" /></div>
            </div>
            <div><label className="label">Email</label><input className="input" value={employeeEmail} onChange={(e) => setEmail(e.target.value)} readOnly={!isNonCrystal && !!employeeId} placeholder="for the approval notification" /></div>
            <div><label className="label">Designation</label><input className="input" value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="—" /></div>
            <div><label className="label">Grade · Class entitlement</label><input className="input" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="—" /></div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Aadhar No {aadharReading && <span className="text-[10px] text-amber-600">reading…</span>}</label>
                <input className="input" value={aadharNo} onChange={(e) => setAadharNo(e.target.value)} placeholder="auto from file" />
              </div>
              <div>
                <label className="label">Aadhar file <span className="text-[10px] font-normal text-slate-400">(auto-reads No.)</span></label>
                <label className="flex h-[38px] cursor-pointer items-center gap-1 rounded-lg border border-slate-300 px-2 text-xs text-navy hover:bg-slate-50">
                  📎 {aadharReading ? 'Reading…' : aadharFileUrl ? 'Replace' : 'Upload'}
                  <input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => {
                    const f = e.target.files?.[0]; if (!f) return;
                    setAadharReading(true);
                    try { const r = await uploadAadhar(f); setAadharFile(r.fileUrl); if (r.aadhaar) setAadharNo(r.aadhaar); else if (r.note) setAadharNote(r.note); }
                    finally { setAadharReading(false); }
                  }} />
                  {aadharFileUrl && !aadharReading && <span className="text-green-600">✓</span>}
                </label>
                {aadharNote && !aadharNo && <p className="mt-0.5 text-[10px] text-slate-400">{aadharNote}</p>}
              </div>
            </div>
          </div>
        </Section>

        {/* Travel itinerary */}
        <Section title="Travel itinerary" hint="Where and when" accent="#f59e0b">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Origin *</label><input className="input" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="City" /></div>
              <div><label className="label">Destination *</label><input className="input" value={destination} onChange={(e) => setDest(e.target.value)} placeholder="City" /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="label">Departure date *</label><input type="date" className="input" value={fromDate} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><label className="label">Arrival date *</label><input type="date" className="input" value={toDate} onChange={(e) => setTo(e.target.value)} /></div>
            </div>
            <div className="text-[11px] text-slate-400">{days} day(s)</div>
            <div>
              <label className="label">Mode of travel *</label>
              <div className="flex flex-wrap gap-2">
                {MODES.map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${travelMode === m ? 'border-navy bg-navy text-white' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>{MODE_ICON[m]} {m}</button>
                ))}
              </div>
            </div>
            {/* The requester's reference: which ticket should be booked. Goes to the approver. */}
            <div>
              <label className="label">Which ticket to book <span className="text-[10px] font-normal text-slate-400">(upload — shown to the approver)</span></label>
              <div className="rounded-xl border border-dashed border-slate-300 p-3">
                <div className="text-[11px] text-slate-400">PDF or image · the ticket/option you want booked</div>
                <div className="mt-2 flex items-center gap-2">
                  <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-navy hover:bg-slate-50">
                    📎 {requestedTicketUrl ? 'Replace' : 'Choose file'}
                    <input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setRequestedTicket(await uploadFile(f)); }} />
                  </label>
                  {requestedTicketUrl && <a href={requestedTicketUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-navy hover:underline">View ✓</a>}
                </div>
              </div>
            </div>
          </div>
        </Section>

        {/* Costs & docs — filled by the ticket-booker approver after approval */}
        <Section title="Costs &amp; docs" hint="What it costs, and the proof" accent="#f59e0b">
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
            <div className="mb-1 text-base">🎫</div>
            <div className="font-medium text-slate-600">Booked by the ticket booker</div>
            <p className="mt-1 text-xs">The <strong>ticket price</strong>, <strong>ticket file</strong>, <strong>payment proof</strong>, payment method (Card/Online) and bank are filled by the approver marked <strong>“Uploads ticket”</strong> in the Travel Request chain — on their Approval Form. It then shows here against the trip.</p>
          </div>
        </Section>
      </div>

      {/* Job orders + Remarks */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Advance" hint="Optional — sanctioned money" accent="#f59e0b">
          <button className="mb-2 text-sm font-medium text-navy hover:underline" onClick={() => setAdvances([...advances, { amount: 0 }])}>+ Add advance</button>
          {advances.length === 0 ? <p className="text-sm text-slate-400">No advance requested.</p> : (
            <div className="space-y-2">
              {advances.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="number" min={0} className="input w-36" value={a.amount || ''} onChange={(e) => setAdvances(advances.map((x, j) => j === i ? { ...x, amount: Number(e.target.value) } : x))} placeholder="Amount" />
                  <label className="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-navy hover:bg-slate-50">{a.fileUrl ? 'Replace' : 'Proof'}<input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const url = await uploadFile(f); setAdvances(advances.map((x, j) => j === i ? { ...x, fileUrl: url } : x)); } }} /></label>
                  {a.fileUrl && <a href={a.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-navy hover:underline">View</a>}
                  <button className="text-xs text-rose-500" onClick={() => setAdvances(advances.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <div className="text-sm text-slate-500">Total: <span className="font-semibold">{inr(totalAdvance)}</span></div>
            </div>
          )}
        </Section>
        <Section title="Remarks" hint="Anything the approver should know" accent="#f59e0b">
          <textarea className="input min-h-[90px]" value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Purpose of trip / reasons / anything the approver should know…" />
          <input className="input mt-2" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Short purpose (one line)" />
        </Section>
      </div>

      {/* Footer summary + submit */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow">
        <div className="flex flex-wrap gap-4 text-xs text-slate-500">
          <span>👤 {employeeName || 'No traveller'}</span>
          <span>📍 {origin && destination ? `${origin} → ${destination}` : 'Route pending'}</span>
          <span>✈ {travelMode || 'Mode pending'}</span>
          <span>🎫 Ticket booked after approval</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-outline" disabled={save.isPending} onClick={() => save.mutate(false)}>Save draft</button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(true)}>Submit request ✈</button>
        </div>
      </div>
    </div>
  );
}

// ── Plan history ─────────────────────────────────────────────────────────────
const planProjects = (p: any) => (p.jobOrders ?? []).map((j: any) => j.jo).filter(Boolean).join(', ');

function HistoryTab({ kind, canManage }: { kind: 'PLAN' | 'REQUEST'; canManage: boolean }) {
  const isReq = kind === 'REQUEST';
  const plansQ = useQuery({ queryKey: ['travel-plans', kind], queryFn: async () => (await api.get(`/travel?kind=${kind}`)).data.plans as any[] });
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  if (plansQ.isLoading) return <Spinner label="Loading…" />;
  const plans = (plansQ.data ?? []).filter((p) => !search || [p.planNumber, p.employeeName, p.destination, p.origin, planProjects(p)].some((v: string) => (v || '').toLowerCase().includes(search.toLowerCase())));
  if (!plans.length && !search) return <EmptyState title={isReq ? 'No ticket requests yet' : 'No plans yet'} hint={canManage ? `Create one from "${isReq ? 'New request' : 'New plan'}".` : 'They will appear here.'} />;

  // Excel-friendly CSV of every planned trip (like the Spare-AI "Excel" export).
  const exportCsv = () => {
    const col3 = isReq ? 'Route' : 'Projects';
    const head = ['Trip ID', 'Technician', 'M-Level', col3, 'From', 'To', 'Days', 'Status', 'Sanctioned', 'Total Advance'];
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = plans.map((p) => { const pc = p.planCosts || {}; const g = (+pc.travel || 0) + (+pc.food || 0) + (+pc.hotel || 0) + (+pc.other || 0);
      const c3 = isReq ? [p.origin, p.destination].filter(Boolean).join(' → ') : planProjects(p);
      return [p.planNumber, p.employeeName, p.mLevel || '', c3, fmtDate(p.fromDate), fmtDate(p.toDate), p.days, planLabel(p.status), g, p.totalAdvance || 0].map(esc).join(','); });
    const blob = new Blob([[head.map(esc).join(','), ...rows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = isReq ? 'ticket-requests.csv' : 'travel-plans.csv'; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <input className="input max-w-xs" placeholder="Search trip, technician, project…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span>{plans.length} row{plans.length === 1 ? '' : 's'}</span>
          <button className="btn-outline text-xs" onClick={exportCsv}>⬇ Excel</button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
            <tr><th className="w-8 pl-3 py-2"></th><th className="py-2">Trip ID</th><th>Technician</th><th>{isReq ? 'Route' : 'Projects'}</th><th>From</th><th>To</th><th className="text-right">Days</th><th>Status</th><th className="text-right">Total Advance</th><th className="pr-4 text-right">Actions</th></tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <PlanRow key={p.id} p={p} isReq={isReq} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} canManage={canManage} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanRow({ p, isReq, open, onToggle, canManage }: { p: any; isReq?: boolean; open: boolean; onToggle: () => void; canManage: boolean }) {
  const qc = useQueryClient();
  const col3 = isReq ? [p.origin, p.destination].filter(Boolean).join(' → ') : planProjects(p);
  const isPlan = !isReq;
  const isClosed = p.status === 'CLOSED';
  const [mode, setMode] = useState<'summary' | 'edit'>('summary');
  const closeM = useMutation({ mutationFn: async () => api.patch(`/travel/${p.id}`, { status: 'CLOSED' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['travel-plans'] }) });
  const openAs = (m: 'summary' | 'edit') => { setMode(m); if (!open) onToggle(); };

  return (
    <>
      <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => { setMode('summary'); onToggle(); }}>
        <td className="pl-3 py-2 text-slate-400">{open ? '▾' : '▸'}</td>
        <td className="py-2 font-medium text-navy">{p.planNumber}</td>
        <td>{p.employeeName}{p.isNonCrystal && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700">Non-Crystal</span>}{p.mLevel && <span className="ml-1 text-[10px] text-slate-400">· {p.mLevel}</span>}</td>
        <td className="max-w-[280px] truncate text-xs text-slate-500" title={col3}>{col3 || '—'}</td>
        <td className="whitespace-nowrap text-slate-500">{fmtDate(p.fromDate)}</td>
        <td className="whitespace-nowrap text-slate-500">{fmtDate(p.toDate)}</td>
        <td className="text-right font-medium">{p.days}</td>
        <td><span className={`badge ${PLAN_PILL[p.status] || 'bg-slate-100'}`}>{planLabel(p.status)}</span></td>
        <td className="text-right font-medium text-amber-700">{inr(p.totalAdvance || 0)}</td>
        <td className="pr-4 text-right" onClick={(e) => e.stopPropagation()}>
          {/* Ticket requests → View only. Sanctioning plans → Active: Edit + Close; Closed: View. */}
          {isReq || !isPlan ? (
            <button className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={() => openAs('summary')}>{open ? 'Hide' : '👁 View'}</button>
          ) : isClosed ? (
            <button className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={() => openAs('summary')}>{open && mode === 'summary' ? 'Hide' : '👁 View'}</button>
          ) : (
            <div className="flex justify-end gap-1.5">
              {canManage && <button className="rounded-lg border border-navy/30 bg-navy/5 px-2.5 py-1 text-xs font-medium text-navy hover:bg-navy/10" onClick={() => openAs('edit')}>✎ Edit</button>}
              {canManage && <button className="rounded-lg border border-rose-300 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50" disabled={closeM.isPending} onClick={() => confirm(`Close plan ${p.planNumber}?`) && closeM.mutate()}>Close</button>}
            </div>
          )}
        </td>
      </tr>
      {open && <tr className="border-t border-slate-100 bg-slate-50/50"><td colSpan={10} className="px-4 py-3">
        {isPlan
          ? (mode === 'edit' && !isClosed && canManage
              ? <PlanEditPanel plan={p} readOnly={false} onDone={() => { setMode('summary'); onToggle(); }} />
              : <PlanSummary plan={p} />)
          : <PlanDetail planId={p.id} canManage={canManage} />}
      </td></tr>}
    </>
  );
}

// Read-only summary of a sanctioning plan (row-click / View) — facts + advances +
// projects, like the reference expand. The editable form is PlanEditPanel (Edit).
function PlanSummary({ plan }: { plan: any }) {
  const pc = plan.planCosts || {};
  const money0 = (n: any) => `₹${Math.round(+n || 0).toLocaleString('en-IN')}`;
  const fact = (k: string, v: any) => (
    <div className="border-b border-slate-100 py-1.5">
      <div className="text-[10px] uppercase text-slate-400">{k}</div>
      <div className="text-sm font-semibold text-slate-700">{v}</div>
    </div>
  );
  const advs = (plan.advances || []).filter((a: any) => (+a.amount || 0) > 0 || a.fileUrl);
  const projs = (plan.jobOrders || []).filter((j: any) => j.jo);
  return (
    <div>
      <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-4">
        {fact('Trip', plan.planNumber)}
        {fact('Technician', plan.employeeName + (plan.mLevel ? ` · ${plan.mLevel}` : ''))}
        {fact('Sender', plan.senderName || '—')}
        {fact('Window', `${fmtDate(plan.fromDate)} → ${fmtDate(plan.toDate)} · ${plan.days}d`)}
        {fact('Travel sanctioned', money0(pc.travel))}
        {fact('Food sanctioned', money0(pc.food))}
        {fact('Hotel sanctioned', money0(pc.hotel))}
        {fact('Other sanctioned', money0(pc.other))}
        {fact('Total advance', money0(plan.totalAdvance))}
        {fact('Created', fmtDate(plan.createdAt))}
        {plan.linkedTripNumber ? fact('Linked trip', plan.linkedTripNumber) : null}
      </div>
      <div className="mt-3">
        <div className="text-[10px] uppercase text-slate-400">Advances paid</div>
        {advs.length === 0 ? <p className="text-sm text-slate-400">No advances disbursed.</p> : (
          <div className="mt-1 flex flex-wrap gap-2">
            {advs.map((a: any, i: number) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">{money0(a.amount)}{a.fileUrl && <a href={a.fileUrl} target="_blank" rel="noreferrer" className="underline">View</a>}</span>
            ))}
          </div>
        )}
      </div>
      <div className="mt-3">
        <div className="text-[10px] uppercase text-slate-400">Projects on this trip</div>
        {projs.length === 0 ? <p className="text-sm text-slate-400">—</p> : (
          <div className="mt-1 flex flex-wrap gap-2">
            {projs.map((j: any, i: number) => (
              <span key={i} className="rounded-lg border border-slate-200 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-600">{[j.jo, j.cn, j.loc].filter(Boolean).join(' · ')}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Inline Edit / View for a sanctioning plan (mirrors the New-plan form). Editable
// when the plan is Active; read-only when Closed. Saving re-opens it as Active.
function PlanEditPanel({ plan, readOnly, onDone }: { plan: any; readOnly: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const empQ = useQuery({ queryKey: ['travel-employees'], queryFn: async () => (await api.get('/travel/employees')).data.employees as Employee[] });
  const projectsQ = useQuery({ queryKey: ['travel-projects'], queryFn: async () => (await api.get('/projects')).data.projects as any[] });
  const employees = empQ.data ?? [];
  const projects = projectsQ.data ?? [];

  const [employeeId, setEmployeeId] = useState(plan.employeeId || '');
  const [employeeName, setName] = useState(plan.employeeName || '');
  const [mLevel, setMLevel] = useState(plan.mLevel || '');
  const [fromDate, setFrom] = useState(plan.fromDate ? new Date(plan.fromDate).toISOString().slice(0, 10) : '');
  const [toDate, setTo] = useState(plan.toDate ? new Date(plan.toDate).toISOString().slice(0, 10) : '');
  const [jobOrders, setJobOrders] = useState<JobOrder[]>((plan.jobOrders?.length ? plan.jobOrders : [{ jo: '', cn: '', loc: '', cont: '', ms: '' }]).map((j: any) => ({ jo: j.jo || '', cn: j.cn || '', loc: j.loc || '', cont: j.cont || '', ms: j.ms || '' })));
  const [dayCosts, setDayCosts] = useState<DayCost[]>(() => (plan.planDayCosts?.length ? plan.planDayCosts.map((d: any, i: number) => ({ day: i + 1, date: d.date || '', travel: +d.travel || 0, food: +d.food || 0, hotel: +d.hotel || 0, other: +d.other || 0, jobOrderNos: d.jobOrderNos || [], remark: d.remark || '' })) : buildDayCosts(plan.days || 1, plan.fromDate ? new Date(plan.fromDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10), [])));
  const [advances, setAdvances] = useState<Advance[]>((plan.advances || []).map((a: any) => ({ amount: +a.amount || 0, fileUrl: a.fileUrl || '' })));

  const days = useMemo(() => daysBetween(fromDate || new Date().toISOString().slice(0, 10), toDate || fromDate || new Date().toISOString().slice(0, 10)), [fromDate, toDate]);
  useEffect(() => { if (!readOnly) setDayCosts((prev) => buildDayCosts(days, fromDate, prev)); }, [days, fromDate, readOnly]);
  const totals = dayTotals(dayCosts);
  const grand = totals.travel + totals.food + totals.hotel + totals.other;
  const advPaid = advances.reduce((s, a) => s + (+a.amount || 0), 0);
  const joNos = jobOrders.map((j) => j.jo).filter(Boolean);
  const money0 = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  const setDay = (i: number, patch: Partial<DayCost>) => setDayCosts(dayCosts.map((d, j) => j === i ? { ...d, ...patch } : d));
  const setJo = (i: number, patch: Partial<JobOrder>) => setJobOrders(jobOrders.map((j, k) => k === i ? { ...j, ...patch } : j));

  const save = useMutation({
    mutationFn: async () => api.patch(`/travel/${plan.id}`, {
      employeeId: employeeId || null, employeeName, mLevel, fromDate, toDate, days,
      jobOrders: jobOrders.filter((j) => j.jo.trim()), planCosts: totals, planDayCosts: dayCosts, advances,
      status: 'ACTIVE',  // any edit re-opens the plan as Active
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['travel-plans'] }); onDone(); },
  });

  const dis = readOnly;
  return (
    <div>
    <fieldset disabled={dis} className={dis ? 'opacity-95' : ''}>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-navy">{dis ? 'View plan' : 'Edit plan'} — {plan.planNumber}
          <span className="ml-2 text-xs font-normal text-slate-400">{dis ? 'Closed — view only (re-open to make changes)' : 'Changes re-open the plan as Active'}</span>
        </div>
      </div>
      {dis && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">This plan is <strong>Closed</strong> — view only. It can’t be edited unless it’s re-opened.</div>}

      {/* Trip details */}
      <div className="grid gap-3 sm:grid-cols-4">
        <div><label className="label">Technician</label>
          <select className="input" value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); const em = employees.find((x) => x.id === e.target.value); if (em) { setName(em.name); setMLevel(em.mLevel || ''); } }}>
            <option value="">{employeeName || '— Select —'}</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div><label className="label">From date</label><input type="date" className="input" value={fromDate} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">To date</label><input type="date" className="input" value={toDate} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label className="label">Days</label><input className="input bg-slate-50" value={days} readOnly /></div>
      </div>

      {/* Projects */}
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold uppercase text-slate-400">Projects</span>{!dis && <button type="button" className="text-xs font-medium text-navy hover:underline" onClick={() => setJobOrders([...jobOrders, { jo: '', cn: '', loc: '', cont: '', ms: '' }])}>+ Add project</button>}</div>
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><thead className="text-left text-[10px] uppercase text-slate-400"><tr><th className="w-6">#</th><th>Project</th><th>Client</th><th>Location</th><th></th></tr></thead>
          <tbody>{jobOrders.map((j, i) => (
            <tr key={i} className="border-t border-slate-100">
              <td className="py-1 text-slate-400">{i + 1}</td>
              <td className="pr-2"><select className="input h-8 text-xs" value={j.jo} onChange={(e) => { const pr = projects.find((x) => x.name === e.target.value); setJo(i, { jo: e.target.value, cn: pr?.clientName || '', loc: pr?.siteLocation || '' }); }}><option value="">{j.jo || '— Select —'}</option>{projects.map((pr) => <option key={pr.id} value={pr.name}>{pr.name}</option>)}</select></td>
              <td className="pr-2 text-xs text-slate-500">{j.cn || '—'}</td>
              <td className="pr-2 text-xs text-slate-500">{j.loc || '—'}</td>
              <td>{!dis && <button type="button" className="text-rose-400 hover:text-rose-600" onClick={() => setJobOrders(jobOrders.filter((_, k) => k !== i))}>✕</button>}</td>
            </tr>))}</tbody></table></div>
      </div>

      {/* Sanctioned amounts */}
      <div className="mt-4">
        <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Sanctioned amounts</div>
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-[10px] uppercase text-slate-400"><tr><th className="py-1">Day</th><th>Date</th><th>Projects</th><th>Remarks</th><th className="text-right">Travel</th><th className="text-right">Food</th><th className="text-right">Hotel</th><th className="text-right">Other</th><th className="text-right pr-2">Day total</th></tr></thead>
          <tbody>
            {dayCosts.map((d, i) => { const dt = (+d.travel || 0) + (+d.food || 0) + (+d.hotel || 0) + (+d.other || 0); return (
              <tr key={i} className="border-t border-slate-100 align-top">
                <td className="py-1 font-medium text-slate-600">Day {d.day}</td>
                <td className="text-xs text-slate-500">{d.date}</td>
                <td className="pr-2"><DayProjectPicker available={joNos} selected={d.jobOrderNos} onChange={(next) => setDay(i, { jobOrderNos: next })} /></td>
                <td className="pr-2"><input className="input h-8 text-xs" value={d.remark} onChange={(e) => setDay(i, { remark: e.target.value })} placeholder="—" /></td>
                {(['travel', 'food', 'hotel', 'other'] as const).map((k) => (<td key={k} className="pr-1"><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={(d[k] as number) || ''} onChange={(e) => setDay(i, { [k]: Number(e.target.value) } as any)} placeholder="0" /></td>))}
                <td className="pr-2 text-right font-medium">{money0(dt)}</td>
              </tr>); })}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold text-navy">
              <td className="py-2" colSpan={4}>Total sanctioned</td>
              <td className="text-right">{money0(totals.travel)}</td><td className="text-right">{money0(totals.food)}</td><td className="text-right">{money0(totals.hotel)}</td><td className="text-right">{money0(totals.other)}</td><td className="pr-2 text-right">{money0(grand)}</td>
            </tr>
          </tbody></table></div>
      </div>

      {/* Advance payments */}
      <div className="mt-4">
        <div className="mb-2 text-xs font-semibold uppercase text-slate-400">Advance payments</div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3"><div className="text-xs text-blue-700">Sanctioned</div><div className="text-xl font-bold text-blue-800">{money0(grand)}</div><div className="text-[10px] text-blue-500">Budget approved for this trip</div></div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3"><div className="text-xs text-amber-700">Advances paid</div><div className="text-xl font-bold text-amber-800">{money0(advPaid)}</div><div className="text-[10px] text-amber-500">Money already handed to the technician</div></div>
          <div className={`rounded-xl border p-3 ${grand - advPaid < 0 ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'}`}><div className="text-xs text-emerald-700">{grand - advPaid < 0 ? 'Over by' : 'Remaining'}</div><div className="text-xl font-bold text-emerald-800">{money0(Math.abs(grand - advPaid))}</div><div className="text-[10px] text-emerald-600">Still un-disbursed against the sanction</div></div>
        </div>
        <div className="mt-2 space-y-1">
          {[0, 1, 2, 3, 4].map((i) => { const a = advances[i]; return (
            <div key={i} className="flex items-center gap-2 border-t border-slate-100 py-1.5 text-sm">
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] ${a?.amount ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-400'}`}>{i + 1}</span>
              <span className="w-24 text-xs text-slate-500">Advance {i + 1}</span>
              <input type="number" min={0} className="input h-8 w-32 text-xs" value={a?.amount || ''} onChange={(e) => { const next = [...advances]; while (next.length <= i) next.push({ amount: 0 }); next[i] = { ...next[i], amount: Number(e.target.value) }; setAdvances(next); }} placeholder="0" />
              {a?.fileUrl ? (<><label className="cursor-pointer text-xs text-navy hover:underline">Replace<input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const url = await uploadFile(f); const next = [...advances]; next[i] = { ...next[i], fileUrl: url }; setAdvances(next); } }} /></label><a href={a.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-navy hover:underline">↗ View</a></>) : (
                <label className="cursor-pointer text-xs text-navy hover:underline">📎 Attach proof<input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const url = await uploadFile(f); const next = [...advances]; while (next.length <= i) next.push({ amount: 0 }); next[i] = { ...next[i], fileUrl: url }; setAdvances(next); } }} /></label>)}
            </div>); })}
        </div>
      </div>

    </fieldset>
      <div className="mt-4 flex gap-2">
        {!dis && <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save changes</button>}
        <button type="button" className="btn-outline" onClick={onDone}>{dis ? 'Close' : 'Cancel'}</button>
      </div>
    </div>
  );
}

function PlanDetail({ planId, canManage }: { planId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['travel-plan', planId], queryFn: async () => (await api.get(`/travel/${planId}`)).data });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['travel-plan', planId] }); qc.invalidateQueries({ queryKey: ['travel-plans'] }); };
  const [adding, setAdding] = useState(false);

  const submit = useMutation({ mutationFn: async () => api.post(`/travel/${planId}/submit`), onSuccess: refresh });
  const remind = useMutation({ mutationFn: async () => api.post(`/travel/${planId}/remind`), onSuccess: () => alert('Reminder sent to the current approver.') });

  if (q.isLoading) return <Spinner label="Loading…" />;
  const { plan, requestChain, expenseChains } = q.data;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Trip + request approval */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Trip</div>
          <div className="text-sm text-slate-600">
            <div className="font-medium">{[plan.origin, plan.destination].filter(Boolean).join(' → ') || '—'}</div>
            <div className="text-xs text-slate-400">{plan.days} day(s){plan.travelMode ? ` · ${plan.travelMode}` : ''}{plan.purpose ? ` · ${plan.purpose}` : ''}</div>
            {(plan.designation || plan.department) && <div className="text-xs text-slate-400">{[plan.designation, plan.department].filter(Boolean).join(' · ')}</div>}
            {plan.senderName && <div className="text-xs text-slate-400">Sender: {plan.senderName}</div>}
            {plan.linkedTripNumber && <div className="text-xs font-medium text-emerald-600">🔗 Linked trip: {plan.linkedTripNumber}</div>}
            {plan.employeeEmail && <div className="mt-1 text-xs text-slate-400">✉ {plan.employeeEmail}</div>}
            {(() => { const pc = plan.planCosts || {}; const g = (+pc.travel || 0) + (+pc.food || 0) + (+pc.hotel || 0) + (+pc.other || 0); return g > 0 ? <div className="mt-1 text-xs">Sanctioned: <span className="font-semibold">{inr(g)}</span> <span className="text-slate-400">(T {inr(+pc.travel || 0)} · F {inr(+pc.food || 0)} · H {inr(+pc.hotel || 0)} · O {inr(+pc.other || 0)})</span></div> : null; })()}
            {(plan.jobOrders?.length ?? 0) > 0 && <div className="mt-1 text-xs text-slate-500">JOs: {plan.jobOrders.map((j: any) => j.jo).filter(Boolean).join(', ') || '—'}</div>}
            {plan.aadharNo && <div className="mt-1 text-xs text-slate-500">Aadhaar: <span className="font-medium">{plan.aadharNo}</span></div>}
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              {plan.aadharFileUrl && <a href={plan.aadharFileUrl} target="_blank" rel="noreferrer" className="text-navy hover:underline">📎 Aadhaar</a>}
              {plan.requestedTicketUrl && <a href={plan.requestedTicketUrl} target="_blank" rel="noreferrer" className="text-navy hover:underline">📎 Ticket to book</a>}
            </div>
          </div>
          {canManage && plan.status === 'DRAFT' && <button className="btn-primary mt-2 text-xs" disabled={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</button>}
          {canManage && plan.status === 'SUBMITTED' && <button className="btn-outline mt-2 text-xs" disabled={remind.isPending} onClick={() => remind.mutate()}>📧 Send reminder</button>}
        </div>
        {/* Request approval chain */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Request approval</div>
          <ChainView chain={requestChain} status={plan.status} />
        </div>
        {/* Booking */}
        <BookingCard plan={plan} canManage={canManage} onDone={refresh} />
      </div>

      {/* Expenses */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[10px] font-semibold uppercase text-slate-400">Expenses (after travel)</div>
          {canManage && !adding && <button className="text-xs font-medium text-navy hover:underline" onClick={() => setAdding(true)}>+ Upload expenses</button>}
        </div>
        {adding && <ExpenseForm planId={planId} onDone={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />}
        {(plan.expenses ?? []).length === 0 && !adding ? <p className="text-sm text-slate-400">No expenses uploaded yet.</p> : (
          <div className="space-y-2">
            {(plan.expenses ?? []).map((e: any) => <ExpenseRow key={e.id} exp={e} chain={expenseChains?.[e.id]} canManage={canManage} onDone={refresh} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function ChainView({ chain, status }: { chain: any; status?: string }) {
  if (!chain || !chain.steps?.length) return <p className="text-xs text-slate-400">No chain configured. Set approvers in <span className="font-medium">Approval Chains</span> (Travel Request / Travel Expense).</p>;
  return (
    <div className="space-y-1">
      {chain.steps.map((s: any, i: number) => {
        const done = s.status === 'APPROVED' || s.status === 'SKIPPED';
        const c = done ? 'bg-green-500' : s.status === 'ON_HOLD' ? 'bg-orange-500' : s.status === 'PENDING' ? 'bg-navy' : 'bg-slate-300';
        return (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className={`h-2 w-2 shrink-0 rounded-full ${c}`} />
            <span className={done ? 'text-slate-700' : 'text-slate-500'}>{s.order}. {s.name}{s.role ? ` · ${s.role}` : ''}</span>
            <span className="ml-auto text-slate-400">{done ? 'Approved' : s.status === 'PENDING' ? 'Pending' : s.status === 'ON_HOLD' ? 'On Hold' : 'Waiting'}{s.actedAt ? ` · ${fmtDate(s.actedAt)}` : ''}</span>
          </div>
        );
      })}
      {status === 'ON_HOLD' && <div className="text-[11px] text-orange-600">On hold — sent back to the requester.</div>}
    </div>
  );
}

function BookingCard({ plan, canManage, onDone }: { plan: any; canManage: boolean; onDone: () => void }) {
  const [bookingStatus, setStatus] = useState(plan.bookingStatus);
  const [bookingMode, setMode] = useState(plan.bookingMode || '');
  const [bookingRef, setRef] = useState(plan.bookingRef || '');
  const save = useMutation({ mutationFn: async () => api.patch(`/travel/${plan.id}/booking`, { bookingStatus, bookingMode, bookingRef }), onSuccess: onDone });
  const locked = plan.status !== 'APPROVED' && plan.bookingStatus === 'NOT_BOOKED';
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-1 text-[10px] font-semibold uppercase text-slate-400">Booking</div>
      {/* Booking details filled by the ticket-booker approver — shown against the trip. */}
      {(plan.ticketFileUrl || plan.paymentProofUrl || plan.paymentMethod || plan.ticketPrice != null) && (
        <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-xs">
          <div className="mb-1 font-semibold text-emerald-800">🎫 Ticket booked{plan.ticketBookedBy ? ` by ${plan.ticketBookedBy}` : ''}</div>
          {plan.ticketPrice != null && <div className="text-slate-600">Price: <span className="font-semibold">{inr(plan.ticketPrice)}</span></div>}
          {plan.paymentMethod && <div className="text-slate-600">Paid by: <span className="font-semibold">{plan.paymentMethod}</span>{plan.paymentBank ? ` · ${plan.paymentBank}` : ''}</div>}
          <div className="mt-1 flex flex-wrap gap-3">
            {plan.ticketFileUrl && <a href={plan.ticketFileUrl} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline">🎫 Ticket ↗</a>}
            {plan.paymentProofUrl && <a href={plan.paymentProofUrl} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline">📎 Payment proof ↗</a>}
          </div>
        </div>
      )}
      {locked ? <p className="text-xs text-slate-400">Booking opens once the request is approved.</p> : (
        <div className="space-y-2">
          <select className="input text-xs" value={bookingStatus} onChange={(e) => setStatus(e.target.value)} disabled={!canManage}>
            <option value="NOT_BOOKED">Not booked</option><option value="BOOKED">Booked</option><option value="CANCELLED">Cancelled</option>
          </select>
          <input className="input text-xs" placeholder="Mode (Flight/Train/…)" value={bookingMode} onChange={(e) => setMode(e.target.value)} disabled={!canManage} />
          <input className="input text-xs" placeholder="PNR / ticket ref" value={bookingRef} onChange={(e) => setRef(e.target.value)} disabled={!canManage} />
          {canManage && <button className="btn-outline text-xs" disabled={save.isPending} onClick={() => save.mutate()}>Save booking</button>}
        </div>
      )}
    </div>
  );
}

function ExpenseForm({ planId, onDone, onCancel }: { planId: string; onDone: () => void; onCancel: () => void }) {
  const [items, setItems] = useState<ExpenseItem[]>([{ date: new Date().toISOString().slice(0, 10), details: '', paymentMode: 'Online', amount: 0 }]);
  const [err, setErr] = useState('');
  const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const set = (i: number, patch: Partial<ExpenseItem>) => setItems(items.map((x, j) => j === i ? { ...x, ...patch } : x));

  const create = useMutation({
    mutationFn: async (submit: boolean) => {
      if (!items.length || items.every((it) => !it.amount)) throw new Error('Add at least one expense line');
      const exp = (await api.post(`/travel/${planId}/expenses`, { items })).data.expense;
      if (submit) await api.post(`/travel/expenses/${exp.id}/submit`);
      return exp;
    },
    onSuccess: onDone,
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <div className="mb-3 rounded-lg border border-navy/20 bg-navy/5 p-3">
      {err && <div className="mb-2 text-sm text-rose-600">{err}</div>}
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-2">
            <input type="date" className="input col-span-2 text-xs" value={it.date || ''} onChange={(e) => set(i, { date: e.target.value })} />
            <input className="input col-span-4 text-xs" placeholder="Expense details" value={it.details} onChange={(e) => set(i, { details: e.target.value })} />
            <select className="input col-span-2 text-xs" value={it.paymentMode} onChange={(e) => set(i, { paymentMode: e.target.value as any })}><option value="Online">Online</option><option value="Cash">Cash</option></select>
            <input type="number" min={0} className="input col-span-2 text-xs" placeholder="Amount" value={it.amount || ''} onChange={(e) => set(i, { amount: Number(e.target.value) })} />
            <div className="col-span-2 flex items-center gap-1">
              <label className="cursor-pointer text-xs text-navy hover:underline">
                {it.supportingUrl ? '✓ Doc' : (it.paymentMode === 'Cash' ? 'Doc (opt)' : 'Attach')}
                <input type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const url = await uploadFile(f); set(i, { supportingUrl: url }); } }} />
              </label>
              <button className="text-xs text-rose-500" onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button className="text-xs font-medium text-navy hover:underline" onClick={() => setItems([...items, { date: new Date().toISOString().slice(0, 10), details: '', paymentMode: 'Online', amount: 0 }])}>+ Add line</button>
        <div className="text-sm">Total: <span className="font-semibold">{inr(total)}</span></div>
      </div>
      <div className="mt-3 flex gap-2">
        <button className="btn-outline text-xs" disabled={create.isPending} onClick={() => create.mutate(false)}>Save draft</button>
        <button className="btn-primary text-xs" disabled={create.isPending} onClick={() => create.mutate(true)}>Submit for approval</button>
        <button className="text-xs text-slate-500" onClick={onCancel}>Cancel</button>
        <span className="text-[11px] text-slate-400">Cash lines don't need a supporting doc.</span>
      </div>
    </div>
  );
}

function ExpenseRow({ exp, chain, canManage, onDone }: { exp: any; chain: any; canManage: boolean; onDone: () => void }) {
  const submit = useMutation({ mutationFn: async () => api.post(`/travel/expenses/${exp.id}/submit`), onSuccess: onDone });
  const remind = useMutation({ mutationFn: async () => api.post(`/travel/expenses/${exp.id}/remind`), onSuccess: () => alert('Reminder sent.') });
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-slate-700">{exp.expenseNumber} · <span className="font-semibold">{inr(exp.totalAmount)}</span> <span className={`badge ml-1 ${PLAN_PILL[exp.status] || 'bg-slate-100'}`}>{planLabel(exp.status)}</span></div>
        <div className="flex items-center gap-2">
          {canManage && exp.status === 'DRAFT' && <button className="text-xs font-medium text-navy hover:underline" disabled={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</button>}
          {canManage && exp.status === 'SUBMITTED' && <button className="text-xs text-navy hover:underline" disabled={remind.isPending} onClick={() => remind.mutate()}>📧 Remind</button>}
          {exp.status === 'APPROVED' && <button className="text-xs font-medium text-green-700 hover:underline" onClick={() => downloadFile(`/travel/expenses/${exp.id}/pdf`, `${exp.expenseNumber}.pdf`)}>📄 Download PDF</button>}
        </div>
      </div>
      <div className="mt-1 text-[11px] text-slate-500">{(exp.items ?? []).length} line(s){exp.items?.some((it: any) => it.paymentMode === 'Cash') ? ' · incl. cash' : ''}</div>
      {chain && <div className="mt-2"><ChainView chain={chain} status={exp.status} /></div>}
    </div>
  );
}
