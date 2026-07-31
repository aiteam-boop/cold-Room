import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import { COLOR_HEX, fmtDate } from '../../lib/format';
import RealFloorPlan from '../RealFloorPlan';
import RealFloorPlan3D from '../RealFloorPlan3D';
import ZoneEditor from '../ZoneEditor';

interface Zone {
  id: string; zoneName: string; boqCategory?: string; roomType?: string;
  coordinates?: { x: number; y: number }[] | null; heightM?: number;
  completionPct: number; colorStatus: string; linkedItemCount: number;
}
interface Drawing {
  id: string; fileName: string; fileUrl: string; mimeType?: string;
  version: number; status: string; uploadedAt: string; classification?: string | null;
  // Revision chain (transcript R4): base → rev → rev → final.
  parentId?: string | null; isFinal?: boolean; revisionNotes?: string | null; discipline?: string | null;
}

const DISCIPLINES = ['PUF_PANEL', 'REFRIGERATION', 'DOOR', 'ELECTRICAL', 'CUSTOM'] as const;
const DISCIPLINE_LABEL: Record<string, string> = {
  PUF_PANEL: 'PUF Panel', REFRIGERATION: 'Refrigeration', DOOR: 'Door', ELECTRICAL: 'Electrical', CUSTOM: 'Other',
};

const ext = (n: string) => n.toLowerCase().split('.').pop() || '';
const isPdf = (d: Drawing) => ext(d.fileName) === 'pdf';
const isImg = (d: Drawing) => ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext(d.fileName));
const isDxf = (d: Drawing) => ext(d.fileName) === 'dxf';

export default function DrawingTab({ projectId }: { projectId: string; role: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const isAdmin = canEdit('drawing');
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | undefined>();
  const [mode, setMode] = useState<'diagram' | '3d'>('diagram');
  const [roomPopup, setRoomPopup] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState(false);
  // Upload panel: which family (if any) this file revises, and how to label it.
  const [revisionOf, setRevisionOf] = useState('');
  const [discipline, setDiscipline] = useState('');
  const [revisionNotes, setRevisionNotes] = useState('');

  const drawingsQ = useQuery({
    queryKey: ['drawings', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/drawings`)).data.drawings as Drawing[],
  });
  const zonesQ = useQuery({
    queryKey: ['zones', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/drawings/zones`)).data.zones as Zone[],
  });

  // Default selection: prefer an analyzed DXF, else the first drawing.
  useEffect(() => {
    if (selectedDrawingId || !drawingsQ.data?.length) return;
    const dxf = drawingsQ.data.find((d) => isDxf(d) && d.status === 'APPROVED') || drawingsQ.data.find(isDxf);
    setSelectedDrawingId((dxf || drawingsQ.data[0]).id);
  }, [drawingsQ.data, selectedDrawingId]);

  const selectedDrawing = drawingsQ.data?.find((d) => d.id === selectedDrawingId);

  const upload = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append('file', file!);
      // Empty parent → a new drawing family; otherwise the next revision of one.
      if (revisionOf) fd.append('parentId', revisionOf);
      if (discipline) fd.append('discipline', discipline);
      if (revisionNotes.trim()) fd.append('revisionNotes', revisionNotes.trim());
      return api.post(`/projects/${projectId}/drawings`, fd);
    },
    onSuccess: (r) => { setFile(null); setRevisionNotes(''); setSelectedDrawingId(r.data.drawing.id); qc.invalidateQueries({ queryKey: ['drawings', projectId] }); },
    onError: (e) => alert(errMsg(e)),
  });

  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const analyze = useMutation({
    mutationFn: (drawingId: string) => api.post(`/projects/${projectId}/drawings/${drawingId}/analyze`, {}),
    onSuccess: (r, drawingId) => {
      const d = r.data;
      setMsg({ ok: true, text: `Identified ${d.roomsIdentified} rooms and rendered ${d.wallPaths?.toLocaleString?.() ?? d.wallPaths} wall segments.` });
      setSelectedDrawingId(drawingId);
      setMode('diagram');
      ['zones', 'dashboard', 'drawings'].forEach((k) => qc.invalidateQueries({ queryKey: [k, projectId] }));
      qc.invalidateQueries({ queryKey: ['floorplan', drawingId] });
    },
    onError: (e) => setMsg({ ok: false, text: errMsg(e) }),
  });

  const classify = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/drawings/classify`, {}),
    onSuccess: (r) => { setMsg({ ok: true, text: `Classified ${r.data.classified} diagrams with ${r.data.provider}.` }); qc.invalidateQueries({ queryKey: ['drawings', projectId] }); },
    onError: (e) => setMsg({ ok: false, text: errMsg(e) }),
  });

  const finalise = useMutation({
    mutationFn: (drawingId: string) => api.post(`/projects/${projectId}/drawings/${drawingId}/finalise`, {}),
    onSuccess: () => { setMsg({ ok: true, text: 'Marked as the final approved drawing.' }); qc.invalidateQueries({ queryKey: ['drawings', projectId] }); qc.invalidateQueries({ queryKey: ['project', projectId] }); },
    onError: (e) => setMsg({ ok: false, text: errMsg(e) }),
  });

  // Group into families: a root drawing plus its revisions, newest revision first.
  // "Base drawing, then revision, revision, revision, final drawing."
  const families = useMemo(() => {
    const all = drawingsQ.data ?? [];
    const roots = all.filter((d) => !d.parentId);
    return roots.map((root) => ({
      root,
      revisions: all.filter((d) => d.parentId === root.id).sort((a, b) => b.version - a.version),
    }));
  }, [drawingsQ.data]);

  if (drawingsQ.isLoading) return <Spinner label="Loading drawings…" />;
  const drawings = drawingsQ.data ?? [];
  const zones = zonesQ.data ?? [];
  const dxfAnalyzed = selectedDrawing && isDxf(selectedDrawing) && selectedDrawing.status === 'APPROVED';

  return (
    <div className="grid gap-5 lg:grid-cols-4">
      {/* Left: drawings list (selectable) */}
      <div className="space-y-4">
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-600">Drawings</div>
            {isAdmin && drawings.length > 0 && (
              <button className="text-xs font-medium text-navy hover:underline disabled:opacity-50" disabled={classify.isPending} onClick={() => { setMsg(null); classify.mutate(); }}>
                {classify.isPending ? 'Classifying…' : '🤖 Classify'}
              </button>
            )}
          </div>
          {drawings.length ? (
            <ul className="space-y-3 text-sm">
              {families.map(({ root, revisions }) => {
                // The whole family shares a "final" flag — at most one member has it.
                const familyFinal = [root, ...revisions].find((d) => d.isFinal);
                const item = (d: Drawing, isRevision: boolean) => {
                  const sel = d.id === selectedDrawingId;
                  const cls = d.classification ? JSON.parse(d.classification) : null;
                  const busy = analyze.isPending && analyze.variables === d.id;
                  return (
                    <div key={d.id} className={isRevision ? 'ml-3 border-l-2 border-slate-100 pl-2' : ''}>
                      <button
                        onClick={() => { setSelectedDrawingId(d.id); setMode('diagram'); }}
                        className={`w-full rounded-lg border p-2 text-left transition ${sel ? 'border-navy bg-navy/5' : d.isFinal ? 'border-green-200 bg-green-50/40' : 'border-slate-200 hover:bg-slate-50'}`}
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-0.5 text-base">{isPdf(d) ? '📄' : isDxf(d) ? '📐' : '🖼️'}</span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium text-navy">{d.fileName}</div>
                            <div className="text-xs text-slate-400">
                              {isRevision ? `Rev ${d.version}` : `Base · v${d.version}`} · {fmtDate(d.uploadedAt)}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {d.isFinal && <span className="badge bg-green-100 text-green-700">✓ Final approved</span>}
                              {d.discipline && <span className="badge bg-slate-100 text-slate-600">{DISCIPLINE_LABEL[d.discipline] ?? d.discipline}</span>}
                              {cls && <span className="badge bg-blue-100 text-blue-700">{cls.part}</span>}
                            </div>
                            {d.revisionNotes && <div className="mt-0.5 text-[11px] italic text-slate-400">{d.revisionNotes}</div>}
                            {cls?.rooms?.length > 0 && <div className="mt-0.5 text-[11px] text-slate-400">Rooms: {cls.rooms.join(', ')}</div>}
                          </div>
                        </div>
                      </button>
                      {isAdmin && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {isDxf(d) && (
                            <button className="inline-flex items-center gap-1 rounded-md bg-navy/5 px-2 py-1 text-xs font-medium text-navy hover:bg-navy/10 disabled:opacity-50" disabled={busy} onClick={() => { setMsg(null); analyze.mutate(d.id); }}>
                              {busy ? '⏳ Analyzing…' : d.status === 'APPROVED' ? '🤖 Re-analyze rooms' : '🤖 Analyze rooms & build 3D'}
                            </button>
                          )}
                          {!d.isFinal && (
                            <button
                              className="rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
                              disabled={finalise.isPending}
                              title="Every room-wise quantity is derived from the final approved drawing"
                              onClick={() => { setMsg(null); finalise.mutate(d.id); }}
                            >
                              ✓ Mark as final
                            </button>
                          )}
                          <button className="rounded-md bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                            onClick={() => { setRevisionOf(root.id); setDiscipline(d.discipline ?? ''); }}>
                            + Revision
                          </button>
                        </div>
                      )}
                    </div>
                  );
                };
                return (
                  <li key={root.id} className="space-y-1.5">
                    {item(root, false)}
                    {revisions.map((r) => item(r, true))}
                    {!familyFinal && revisions.length > 0 && (
                      <div className="ml-3 text-[11px] text-amber-600">No revision marked final yet — quantities have no approved source.</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-xs text-slate-400">No drawings uploaded.</div>
          )}
          {msg && <div className={`mt-2 rounded-lg px-2 py-1.5 text-xs ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.text}</div>}
          {isAdmin && (
            <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {revisionOf ? 'Upload revision' : 'Upload new drawing'}
              </div>
              <input className="input text-xs" type="file" accept=".dxf,.dwg,.pdf,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />

              <select className="input text-xs" value={revisionOf} onChange={(e) => setRevisionOf(e.target.value)}>
                <option value="">New drawing (starts its own revision chain)</option>
                {families.map(({ root }) => <option key={root.id} value={root.id}>Revision of · {root.fileName}</option>)}
              </select>

              <select className="input text-xs" value={discipline} onChange={(e) => setDiscipline(e.target.value)}>
                <option value="">Discipline (optional)</option>
                {DISCIPLINES.map((x) => <option key={x} value={x}>{DISCIPLINE_LABEL[x]}</option>)}
              </select>

              {revisionOf && (
                <input className="input text-xs" placeholder="What changed in this revision?" value={revisionNotes} onChange={(e) => setRevisionNotes(e.target.value)} />
              )}

              <button className="btn-primary w-full text-sm" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
                {upload.isPending ? 'Uploading…' : revisionOf ? 'Upload Revision' : 'Upload Drawing'}
              </button>
              <p className="text-[11px] text-slate-400">
                Room-wise target quantities are derived from the drawing marked <strong>final</strong> in each chain.
              </p>
            </div>
          )}
        </div>

        {dxfAnalyzed && <FacilitySummary projectId={projectId} drawingId={selectedDrawingId} />}

        {dxfAnalyzed && (
          <div className="card p-4 text-sm">
            <div className="mb-2 font-medium text-slate-600">Legend</div>
            <LegendRow color={COLOR_HEX.GREEN} label="≥ 80% complete" />
            <LegendRow color={COLOR_HEX.YELLOW} label="20–79% in progress" />
            <LegendRow color={COLOR_HEX.RED} label="< 20% / not started" />
          </div>
        )}
      </div>

      {/* Main: actual diagram viewer */}
      <div className="card p-4 lg:col-span-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-sm font-medium text-slate-600">
            {editing ? 'Manage Zones' : selectedDrawing ? selectedDrawing.fileName : 'Drawing'}
          </div>
          <div className="flex items-center gap-2">
            {selectedDrawing && <a href={selectedDrawing.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-navy hover:underline">Open original ↗</a>}
            {isAdmin && dxfAnalyzed && (
              <button className={editing ? 'btn-primary text-sm' : 'btn-outline text-sm'} onClick={() => setEditing((e) => !e)}>{editing ? '✓ Done' : '✎ Zones'}</button>
            )}
            {!editing && dxfAnalyzed && (
              <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
                <button onClick={() => setMode('diagram')} className={`rounded-md px-3 py-1 font-medium ${mode === 'diagram' ? 'bg-white text-navy shadow-sm' : 'text-slate-500'}`}>2D</button>
                <button onClick={() => setMode('3d')} className={`rounded-md px-3 py-1 font-medium ${mode === '3d' ? 'bg-white text-navy shadow-sm' : 'text-slate-500'}`}>3D</button>
              </div>
            )}
          </div>
        </div>

        <DiagramBody
          projectId={projectId}
          drawing={selectedDrawing}
          editing={editing}
          mode={mode}
          zones={zones}
          dxfAnalyzed={!!dxfAnalyzed}
          isAdmin={isAdmin}
          selectedZoneId={roomPopup?.zoneId}
          onSelectZone={(r: any) => setRoomPopup(r)}
          onEditDone={() => setEditing(false)}
          onAnalyze={() => selectedDrawing && analyze.mutate(selectedDrawing.id)}
          analyzing={analyze.isPending}
        />
      </div>

      {roomPopup && <RoomDetailPopup room={roomPopup} onClose={() => setRoomPopup(null)} />}
    </div>
  );
}

function DiagramBody({ projectId, drawing, editing, mode, zones, dxfAnalyzed, isAdmin, selectedZoneId, onSelectZone, onEditDone, onAnalyze, analyzing }: any) {
  if (!drawing) return <Empty text="Select a drawing from the left, or upload one." />;

  if (editing) return <ZoneEditor projectId={projectId} zones={zones} onDone={onEditDone} />;

  // PDF → embed the actual architectural diagram.
  if (isPdf(drawing)) {
    return <iframe title={drawing.fileName} src={`${drawing.fileUrl}#toolbar=1&navpanes=0`} className="h-[640px] w-full rounded-lg border border-slate-200 bg-white" />;
  }
  // Image drawing.
  if (isImg(drawing)) {
    return (
      <div className="flex justify-center rounded-lg border border-slate-200 bg-slate-50 p-2">
        <img src={drawing.fileUrl} alt={drawing.fileName} className="max-h-[640px] w-auto object-contain" />
      </div>
    );
  }
  // DXF.
  if (isDxf(drawing)) {
    if (!dxfAnalyzed) {
      return (
        <Empty
          text={isAdmin ? 'This CAD drawing isn’t analyzed yet. Click below to extract the real floor plan and identify rooms with AI.' : 'This drawing has not been analyzed yet.'}
          action={isAdmin ? <button className="btn-primary mt-3" disabled={analyzing} onClick={onAnalyze}>{analyzing ? 'Analyzing…' : '🤖 Analyze rooms & render plan'}</button> : undefined}
        />
      );
    }
    return mode === '3d'
      ? <RealFloorPlan3D projectId={projectId} drawingId={drawing.id} selectedId={selectedZoneId} onSelect={onSelectZone} />
      : <RealFloorPlan projectId={projectId} drawingId={drawing.id} selectedId={selectedZoneId} onSelect={onSelectZone} />;
  }
  return <Empty text="Unsupported file type." />;
}

function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 p-12 text-center">
      <div className="max-w-md text-sm text-slate-500">{text}</div>
      {action}
    </div>
  );
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return <div className="flex items-center gap-2 py-0.5 text-slate-600"><span className="h-3 w-3 rounded" style={{ background: color }} /> {label}</div>;
}

// Facility-level summary card (floors, total area, rooms) from AI analysis.
function FacilitySummary({ projectId, drawingId }: { projectId: string; drawingId?: string }) {
  const { data } = useQuery({
    queryKey: ['floorplan', drawingId],
    enabled: !!drawingId,
    queryFn: async () => (await api.get(`/projects/${projectId}/drawings/${drawingId}/floorplan`)).data,
  });
  const f = data?.facility;
  if (!f) return null;
  return (
    <div className="card p-4 text-sm">
      <div className="mb-2 font-medium text-slate-600">Facility Summary</div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="Floors" value={f.floors} />
        <Stat label="Rooms" value={f.roomCount} />
        <Stat label="Total Area" value={f.totalAreaSqFt ? `${f.totalAreaSqFt.toLocaleString()}` : '—'} unit="sq.ft" />
      </div>
      {f.summary && <p className="mt-3 text-xs leading-relaxed text-slate-500">{f.summary}</p>}
      {f.floorsBasis && <p className="mt-1 text-[11px] italic text-slate-400">{f.floorsBasis}</p>}
    </div>
  );
}
function Stat({ label, value, unit }: { label: string; value: any; unit?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-2">
      <div className="text-lg font-bold text-navy">{value}</div>
      <div className="text-[11px] text-slate-400">{label}{unit ? ` (${unit})` : ''}</div>
    </div>
  );
}

// Rich per-room detail popup: area, temperature, pallets, equipment, notes.
function RoomDetailPopup({ room, onClose }: { room: any; onClose: () => void }) {
  const col = COLOR_HEX[room.colorStatus as keyof typeof COLOR_HEX] || COLOR_HEX.RED;
  const d = room.details || {};
  const area = d.areaSqFt ?? room.areaSqFt;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(5,35,121,0.34)] p-4" onClick={onClose}>
      <div className="card max-h-[85vh] w-full max-w-md overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-navy">{room.name}</h3>
            <div className="text-sm text-slate-500">{room.roomType || room.category}</div>
          </div>
          <span className="mt-1 h-4 w-4 rounded-full" style={{ background: col }} />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold" style={{ color: col }}>{room.completionPct}%</div><div className="text-[11px] text-slate-400">complete</div></div>
          <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold text-navy">{area ? area.toLocaleString() : '—'}</div><div className="text-[11px] text-slate-400">sq.ft</div></div>
          <div className="rounded-lg bg-slate-50 p-2"><div className="text-xl font-bold text-navy">{d.temperature ?? '—'}{d.temperature ? '°C' : ''}</div><div className="text-[11px] text-slate-400">temp</div></div>
        </div>

        {d.palletCapacity?.length > 0 && (
          <Section title="Pallet / Storage Capacity">
            {d.palletCapacity.map((p: any, i: number) => <Row key={i} k={p.type} v={p.count} />)}
          </Section>
        )}
        {d.equipment?.length > 0 && (
          <Section title="Equipment">
            {d.equipment.map((p: any, i: number) => <Row key={i} k={p.type} v={p.count} />)}
          </Section>
        )}
        {d.notes?.length > 0 && (
          <Section title="Notes">
            {d.notes.map((n: string, i: number) => <div key={i} className="text-xs text-slate-500">• {n}</div>)}
          </Section>
        )}

        <Section title="Construction Progress">
          <Row k="Linked BOQ items" v={room.linkedItemCount} />
        </Section>

        <button className="btn-outline mt-4 w-full" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: any }) {
  return <div className="flex justify-between text-sm"><span className="text-slate-600">{k}</span><span className="font-semibold text-navy">{v}</span></div>;
}
