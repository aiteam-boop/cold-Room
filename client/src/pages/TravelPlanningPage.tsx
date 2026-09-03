import { useEffect, useMemo, useState, type ReactNode } from 'react';
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

export default function TravelPlanningPage() {
  const { canEdit } = useAuth();
  const canManage = canEdit('travel');
  const [tab, setTab] = useState<'plan' | 'planhist' | 'ticket'>('planhist');
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
      </div>
      {tab === 'plan' && canManage ? <NewSanctionTab onDone={() => setTab('planhist')} />
        : tab === 'ticket' ? <TicketRequestTab canManage={canManage} />
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
  // A New plan is raised AGAINST a Ticket Request — the Trip ID picker lists them.
  const reqQ = useQuery({ queryKey: ['travel-plans', 'REQUEST'], queryFn: async () => (await api.get('/travel?kind=REQUEST')).data.plans as any[] });
  const employees = empQ.data ?? [];
  const projects = projectsQ.data ?? [];
  const requests = reqQ.data ?? [];
  const [linkedTripNumber, setLinkedTrip] = useState('');

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
  // Raise this plan AGAINST a Ticket Request: link to it + prefill the traveller and
  // dates from the request. The plan's own Projects / sanctioned amounts are entered
  // fresh below.
  function linkFromRequest(reqId: string) {
    if (!reqId) { setLinkedTrip(''); return; }
    const p = requests.find((x) => x.id === reqId);
    if (!p) return;
    setLinkedTrip(p.planNumber || '');
    setEmployeeId(p.employeeId || ''); setName(p.employeeName || ''); setEmail(p.employeeEmail || ''); setMLevel(p.mLevel || ''); setSender(p.senderName || p.appliedByName || '');
    if (p.fromDate) setFrom(new Date(p.fromDate).toISOString().slice(0, 10));
    if (p.toDate) setTo(new Date(p.toDate).toISOString().slice(0, 10));
  }
  const setDay = (i: number, patch: Partial<DayCost>) => setDayCosts(dayCosts.map((d, j) => j === i ? { ...d, ...patch } : d));
  const setJo = (i: number, patch: Partial<JobOrder>) => setJobOrders(jobOrders.map((j, k) => k === i ? { ...j, ...patch } : j));

  // New plan is a SANCTIONING record — it just saves to plan history (no approval
  // chain; that's for the ticket request / expense).
  const save = useMutation({
    mutationFn: async () => {
      if (!employeeName.trim()) throw new Error('Select a technician');
      const body = {
        kind: 'PLAN' as const, linkedTripNumber: linkedTripNumber || null,
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
            <label className="label">Trip ID <span className="text-[10px] font-normal text-slate-400">(against a ticket request)</span></label>
            <select className="input font-mono text-navy" defaultValue="" onChange={(e) => linkFromRequest(e.target.value)}>
              <option value="">🆕 New — {numQ.data || '…'}</option>
              {requests.map((p) => <option key={p.id} value={p.id}>{p.planNumber} · {p.employeeName}{p.destination ? ` · ${p.origin || ''}→${p.destination}` : ''}</option>)}
            </select>
            {linkedTripNumber && <p className="mt-1 text-[11px] font-medium text-emerald-600">🔗 Against request {linkedTripNumber}</p>}
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
  const employees = empQ.data ?? [];

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
  const [err, setErr] = useState('');

  const days = useMemo(() => Math.max(1, Math.ceil((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000) + 1), [fromDate, toDate]);
  const totalAdvance = advances.reduce((s, a) => s + (Number(a.amount) || 0), 0);

  function pickEmployee(id: string) {
    setEmployeeId(id);
    const e = employees.find((x) => x.id === id);
    if (e) { setName(e.name); setEmail(e.email || ''); setMLevel(e.mLevel || ''); setPhone(e.whatsapp || ''); }
  }

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      if (!employeeName.trim()) throw new Error('Traveller name is required');
      const body = {
        kind: 'REQUEST' as const,
        employeeId: isNonCrystal ? null : (employeeId || null), employeeName, employeeEmail, employeePhone, mLevel,
        designation, department, grade, aadharNo, aadharFileUrl,
        isNonCrystal, fromDate, toDate, days, origin, destination, purpose, remarks,
        travelMode, requestedTicketUrl, advances,
      };
      const plan = (await api.post('/travel', body)).data.plan;
      if (submit) await api.post(`/travel/${plan.id}/submit`);
      return plan;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['travel-plans'] }); onDone(); },
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <div className="space-y-4 pb-16">
      {err && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>}

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
        {plan.linkedTripNumber ? fact('Against request', plan.linkedTripNumber) : null}
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
            {plan.linkedTripNumber && <div className="text-xs font-medium text-emerald-600">🔗 Against request: {plan.linkedTripNumber}</div>}
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
