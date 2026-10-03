import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Spinner, EmptyState } from '../components/ui';

type Rec = { id: string; userId?: string; userName?: string; type: string; selfieUrl?: string; lat?: number; lng?: number; accuracy?: number; address?: string; geoAddress?: string; projectName?: string; at: string };
type Project = { id: string; name: string };

const fmtTime = (s: string) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const mapLink = (lat?: number, lng?: number) => (lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : null);

// Register location cell — shows the stored address, or (for older punches saved
// before addresses were captured) resolves it on the fly from the coordinates.
// Cached by rounded coords so the same spot is only looked up once.
const geoCache = new Map<string, string>();
function LocationCell({ r }: { r: Rec }) {
  const [addr, setAddr] = useState(r.geoAddress || '');
  useEffect(() => {
    if (addr || r.lat == null || r.lng == null) return;
    const key = `${r.lat.toFixed(5)},${r.lng.toFixed(5)}`;
    if (geoCache.has(key)) { setAddr(geoCache.get(key)!); return; }
    let cancelled = false;
    fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${r.lat}&lon=${r.lng}`)
      .then((x) => (x.ok ? x.json() : null))
      .then((j) => { if (j?.display_name && !cancelled) { geoCache.set(key, j.display_name as string); setAddr(j.display_name as string); } })
      .catch(() => { /* coords stay */ });
    return () => { cancelled = true; };
  }, [r.lat, r.lng, addr]);
  if (r.lat == null || r.lng == null) return <span className="text-slate-300">—</span>;
  return (
    <div className="max-w-[280px]">
      <a href={mapLink(r.lat, r.lng)!} target="_blank" rel="noreferrer" className="text-xs text-navy hover:underline">📍 {r.lat.toFixed(4)}, {r.lng.toFixed(4)}</a>
      {addr && <div className="text-[11px] leading-snug text-slate-500">🏠 {addr}</div>}
    </div>
  );
}

// Live-camera selfie — opens the device camera and captures a frame. No gallery /
// file-upload path, so the photo is always taken in real time at punch.
function SelfieCapture({ value, onCapture }: { value: string; onCapture: (url: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const stop = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  useEffect(() => () => stop(), []);

  const openCam = async () => {
    setErr('');
    if (!navigator.mediaDevices?.getUserMedia) { setErr('Camera not supported on this device/browser.'); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      streamRef.current = s; setOpen(true);
      requestAnimationFrame(() => { if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.play().catch(() => {}); } });
    } catch (e: any) { setErr(e?.name === 'NotAllowedError' ? 'Camera access denied — allow the camera and retry.' : (e?.message || 'Could not open the camera.')); }
  };
  const capture = () => {
    const v = videoRef.current; if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    setBusy(true);
    canvas.toBlob(async (blob) => {
      if (!blob) { setBusy(false); return; }
      try {
        const fd = new FormData(); fd.append('file', new File([blob], `selfie-${Date.now()}.jpg`, { type: 'image/jpeg' }));
        onCapture((await api.post('/attendance/upload', fd)).data.fileUrl);
        stop(); setOpen(false);
      } catch (e) { alert(errMsg(e)); } finally { setBusy(false); }
    }, 'image/jpeg', 0.85);
  };
  const cancel = () => { stop(); setOpen(false); };

  if (open) return (
    <div>
      <video ref={videoRef} playsInline muted className="w-full max-w-xs rounded-lg border border-slate-200 bg-black" style={{ transform: 'scaleX(-1)' }} />
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-primary text-sm" disabled={busy} onClick={capture}>{busy ? 'Saving…' : '📸 Capture'}</button>
        <button type="button" className="btn-outline text-sm" onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
  return value
    ? <div className="flex items-center gap-3"><img src={value} alt="selfie" className="h-20 w-20 rounded-lg object-cover" /><button type="button" className="text-xs font-medium text-navy hover:underline" onClick={openCam}>Retake</button></div>
    : <><button type="button" className="flex h-20 w-full items-center justify-center rounded-lg border border-dashed border-slate-300 text-sm font-medium text-navy hover:bg-slate-50" onClick={openCam}>📸 Take selfie (live camera)</button>{err && <p className="mt-1 text-xs text-rose-500">{err}</p>}</>;
}

export default function Attendance() {
  const { canEdit, isAdmin } = useAuth();
  const canPunch = canEdit('attendance');
  const [tab, setTab] = useState<'punch' | 'register'>('punch');
  const seg = (v: typeof tab, label: string) => (
    <button onClick={() => setTab(v)} className={`rounded-lg px-4 py-2 text-sm font-medium ${tab === v ? 'bg-navy text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{label}</button>
  );
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-navy">Attendance</h1>
        <p className="text-sm text-slate-500">Punch in / out from site with a selfie, your GPS location and the time.</p>
      </div>
      <div className="mb-5 inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
        {seg('punch', '📸 Punch')}{seg('register', isAdmin ? '🗂️ Register (all)' : '🗂️ My records')}
      </div>
      {tab === 'punch' ? <PunchPanel canPunch={canPunch} /> : <Register isAdmin={isAdmin} />}
    </div>
  );
}

function PunchPanel({ canPunch }: { canPunch: boolean }) {
  const qc = useQueryClient();
  const mineQ = useQuery({ queryKey: ['attendance-mine'], queryFn: async () => (await api.get('/attendance/mine')).data.records as Rec[] });
  const projectsQ = useQuery({ queryKey: ['att-projects'], queryFn: async () => (await api.get('/projects')).data.projects as Project[] });
  const projects = projectsQ.data ?? [];
  const records = mineQ.data ?? [];
  const lastToday = useMemo(() => {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    return records.find((r) => new Date(r.at) >= t0);
  }, [records]);
  const nextType: 'IN' | 'OUT' = lastToday?.type === 'IN' ? 'OUT' : 'IN';

  const [selfie, setSelfie] = useState('');
  const [loc, setLoc] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [locBusy, setLocBusy] = useState(false);
  const [locErr, setLocErr] = useState('');
  const [geoAddress, setGeoAddress] = useState('');
  const [projectId, setProjectId] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');

  const captureLocation = () => {
    setLocErr(''); setLocBusy(true);
    if (!navigator.geolocation) { setLocErr('Location not supported on this device.'); setLocBusy(false); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const lat = p.coords.latitude, lng = p.coords.longitude;
        setLoc({ lat, lng, accuracy: p.coords.accuracy }); setLocBusy(false); setGeoAddress('');
        // Best-effort reverse geocode (free OpenStreetMap Nominatim) — turns the
        // coordinates into a readable street address. A failure just leaves coords.
        fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => { if (j?.display_name) setGeoAddress(j.display_name as string); })
          .catch(() => { /* keep coords only */ });
      },
      (e) => { setLocErr(e.message || 'Could not get location — allow location access and retry.'); setLocBusy(false); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  };
  const punch = useMutation({
    mutationFn: async () => {
      const proj = projects.find((p) => p.id === projectId);
      return api.post('/attendance/punch', { type: nextType, selfieUrl: selfie || null, lat: loc?.lat ?? null, lng: loc?.lng ?? null, accuracy: loc?.accuracy ?? null, address: note || null, geoAddress: geoAddress || null, projectId: projectId || null, projectName: proj?.name || null });
    },
    onSuccess: () => { setMsg(`✓ Punched ${nextType} at ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`); setSelfie(''); setLoc(null); setNote(''); setGeoAddress(''); qc.invalidateQueries({ queryKey: ['attendance-mine'] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  if (mineQ.isLoading) return <Spinner label="Loading…" />;
  const ready = !!selfie && !!loc;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
      {/* Punch card */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        {msg && <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</div>}
        {!canPunch ? <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">👁 You don't have access to punch. Ask an admin for the Attendance grant.</div> : <>
          <div className="mb-4 flex items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ${lastToday?.type === 'IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{lastToday?.type === 'IN' ? '🟢 Currently IN' : lastToday ? 'Last: OUT' : 'Not punched today'}</span>
            {lastToday && <span className="text-xs text-slate-400">last at {fmtTime(lastToday.at)}</span>}
          </div>

          <div className="mb-3">
            <label className="label">Selfie * <span className="font-normal text-slate-400">(live camera)</span></label>
            <SelfieCapture value={selfie} onCapture={setSelfie} />
          </div>

          <div className="mb-3">
            <label className="label">Location *</label>
            {loc
              ? <div className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  <div className="flex flex-wrap items-center gap-2">📍 {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)} <span className="text-emerald-500">(±{Math.round(loc.accuracy)}m)</span><a href={mapLink(loc.lat, loc.lng)!} target="_blank" rel="noreferrer" className="underline">Map</a><button className="ml-auto text-emerald-600 hover:underline" onClick={captureLocation}>Refresh</button></div>
                  {geoAddress && <div className="mt-1 text-emerald-800">🏠 {geoAddress}</div>}
                </div>
              : <button className="btn-outline w-full text-sm" disabled={locBusy} onClick={captureLocation}>{locBusy ? 'Getting location…' : '📍 Capture my location'}</button>}
            {locErr && <p className="mt-1 text-xs text-rose-500">{locErr}</p>}
          </div>

          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <div><label className="label">Project / Site (optional)</label><select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div><label className="label">Note / Pincode (optional)</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. 462010 / gate 2" /></div>
          </div>

          <button className={`w-full rounded-xl py-3 text-base font-semibold text-white ${nextType === 'IN' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'} disabled:opacity-50`} disabled={!ready || punch.isPending} onClick={() => punch.mutate()}>
            {punch.isPending ? 'Saving…' : nextType === 'IN' ? '🟢 Punch IN' : '🔴 Punch OUT'}
          </button>
          {!ready && <p className="mt-2 text-center text-xs text-slate-400">Take a selfie and capture your location to punch.</p>}
        </>}
      </div>

      {/* Today / recent */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-2 text-sm font-semibold text-slate-600">My recent punches</div>
        {records.length === 0 ? <div className="py-8 text-center text-sm text-slate-400">No punches yet.</div> : (
          <div className="space-y-2">
            {records.slice(0, 12).map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-2">
                {r.selfieUrl ? <img src={r.selfieUrl} alt="" className="h-9 w-9 rounded object-cover" /> : <div className="h-9 w-9 rounded bg-slate-100" />}
                <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${r.type === 'IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{r.type}</span>
                <span className="text-sm text-slate-600">{fmtTime(r.at)}</span>
                {mapLink(r.lat, r.lng) && <a href={mapLink(r.lat, r.lng)!} target="_blank" rel="noreferrer" className="ml-auto text-xs text-navy hover:underline">📍 Map</a>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const onlyTime = (s: string) => new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function workedHours(inAt?: string, outAt?: string): string | null {
  if (!inAt || !outAt) return null;
  const ms = new Date(outAt).getTime() - new Date(inAt).getTime();
  if (ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

function Register({ isAdmin }: { isAdmin: boolean }) {
  const [date, setDate] = useState('');
  const q = useQuery({
    queryKey: ['attendance-reg', date],
    queryFn: async () => (await api.get(`/attendance${date ? `?date=${date}` : ''}`)).data as { records: Rec[]; admin: boolean },
  });
  const rows = q.data?.records ?? [];
  // One card per person per day: the day's first IN + last OUT, with worked hours.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; userName?: string; date: string; punches: Rec[] }>();
    for (const r of rows) {
      const day = new Date(r.at).toISOString().slice(0, 10);
      const key = `${r.userId || r.userName || '?'}|${day}`;
      let g = map.get(key);
      if (!g) { g = { key, userName: r.userName, date: day, punches: [] }; map.set(key, g); }
      g.punches.push(r);
    }
    const list = [...map.values()].map((g) => {
      const ins = g.punches.filter((p) => p.type === 'IN').sort((a, b) => +new Date(a.at) - +new Date(b.at));
      const outs = g.punches.filter((p) => p.type === 'OUT').sort((a, b) => +new Date(a.at) - +new Date(b.at));
      const project = g.punches.map((p) => p.projectName).find(Boolean) || '';
      return { ...g, in: ins[0] as Rec | undefined, out: outs[outs.length - 1] as Rec | undefined, project };
    });
    list.sort((a, b) => b.date.localeCompare(a.date) || (a.userName || '').localeCompare(b.userName || ''));
    return list;
  }, [rows]);

  if (q.isLoading) return <Spinner label="Loading…" />;
  const fmtDay = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' });

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <label className="text-xs text-slate-500">Date</label>
        <input type="date" className="input h-8 w-40 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
        {date && <button className="text-xs text-navy hover:underline" onClick={() => setDate('')}>Clear</button>}
        <span className="ml-auto text-xs text-slate-400">{groups.length} day-record(s){isAdmin ? ' · all people' : ' · you'}</span>
      </div>
      {groups.length === 0 ? <EmptyState title="No attendance" hint="No punches for this filter." /> : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-slate-50 text-left text-[10px] uppercase text-slate-400">
              <tr>
                {isAdmin && <th rowSpan={2} className="px-4 py-2">Person</th>}
                <th rowSpan={2} className="px-2">Date</th>
                <th rowSpan={2} className="px-2">Hours</th>
                <th colSpan={4} className="border-l border-slate-200 bg-emerald-50 px-2 py-1.5 text-center text-emerald-700">Punch IN</th>
                <th colSpan={4} className="border-l border-slate-200 bg-rose-50 px-2 py-1.5 text-center text-rose-700">Punch OUT</th>
              </tr>
              <tr>
                <th className="border-l border-slate-200 px-2 py-1">Selfie</th><th className="px-2">Time</th><th className="px-2">Location</th><th className="px-2">Note</th>
                <th className="border-l border-slate-200 px-2">Selfie</th><th className="px-2">Time</th><th className="px-2">Location</th><th className="px-2">Note</th>
              </tr>
            </thead>
            <tbody>{groups.map((g) => { const hrs = workedHours(g.in?.at, g.out?.at); return (
              <tr key={g.key} className="border-t border-slate-100 align-top">
                {isAdmin && <td className="px-4 py-2 font-medium text-slate-600">{g.userName || '—'}</td>}
                <td className="whitespace-nowrap px-2 text-slate-500">{fmtDay(g.date)}{g.project && <div className="text-[11px] text-slate-400">{g.project}</div>}</td>
                <td className="whitespace-nowrap px-2">{hrs ? <span className="font-semibold text-navy">🕒 {hrs}</span> : <span className="text-amber-600">{g.in && !g.out ? 'Still in' : g.in ? '—' : 'No IN'}</span>}</td>
                <td className="border-l border-slate-100 px-2 py-2">{g.in?.selfieUrl ? <a href={g.in.selfieUrl} target="_blank" rel="noreferrer"><img src={g.in.selfieUrl} alt="" className="h-10 w-10 rounded object-cover" /></a> : <span className="text-slate-300">—</span>}</td>
                <td className="whitespace-nowrap px-2 font-medium text-slate-600">{g.in ? onlyTime(g.in.at) : '—'}</td>
                <td className="px-2">{g.in ? <LocationCell r={g.in} /> : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 text-xs text-slate-500">{g.in?.address || '—'}</td>
                <td className="border-l border-slate-100 px-2 py-2">{g.out?.selfieUrl ? <a href={g.out.selfieUrl} target="_blank" rel="noreferrer"><img src={g.out.selfieUrl} alt="" className="h-10 w-10 rounded object-cover" /></a> : <span className="text-slate-300">—</span>}</td>
                <td className="whitespace-nowrap px-2 font-medium text-slate-600">{g.out ? onlyTime(g.out.at) : '—'}</td>
                <td className="px-2">{g.out ? <LocationCell r={g.out} /> : <span className="text-slate-300">—</span>}</td>
                <td className="px-2 text-xs text-slate-500">{g.out?.address || '—'}</td>
              </tr>
            ); })}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
