import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Spinner, EmptyState } from '../components/ui';

// ── Form data (from the "Site Forms" sheet) ─────────────────────────────────
const MANPOWER_TEAMS = ['Site Engineer', 'Safety Engineer', 'Puf Panel Team Supervisor', 'Panel Team', 'Fabrication Team', 'Refrigeration Team', 'Door Team'];
const OVERVIEW_ROWS = ['Blast Room', 'Freezer Room', 'Freezer Room 2', 'Chiller Room', 'Ambient Room', 'Corridor Room', 'Ante Room'];
const SECTIONS: { code: string; title: string; rows: [string, string][] }[] = [
  { code: 'A', title: 'Site Preparation & Civil Work', rows: [['Site measurement / marking', 'Job'], ['Floor level checking', 'Job'], ['Floor preparation', 'Sq.ft']] },
  { code: 'C', title: 'PUF Panel Installation', rows: [['Panel layout marking', 'Sq.ft'], ['Floor U-channel installation', 'Rmt'], ['Wall panel erection', 'Sq.ft'], ['Corner panel installation', 'Rmt'], ['Ceiling panel erection', 'Sq.ft'], ['Panel locking / cam-locking', 'Sq.ft'], ['Joint sealing', 'Rmt'], ['Silicone application', 'Rmt'], ['Internal flashing installation', 'Rmt'], ['External flashing installation', 'Rmt'], ['Panel gap filling', 'Rmt'], ['Panel cleaning', 'Sq.ft']] },
  { code: 'D', title: 'Door Installation', rows: [['Door opening marking', 'Nos.'], ['Door frame installation', 'Nos.'], ['Sliding door installation', 'Nos.'], ['Hinged door installation', 'Nos.'], ['Swing Hatch Manual Door', 'Nos.'], ['Door hardware installation', 'Nos.'], ['Door heater installation', 'Nos.'], ['Door gasket installation', 'Nos.'], ['Door alignment', 'Nos.'], ['Door testing', 'Nos.'], ['Air curtain installation', 'Nos.'], ['Strip Curtain installation', 'Nos.']] },
  { code: 'E', title: 'Refrigeration — IDU / ODU Installation', rows: [['IDU support installation', 'Nos.'], ['IDU installation', 'Nos.'], ['ODU foundation / support', 'Nos.'], ['ODU installation', 'Nos.'], ['Compressor installation', 'Nos.'], ['Condenser installation', 'Nos.'], ['Evaporator installation', 'Nos.'], ['Expansion valve installation', 'Nos.'], ['Drain piping', 'Rmt'], ['Refrigeration piping', 'Rmt'], ['Insulation of piping', 'Rmt'], ['Pipe support installation', 'Nos.']] },
  { code: 'F', title: 'Refrigeration Piping', rows: [['Suction line installation', 'Rmt'], ['Liquid line installation', 'Rmt'], ['Hot gas line installation', 'Rmt'], ['Copper pipe brazing', 'Joints'], ['Pipe pressure testing', 'Job'], ['Nitrogen pressure testing', 'Job'], ['Vacuuming', 'Job'], ['Refrigerant charging', 'Kg'], ['Pipe insulation', 'Rmt'], ['Piping dressing', 'Rmt']] },
  { code: 'G', title: 'Electrical Work', rows: [['Cable tray installation', 'Rmt'], ['Cable tray support', 'Nos.'], ['Power cable laying', 'Rmt'], ['Control cable laying', 'Rmt'], ['Cable termination', 'Nos.'], ['Cable dressing', 'Rmt'], ['Earthing connection', 'Nos.'], ['Controller installation', 'Nos.'], ['VFD installation', 'Nos.'], ['Sensor installation', 'Nos.'], ['Temperature sensor wiring', 'Nos.'], ['Controller programming', 'Job'], ['VFD programming', 'Job'], ['Communication wiring', 'Job'], ['RS-485 communication testing', 'Job'], ['PLC installation', 'Nos.'], ['Remote monitoring testing', 'Job']] },
];
const TC_ROWS = ['Electrical power checking', 'Phase sequence checking', 'Insulation resistance test', 'Refrigeration pressure test', 'Vacuum test', 'Refrigerant charging', 'Compressor trial', 'IDU fan trial', 'ODU fan trial', 'Controller trial', 'VFD trial', 'Temperature sensor testing', 'Room cooling trial', 'Final temperature achievement'];
const TEMP_ROOMS = ['Blast Room 1', 'Blast Room 2', 'Freezer Room', 'Chiller Room', 'Ambient Room', 'Ante Room'];
const SAFETY_ROWS: [string, [string, string]][] = [['Toolbox Talk', ['Done', 'Not Done']], ['PPE Compliance', ['OK', 'Not OK']], ['Work at Height Safety', ['OK', 'Not OK']], ['Scaffolding Inspection', ['OK', 'Not OK']], ['Electrical Safety', ['OK', 'Not OK']], ['Lifting / Material Handling Safety', ['OK', 'Not OK']], ['Fire Safety', ['OK', 'Not OK']], ['Housekeeping', ['OK', 'Not OK']], ['Near Miss / Incident', ['Yes', 'No']]];

export type Project = { id: string; name: string; clientName?: string; siteLocation?: string };
export type FormIO = {
  canEdit: boolean;
  projects: Project[];                       // auth: dropdown source (public: [])
  fixedProject?: Project | null;             // public: locked project from the assignment
  lockProject?: boolean;                      // public → show project read-only
  initial?: { dprDate?: string; engineerName?: string; data?: any };
  boqPreloaded?: any[];                        // public: BOQ delivered with the token
  uploadUrl: string;                          // POST photo
  uploadPdfUrl: string;                       // POST pdf
  onSubmit: (rec: { project: Project | null; dprDate: string; engineerName: string; data: any; submit: boolean }) => Promise<void>;
  assign?: { url: string; initialEmail?: string; initialToken?: string };  // auth only
};

async function uploadTo(file: File, url: string): Promise<string> {
  const fd = new FormData(); fd.append('file', file);
  return (await api.post(url, fd)).data.fileUrl as string;
}
const today = () => new Date().toISOString().slice(0, 10);

// ── Auth page (tab in top nav) ───────────────────────────────────────────────
export default function SiteForms() {
  const { canEdit } = useAuth();
  const canEditForms = canEdit('siteforms');
  const [view, setView] = useState<'site' | 'safety' | 'history'>('site');
  const [openId, setOpenId] = useState<string | null>(null);
  const projectsQ = useQuery({ queryKey: ['site-projects'], queryFn: async () => (await api.get('/projects')).data.projects as Project[] });
  const projects = projectsQ.data ?? [];

  const authIO = (type: 'SITE' | 'SAFETY'): FormIO => ({
    canEdit: canEditForms, projects,
    uploadUrl: '/site-forms/upload', uploadPdfUrl: '/site-forms/upload-pdf',
    onSubmit: async (rec) => { await api.post('/site-forms', { type, projectId: rec.project?.id || null, projectName: rec.project?.name || null, clientName: rec.project?.clientName || null, siteLocation: rec.project?.siteLocation || null, dprDate: rec.dprDate, engineerName: rec.engineerName, data: rec.data, submit: rec.submit }); },
    assign: { url: '/site-forms/assign' },
  });

  const seg = (v: typeof view, label: string) => (
    <button onClick={() => { setView(v); setOpenId(null); }} className={`rounded-lg px-4 py-2 text-sm font-medium ${view === v && !openId ? 'bg-navy text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{label}</button>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-navy">Site Forms — Daily Progress Report</h1>
        <p className="text-sm text-slate-500">Site-Engineer activity-wise DPR and Safety-Engineer checklist. Pick a project, fill the day's progress, and submit — or assign a no-login link to the engineer.</p>
      </div>
      <div className="mb-5 inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
        {seg('site', '🏗️ Site Engineer')}{seg('safety', '🦺 Safety Engineer')}{seg('history', '🗂️ History')}
      </div>
      {!canEditForms && view !== 'history' && !openId && <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">👁 View only — you don't have edit access to Site Forms. Ask an admin for the grant to submit.</div>}
      {openId ? <DprView id={openId} onBack={() => setOpenId(null)} />
        : projectsQ.isLoading ? <Spinner label="Loading…" />
        : view === 'site' ? <SiteForm io={authIO('SITE')} />
        : view === 'safety' ? <SafetyForm io={authIO('SAFETY')} />
        : <History onOpen={setOpenId} />}
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────
function ProjectPicker({ projects, value, onPick }: { projects: Project[]; value: string; onPick: (p: Project | null) => void }) {
  return (
    <select className="input" value={value} onChange={(e) => onPick(projects.find((p) => p.id === e.target.value) || null)}>
      <option value="">— Select project —</option>
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}
function PhotoCell({ url, uploadUrl, onUpload, disabled }: { url?: string; uploadUrl: string; onUpload: (u: string) => void; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  if (disabled) return url ? <a href={url} target="_blank" rel="noreferrer" className="text-xs text-navy underline">View</a> : <span className="text-slate-300">—</span>;
  return (
    <label className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium ${url ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-dashed border-rose-300 text-rose-500'}`} title={url ? 'Photo added' : 'Photo required'}>
      📷 {busy ? '…' : url ? <a href={url} target="_blank" rel="noreferrer" className="underline">View</a> : 'Photo'}
      <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); try { onUpload(await uploadTo(f, uploadUrl)); } catch (err) { alert(errMsg(err)); } finally { setBusy(false); (e.currentTarget as HTMLInputElement).value = ''; } }} />
    </label>
  );
}
const Card = ({ code, title, hint, children }: { code: string; title: string; hint?: string; children: React.ReactNode }) => (
  <div className="mb-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
      <span className="grid h-6 min-w-6 place-items-center rounded-md bg-navy px-1.5 text-xs font-bold text-white">{code}</span>
      <h2 className="text-[15px] font-semibold text-slate-700">{title}</h2>
      {hint && <span className="ml-auto text-[11px] text-slate-400">{hint}</span>}
    </div>
    <div className="p-4">{children}</div>
  </div>
);

// Assign-to-engineer card (auth only) — no-login link, same idea as the GRN flow.
function AssignCard({ io, who, projectId, projectName, clientName, siteLocation, dprDate }: { io: FormIO; who: 'Site Engineer' | 'Safety Engineer'; projectId?: string; projectName?: string; clientName?: string; siteLocation?: string; dprDate: string }) {
  const [email, setEmail] = useState(io.assign?.initialEmail || '');
  const [link, setLink] = useState(io.assign?.initialToken ? `${window.location.origin}/site-forms/${io.assign.initialToken}` : '');
  const [copied, setCopied] = useState('');
  const [msg, setMsg] = useState('');
  const type = who === 'Safety Engineer' ? 'SAFETY' : 'SITE';
  const send = useMutation({
    mutationFn: async () => (await api.post(io.assign!.url, { type, projectId: projectId || null, projectName: projectName || null, clientName: clientName || null, siteLocation: siteLocation || null, dprDate, email })).data as { link: string; emailed: boolean },
    onSuccess: (r) => { setLink(r.link); setMsg(r.emailed ? `Link sent to ${email}.` : `Link generated — email not configured, copy it below.`); },
    onError: (e) => setMsg(errMsg(e)),
  });
  if (!io.assign) return null;
  return (
    <Card code="📧" title={`Assign to ${who}`} hint="no-login link">
      <p className="mb-3 text-xs text-slate-400">Send a no-login link to the {who.toLowerCase()} to fill this DPR — or copy the link and share it manually.</p>
      {msg && <div className="mb-2 rounded bg-slate-50 px-3 py-1.5 text-xs text-slate-600">{msg}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[240px] flex-1"><label className="label">{who} Email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="engineer@example.com" /></div>
        <button className="btn-primary text-sm" disabled={send.isPending || !email} onClick={() => send.mutate()}>📧 {link ? 'Resend Link' : 'Send Link'}</button>
      </div>
      {link && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <a href={link} target="_blank" rel="noreferrer" className="flex-1 truncate text-xs text-navy hover:underline">{link}</a>
          <button className="btn-outline text-xs" onClick={() => { navigator.clipboard?.writeText(link); setCopied('✓ Copied'); setTimeout(() => setCopied(''), 1500); }}>{copied || '📋 Copy link'}</button>
        </div>
      )}
    </Card>
  );
}

// ── SITE ENGINEER FORM ───────────────────────────────────────────────────────
export function SiteForm({ io }: { io: FormIO }) {
  const init = io.initial?.data || {};
  const [project, setProject] = useState<Project | null>(io.fixedProject ?? null);
  const [dprDate, setDprDate] = useState(io.initial?.dprDate || today());
  const [engineer, setEngineer] = useState(io.initial?.engineerName || '');
  const [manpowerTotal, setManpowerTotal] = useState(init.manpowerTotal || '');
  const [manpower, setManpower] = useState<Record<string, any>>(init.manpower || {});
  const [overview, setOverview] = useState<Record<string, any>>(init.overview || {});
  const [act, setAct] = useState<Record<string, any>>(init.activities || {});
  const [tc, setTc] = useState<Record<string, any>>(init.testing || {});
  const [temp, setTemp] = useState<Record<string, any>>(init.temperature || {});
  const [issues, setIssues] = useState<any[]>(init.issues?.length ? init.issues : [{}, {}]);
  const [tomorrow, setTomorrow] = useState<any[]>(init.tomorrow?.length ? init.tomorrow : [{}, {}, {}]);
  const [boqToday, setBoqToday] = useState<Record<string, number>>(init.boqToday || {});
  const [msg, setMsg] = useState('');
  const dis = !io.canEdit;

  const boqQ = useQuery({
    queryKey: ['site-boq', project?.id],
    queryFn: async () => (await api.get(`/site-forms/project-boq/${project!.id}`)).data.items as any[],
    enabled: !io.boqPreloaded && !!project?.id,
  });
  const boqItems = io.boqPreloaded ?? boqQ.data ?? [];

  const setA = (k: string, patch: any) => setAct((m) => ({ ...m, [k]: { ...m[k], ...patch } }));
  const setT = (k: string, patch: any) => setTc((m) => ({ ...m, [k]: { ...m[k], ...patch } }));
  const setTp = (k: string, patch: any) => setTemp((m) => ({ ...m, [k]: { ...m[k], ...patch } }));
  const setMp = (k: string, patch: any) => setManpower((m) => ({ ...m, [k]: { ...m[k], ...patch } }));
  const setOv = (k: string, patch: any) => setOverview((m) => ({ ...m, [k]: { ...m[k], ...patch } }));

  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      // Persist each team's Total = Skilled + Helper (the displayed value is computed).
      const manpowerOut = Object.fromEntries(MANPOWER_TEAMS.map((t) => [t, { ...(manpower[t] || {}), total: (Number(manpower[t]?.skilled) || 0) + (Number(manpower[t]?.helper) || 0) }]));
      const data = { manpowerTotal, manpower: manpowerOut, overview, activities: act, testing: tc, temperature: temp, issues, tomorrow, boqToday };
      await io.onSubmit({ project, dprDate, engineerName: engineer, data, submit });
    },
    onSuccess: () => { setMsg('✓ Site DPR saved.'); qc.invalidateQueries({ queryKey: ['site-dprs'] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  const boqOrder = useMemo(() => {
    const rem = (b: any) => Math.round((b.plannedQty - (b.installedQty + (+boqToday[b.id] || 0))) * 1000) / 1000;
    return [...boqItems].map((b) => ({ b, rem: rem(b) })).sort((x, y) => (x.rem <= 0 ? 1 : 0) - (y.rem <= 0 ? 1 : 0));
  }, [boqItems, boqToday]);

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</div>}
      <Card code="1" title="Project Details">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label">Project *</label>{io.lockProject ? <input className="input bg-slate-50" value={project?.name || ''} readOnly /> : <ProjectPicker projects={io.projects} value={project?.id || ''} onPick={setProject} />}</div>
          <div><label className="label">Client / Company</label><input className="input bg-slate-50" value={project?.clientName || ''} readOnly placeholder="auto from project" /></div>
          <div><label className="label">Site Location</label><input className="input bg-slate-50" value={project?.siteLocation || ''} readOnly placeholder="auto from project" /></div>
          <div><label className="label">DPR Date *</label><input type="date" className="input" value={dprDate} onChange={(e) => setDprDate(e.target.value)} disabled={dis} /></div>
          <div><label className="label">Site Engineer *</label><input className="input" value={engineer} onChange={(e) => setEngineer(e.target.value)} placeholder="Name" disabled={dis} /></div>
          <div><label className="label">Total Manpower</label><input type="number" min={0} className="input" value={manpowerTotal} onChange={(e) => setManpowerTotal(e.target.value)} placeholder="0" disabled={dis} /></div>
        </div>
      </Card>

      {io.assign && <AssignCard io={io} who="Site Engineer" projectId={project?.id} projectName={project?.name} clientName={project?.clientName} siteLocation={project?.siteLocation} dprDate={dprDate} />}

      <Card code="M" title="Manpower — Activity Wise" hint="Skilled + Helper + hours per team">
        <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">Team</th><th>Skilled</th><th>Helper</th><th>Total</th><th>Working Hours</th></tr></thead>
          <tbody>{MANPOWER_TEAMS.map((t) => (
            <tr key={t} className="border-t border-slate-100"><td className="py-1 font-medium text-slate-600">{t}</td>
              {['skilled', 'helper', 'total', 'hours'].map((f) => f === 'total'
                ? <td key={f}><input type="number" className="input h-8 w-20 text-right text-xs bg-slate-50 font-semibold text-navy" value={((Number(manpower[t]?.skilled) || 0) + (Number(manpower[t]?.helper) || 0)) || ''} readOnly tabIndex={-1} title="Skilled + Helper (auto)" /></td>
                : <td key={f}><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={manpower[t]?.[f] ?? ''} onChange={(e) => setMp(t, { [f]: e.target.value })} placeholder="0" disabled={dis} /></td>)}
            </tr>))}</tbody>
        </table></div>
      </Card>

      <Card code="◱" title="Project Overview — Scope" hint="room-wise quantities">
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">Room / Area</th><th>Wall Panel (sq.m)</th><th>Ceiling (sq.m)</th><th>PUF Slab (sq.m)</th><th>Door (Nos.)</th><th>Machine (Nos.)</th></tr></thead>
          <tbody>{OVERVIEW_ROWS.map((r) => (
            <tr key={r} className="border-t border-slate-100"><td className="py-1 font-medium text-slate-600">{r}</td>
              {['wall', 'ceiling', 'puf', 'door', 'machine'].map((f) => <td key={f}><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={overview[r]?.[f] ?? ''} onChange={(e) => setOv(r, { [f]: e.target.value })} placeholder="0" disabled={dis} /></td>)}
            </tr>))}</tbody>
        </table></div>
      </Card>

      {SECTIONS.map((sec) => (
        <Card key={sec.code} code={sec.code} title={sec.title} hint="photo per completed activity">
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
            <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">#</th><th>Activity</th><th>Unit</th><th>Previous</th><th>Today</th><th>Till Date</th><th>Remarks</th><th>Photo</th></tr></thead>
            <tbody>{sec.rows.map(([name, unit], i) => { const k = `${sec.code}_${i}`; const v = act[k] || {}; return (
              <tr key={k} className="border-t border-slate-100">
                <td className="py-1 text-xs text-slate-400">{i + 1}</td>
                <td className="font-medium text-slate-600">{name}</td>
                <td><span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{unit}</span></td>
                <td><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={v.prev ?? ''} onChange={(e) => setA(k, { prev: e.target.value })} placeholder="0" disabled={dis} /></td>
                <td><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={v.today ?? ''} onChange={(e) => setA(k, { today: e.target.value })} placeholder="0" disabled={dis} /></td>
                <td><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={v.till ?? ''} onChange={(e) => setA(k, { till: e.target.value })} placeholder="0" disabled={dis} /></td>
                <td><input className="input h-8 w-32 text-xs" value={v.rem ?? ''} onChange={(e) => setA(k, { rem: e.target.value })} placeholder="—" disabled={dis} /></td>
                <td><PhotoCell url={v.photo} uploadUrl={io.uploadUrl} onUpload={(u) => setA(k, { photo: u })} disabled={dis} /></td>
              </tr>); })}</tbody>
          </table></div>
        </Card>
      ))}

      <Card code="I" title="Testing & Commissioning">
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">#</th><th>Activity</th><th>Status</th><th>Date</th><th>Reading / Result</th><th>Remarks</th><th>Photo</th></tr></thead>
          <tbody>{TC_ROWS.map((a, i) => { const v = tc[i] || {}; return (
            <tr key={i} className="border-t border-slate-100">
              <td className="py-1 text-xs text-slate-400">{i + 1}</td><td className="font-medium text-slate-600">{a}</td>
              <td><select className="input h-8 text-xs" value={v.status ?? ''} onChange={(e) => setT(String(i), { status: e.target.value })} disabled={dis}><option value="">—</option><option>Pending</option><option>In progress</option><option>Passed</option><option>Failed</option></select></td>
              <td><input type="date" className="input h-8 text-xs" value={v.date ?? ''} onChange={(e) => setT(String(i), { date: e.target.value })} disabled={dis} /></td>
              <td><input className="input h-8 w-28 text-xs" value={v.reading ?? ''} onChange={(e) => setT(String(i), { reading: e.target.value })} placeholder="reading" disabled={dis} /></td>
              <td><input className="input h-8 w-28 text-xs" value={v.rem ?? ''} onChange={(e) => setT(String(i), { rem: e.target.value })} placeholder="—" disabled={dis} /></td>
              <td><PhotoCell url={v.photo} uploadUrl={io.uploadUrl} onUpload={(u) => setT(String(i), { photo: u })} disabled={dis} /></td>
            </tr>); })}</tbody>
        </table></div>
      </Card>

      <Card code="J" title="Temperature Monitoring" hint="start → 2 / 4 / 6 / 8 hr → final">
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">Room / Area</th><th>Required</th><th>Start</th><th>2 Hr</th><th>4 Hr</th><th>6 Hr</th><th>8 Hr</th><th>Final</th><th>Status</th></tr></thead>
          <tbody>{TEMP_ROOMS.map((r, i) => { const v = temp[i] || {}; return (
            <tr key={i} className="border-t border-slate-100"><td className="py-1 font-medium text-slate-600">{r}</td>
              {['req', 'start', 't2', 't4', 't6', 't8', 'final'].map((f) => <td key={f}><input className="input h-8 w-16 text-right text-xs" value={v[f] ?? ''} onChange={(e) => setTp(String(i), { [f]: e.target.value })} placeholder={f === 'req' ? '-30°C' : '0'} disabled={dis} /></td>)}
              <td><select className="input h-8 text-xs" value={v.status ?? ''} onChange={(e) => setTp(String(i), { status: e.target.value })} disabled={dis}><option value="">—</option><option>Achieved</option><option>In progress</option><option>Not achieved</option></select></td>
            </tr>); })}</tbody>
        </table></div>
      </Card>

      <Card code="L" title="Site Issues / Blockers">
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">#</th><th>Issue</th><th>Since Date</th><th>Impact</th><th>Responsible</th><th>Action Required</th><th></th></tr></thead>
          <tbody>{issues.map((row, i) => (
            <tr key={i} className="border-t border-slate-100"><td className="py-1 text-xs text-slate-400">{i + 1}</td>
              {['issue', 'since', 'impact', 'person', 'action'].map((f) => <td key={f}>{f === 'since' ? <input type="date" className="input h-8 text-xs" value={row[f] ?? ''} onChange={(e) => setIssues((a) => a.map((x, j) => j === i ? { ...x, [f]: e.target.value } : x))} disabled={dis} /> : <input className="input h-8 text-xs" value={row[f] ?? ''} onChange={(e) => setIssues((a) => a.map((x, j) => j === i ? { ...x, [f]: e.target.value } : x))} placeholder="—" disabled={dis} />}</td>)}
              <td>{!dis && <button className="text-slate-300 hover:text-rose-500" onClick={() => setIssues((a) => a.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>))}</tbody>
        </table></div>
        {!dis && <button className="mt-2 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-navy" onClick={() => setIssues((a) => [...a, {}])}>+ Add issue</button>}
      </Card>

      <Card code="O" title="Tomorrow's Activity Plan">
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">#</th><th>Activity</th><th>Planned Qty.</th><th>Dependency / Material Required</th><th></th></tr></thead>
          <tbody>{tomorrow.map((row, i) => (
            <tr key={i} className="border-t border-slate-100"><td className="py-1 text-xs text-slate-400">{i + 1}</td>
              <td><input className="input h-8 text-xs" value={row.activity ?? ''} onChange={(e) => setTomorrow((a) => a.map((x, j) => j === i ? { ...x, activity: e.target.value } : x))} placeholder="activity" disabled={dis} /></td>
              <td><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={row.qty ?? ''} onChange={(e) => setTomorrow((a) => a.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} placeholder="0" disabled={dis} /></td>
              <td><input className="input h-8 text-xs" value={row.dep ?? ''} onChange={(e) => setTomorrow((a) => a.map((x, j) => j === i ? { ...x, dep: e.target.value } : x))} placeholder="dependency / material" disabled={dis} /></td>
              <td>{!dis && <button className="text-slate-300 hover:text-rose-500" onClick={() => setTomorrow((a) => a.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>))}</tbody>
        </table></div>
        {!dis && <button className="mt-2 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-navy" onClick={() => setTomorrow((a) => [...a, {}])}>+ Add activity</button>}
      </Card>

      <Card code="B" title="BOQ — Today's Installation" hint="from the selected project · completed items drop to the bottom">
        {!project ? <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-400">Select a project above to load its BOQ.</div>
          : (!io.boqPreloaded && boqQ.isLoading) ? <Spinner label="Loading BOQ…" />
          : boqItems.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center text-sm text-slate-400">No BOQ items on this project yet.</div>
          : <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm">
              <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">#</th><th>BOQ Item</th><th>Head</th><th>Unit</th><th>Planned</th><th>Till Date</th><th>Today</th><th>Remaining</th><th>Status</th></tr></thead>
              <tbody>{boqOrder.map(({ b, rem }, pos) => { const done = rem <= 0; return (
                <tr key={b.id} className={`border-t border-slate-100 ${done ? 'bg-emerald-50' : ''}`}>
                  <td className="py-1 text-xs text-slate-400">{pos + 1}</td>
                  <td className="font-medium text-slate-600">{b.srNo ? `${b.srNo}. ` : ''}{b.description}</td>
                  <td className="text-slate-500">{b.head || '—'}</td>
                  <td><span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{b.unit || '—'}</span></td>
                  <td className="tabular-nums">{b.plannedQty}</td>
                  <td className="tabular-nums">{b.installedQty}</td>
                  <td><input type="number" min={0} className="input h-8 w-20 text-right text-xs" value={boqToday[b.id] ?? ''} onChange={(e) => setBoqToday((m) => ({ ...m, [b.id]: Number(e.target.value) }))} placeholder="0" disabled={dis} /></td>
                  <td className="tabular-nums">{Math.max(0, rem)}</td>
                  <td>{done ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">✓ Completed</span> : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">Pending</span>}</td>
                </tr>); })}</tbody>
            </table></div>}
      </Card>

      {!dis && (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white/90 py-3 backdrop-blur">
          <button className="btn-outline" disabled={save.isPending} onClick={() => save.mutate(false)}>Save draft</button>
          <button className="btn-primary" disabled={save.isPending || !project || !engineer} onClick={() => save.mutate(true)}>Submit DPR</button>
        </div>
      )}
    </div>
  );
}

// ── SAFETY ENGINEER FORM ───────────────────────────────────────────────────────
export function SafetyForm({ io }: { io: FormIO }) {
  const init = io.initial?.data || {};
  const [project, setProject] = useState<Project | null>(io.fixedProject ?? null);
  const [dprDate, setDprDate] = useState(io.initial?.dprDate || today());
  const [engineer, setEngineer] = useState(io.initial?.engineerName || '');
  const [status, setStatus] = useState<Record<string, string>>(init.checklist || {});
  const [remarks, setRemarks] = useState<Record<string, string>>(init.remarks || {});
  const [tbt, setTbt] = useState(init.tbtPdfUrl || '');
  const [tbtBusy, setTbtBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const dis = !io.canEdit;
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async (submit: boolean) => { await io.onSubmit({ project, dprDate, engineerName: engineer, data: { checklist: status, remarks, tbtPdfUrl: tbt }, submit }); },
    onSuccess: () => { setMsg('✓ Safety DPR saved.'); qc.invalidateQueries({ queryKey: ['site-dprs'] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  return (
    <div>
      {msg && <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</div>}
      <Card code="1" title="Project Details">
        <div className="grid gap-3 sm:grid-cols-3">
          <div><label className="label">Project *</label>{io.lockProject ? <input className="input bg-slate-50" value={project?.name || ''} readOnly /> : <ProjectPicker projects={io.projects} value={project?.id || ''} onPick={setProject} />}</div>
          <div><label className="label">Client / Company</label><input className="input bg-slate-50" value={project?.clientName || ''} readOnly placeholder="auto from project" /></div>
          <div><label className="label">Site Location</label><input className="input bg-slate-50" value={project?.siteLocation || ''} readOnly placeholder="auto from project" /></div>
          <div><label className="label">DPR Date *</label><input type="date" className="input" value={dprDate} onChange={(e) => setDprDate(e.target.value)} disabled={dis} /></div>
          <div><label className="label">Safety Engineer *</label><input className="input" value={engineer} onChange={(e) => setEngineer(e.target.value)} placeholder="Name" disabled={dis} /></div>
        </div>
      </Card>

      {io.assign && <AssignCard io={io} who="Safety Engineer" projectId={project?.id} projectName={project?.name} clientName={project?.clientName} siteLocation={project?.siteLocation} dprDate={dprDate} />}

      <Card code="✓" title="Safety Checklist" hint="mark each + add remarks">
        <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm">
          <thead><tr className="text-left text-[10px] uppercase text-slate-400"><th className="py-1">Safety Activity</th><th>Status</th><th>Remarks</th></tr></thead>
          <tbody>{SAFETY_ROWS.map(([name, opts]) => { const cur = status[name]; return (
            <tr key={name} className="border-t border-slate-100"><td className="py-1 font-medium text-slate-600">{name}</td>
              <td><div className="inline-flex overflow-hidden rounded-lg border border-slate-200">
                {opts.map((o, oi) => { const on = cur === o; const good = oi === 0; return (
                  <button key={o} disabled={dis} onClick={() => setStatus((m) => ({ ...m, [name]: o }))} className={`border-r border-slate-200 px-3 py-1.5 text-xs font-semibold last:border-r-0 ${on ? (good ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700') : 'bg-white text-slate-500'}`}>{o}</button>
                ); })}
              </div></td>
              <td><input className="input h-8 text-xs" value={remarks[name] ?? ''} onChange={(e) => setRemarks((m) => ({ ...m, [name]: e.target.value }))} placeholder="remarks" disabled={dis} /></td>
            </tr>); })}</tbody>
        </table></div>
      </Card>

      <Card code="⇪" title="Daily Toolbox Talk (TBT)" hint="PDF upload">
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium ${tbt ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-dashed border-slate-300 text-navy'}`}>
          ⇪ {tbtBusy ? 'Uploading…' : tbt ? <a href={tbt} target="_blank" rel="noreferrer" className="underline">View TBT PDF</a> : 'Choose TBT PDF'}
          <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={dis} onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setTbtBusy(true); try { setTbt(await uploadTo(f, io.uploadPdfUrl)); } catch (err) { alert(errMsg(err)); } finally { setTbtBusy(false); (e.currentTarget as HTMLInputElement).value = ''; } }} />
        </label>
      </Card>

      {!dis && (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white/90 py-3 backdrop-blur">
          <button className="btn-outline" disabled={save.isPending} onClick={() => save.mutate(false)}>Save draft</button>
          <button className="btn-primary" disabled={save.isPending || !project || !engineer} onClick={() => save.mutate(true)}>Submit DPR</button>
        </div>
      )}
    </div>
  );
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
function History({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['site-dprs'], queryFn: async () => (await api.get('/site-forms')).data.dprs as any[] });
  if (q.isLoading) return <Spinner label="Loading…" />;
  const rows = q.data ?? [];
  if (!rows.length) return <EmptyState title="No DPRs yet" hint="Submit a Site or Safety DPR to see it here." />;
  const fmt = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-slate-50 text-left text-[10px] uppercase text-slate-400"><tr><th className="px-4 py-2">DPR No.</th><th>Type</th><th>Project</th><th>Date</th><th>Engineer</th><th>Filed by</th><th>Status</th><th></th></tr></thead>
        <tbody>{rows.map((d) => (
          <tr key={d.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => onOpen(d.id)}>
            <td className="px-4 py-2 font-medium text-navy">{d.dprNumber || '—'}</td>
            <td>{d.type === 'SAFETY' ? <span className="rounded bg-cyan-100 px-2 py-0.5 text-[11px] text-cyan-700">🦺 Safety</span> : <span className="rounded bg-indigo-100 px-2 py-0.5 text-[11px] text-indigo-700">🏗️ Site</span>}</td>
            <td className="text-slate-600">{d.projectName || '—'}</td>
            <td className="text-slate-500">{d.dprDate ? fmt(d.dprDate) : '—'}</td>
            <td className="text-slate-500">{d.engineerName || '—'}</td>
            <td className="text-slate-500">{d.createdByName || '—'}</td>
            <td><span className={`rounded px-2 py-0.5 text-[11px] font-medium ${d.status === 'SUBMITTED' ? 'bg-green-100 text-green-700' : d.status === 'ASSIGNED' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>{d.status === 'SUBMITTED' ? 'Submitted' : d.status === 'ASSIGNED' ? 'Assigned' : 'Draft'}</span></td>
            <td className="pr-4 text-right text-xs font-medium text-navy hover:underline">Open →</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

// Read-only view of a saved DPR (opened from History) — the same form, locked.
function DprView({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useQuery({ queryKey: ['site-dpr', id], queryFn: async () => (await api.get(`/site-forms/${id}`)).data.dpr as any });
  if (q.isLoading) return <Spinner label="Loading DPR…" />;
  const d = q.data;
  if (!d) return <div className="text-sm text-slate-500">DPR not found.</div>;
  const project: Project | null = (d.projectId || d.projectName) ? { id: d.projectId || '', name: d.projectName || '', clientName: d.clientName, siteLocation: d.siteLocation } : null;
  const io: FormIO = {
    canEdit: false, projects: [], fixedProject: project, lockProject: true,
    initial: { dprDate: d.dprDate ? new Date(d.dprDate).toISOString().slice(0, 10) : undefined, engineerName: d.engineerName || '', data: d.data || {} },
    uploadUrl: '/site-forms/upload', uploadPdfUrl: '/site-forms/upload-pdf',
    onSubmit: async () => { /* read-only */ },
  };
  const statusPill = d.status === 'SUBMITTED' ? 'bg-green-100 text-green-700' : d.status === 'ASSIGNED' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700';
  return (
    <div>
      <button className="mb-3 text-sm font-medium text-navy hover:underline" onClick={onBack}>← Back to history</button>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
        <span className="font-semibold text-navy">{d.dprNumber}</span>
        <span>· {d.type === 'SAFETY' ? 'Safety Engineer' : 'Site Engineer'} DPR</span>
        <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${statusPill}`}>{d.status === 'SUBMITTED' ? 'Submitted' : d.status === 'ASSIGNED' ? 'Assigned' : 'Draft'}</span>
        <span className="ml-auto text-xs text-slate-400">Filed by {d.createdByName || '—'} · view only</span>
      </div>
      {d.type === 'SAFETY' ? <SafetyForm io={io} /> : <SiteForm io={io} />}
    </div>
  );
}
