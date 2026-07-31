import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { COLOR_HEX } from '../lib/format';
import { Modal } from './ui';

interface Zone {
  id: string; zoneName: string; boqCategory?: string; roomType?: string;
  coordinates?: { x: number; y: number }[] | null; heightM?: number;
  completionPct: number; colorStatus: string; linkedItemCount: number;
}
interface BOQItem { id: string; description: string; category?: string; roomZone?: string; isGroup: boolean; }

// Admin tool to create/draw/delete floor-plan zones for a project.
export default function ZoneEditor({ projectId, zones, onDone }: { projectId: string; zones: Zone[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [drawing, setDrawing] = useState(false);
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState('');

  const boqQ = useQuery({
    queryKey: ['boq', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data.items as BOQItem[],
  });

  // Pick a sensible default grouping: rooms if the BOQ has them, else category.
  const hasRooms = useMemo(() => (boqQ.data ?? []).some((i) => !i.isGroup && i.roomZone), [boqQ.data]);
  const [groupBy, setGroupBy] = useState<'roomZone' | 'category'>('category');
  // Prefer grouping by room once we know the BOQ actually has room values.
  useEffect(() => { if (hasRooms) setGroupBy('roomZone'); }, [hasRooms]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['zones', projectId] });
    qc.invalidateQueries({ queryKey: ['dashboard', projectId] });
  };

  const autoGen = useMutation({
    mutationFn: (replace: boolean) => api.post(`/projects/${projectId}/drawings/zones/auto-generate`, { groupBy, replace }),
    onSuccess: () => { invalidate(); },
    onError: (e) => setErr(errMsg(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/drawings/zones/${id}`),
    onSuccess: invalidate,
    onError: (e) => alert(errMsg(e)),
  });

  function svgClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!drawing) return;
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * 100);
    const y = Math.round(((e.clientY - r.top) / r.height) * 100);
    setPoints((p) => [...p, { x, y }]);
  }

  function startDraw() { setDrawing(true); setPoints([]); }
  function finishDraw() {
    if (points.length < 3) { setErr('Click at least 3 points to form a zone.'); return; }
    setDrawing(false);
    setShowForm(true);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => autoGen.mutate(zones.length > 0)} disabled={autoGen.isPending}>
          {autoGen.isPending ? 'Generating…' : zones.length ? '↻ Regenerate from BOQ' : '⚡ Auto-generate from BOQ'}
        </button>
        <select className="rounded-lg border border-slate-300 px-2 py-2 text-sm" value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'roomZone' | 'category')} title="Group zones by">
          <option value="roomZone" disabled={!hasRooms}>by Room{!hasRooms ? ' (none in BOQ)' : ''}</option>
          <option value="category">by Category</option>
        </select>
        {!drawing ? (
          <button className="btn-outline" onClick={startDraw}>✎ Draw a zone</button>
        ) : (
          <>
            <span className="text-sm text-slate-500">Click points on the plan… ({points.length})</span>
            <button className="btn-primary" onClick={finishDraw} disabled={points.length < 3}>Finish ({points.length})</button>
            <button className="btn-outline" onClick={() => { setDrawing(false); setPoints([]); }}>Cancel</button>
          </>
        )}
        <div className="ml-auto text-sm text-slate-400">{zones.length} zone(s)</div>
      </div>

      {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
      <p className="text-xs text-slate-500">
        Tip: <strong>Auto-generate</strong> instantly creates one colour-coded zone per BOQ room and links its items — the fastest way to light up the plan.
        Use <strong>Draw a zone</strong> to trace a room outline over your drawing by clicking corners.
      </p>

      {/* Editing canvas */}
      <svg
        viewBox="0 0 100 100"
        className={`w-full rounded-lg border border-slate-200 bg-slate-50 ${drawing ? 'cursor-crosshair' : ''}`}
        style={{ aspectRatio: '1 / 1', maxHeight: 520 }}
        onClick={svgClick}
      >
        {Array.from({ length: 11 }).map((_, i) => (
          <g key={i} stroke="#e2e8f0" strokeWidth={0.15}>
            <line x1={i * 10} y1={0} x2={i * 10} y2={100} />
            <line x1={0} y1={i * 10} x2={100} y2={i * 10} />
          </g>
        ))}
        {/* Existing zones */}
        {zones.map((z) => {
          if (!z.coordinates?.length) return null;
          const color = COLOR_HEX[z.colorStatus as keyof typeof COLOR_HEX] || COLOR_HEX.RED;
          const cx = z.coordinates.reduce((s, p) => s + p.x, 0) / z.coordinates.length;
          const cy = z.coordinates.reduce((s, p) => s + p.y, 0) / z.coordinates.length;
          return (
            <g key={z.id}>
              <polygon points={z.coordinates.map((p) => `${p.x},${p.y}`).join(' ')} fill={color} fillOpacity={0.5} stroke="#fff" strokeWidth={0.4} />
              <text x={cx} y={cy} textAnchor="middle" style={{ fontSize: 2.6, fontWeight: 600, fill: '#052379' }}>{z.zoneName}</text>
            </g>
          );
        })}
        {/* In-progress polygon */}
        {points.length > 0 && (
          <>
            <polyline points={points.map((p) => `${p.x},${p.y}`).join(' ')} fill="rgba(15,41,66,0.15)" stroke="#052379" strokeWidth={0.5} />
            {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={0.9} fill="#052379" />)}
          </>
        )}
      </svg>

      {/* Existing zones list with delete */}
      {zones.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {zones.map((z) => (
            <span key={z.id} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_HEX[z.colorStatus as keyof typeof COLOR_HEX] }} />
              {z.zoneName} <span className="text-xs text-slate-400">{z.completionPct}% · {z.linkedItemCount} items</span>
              <button className="text-slate-300 hover:text-red-500" onClick={() => del.mutate(z.id)}>✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button className="btn-outline" onClick={onDone}>Done editing</button>
      </div>

      {showForm && (
        <ZoneForm
          projectId={projectId}
          coordinates={points}
          boqItems={(boqQ.data ?? []).filter((i) => !i.isGroup)}
          onClose={() => { setShowForm(false); setPoints([]); }}
          onSaved={() => { setShowForm(false); setPoints([]); invalidate(); }}
        />
      )}
    </div>
  );
}

function ZoneForm({ projectId, coordinates, boqItems, onClose, onSaved }: {
  projectId: string; coordinates: { x: number; y: number }[]; boqItems: BOQItem[]; onClose: () => void; onSaved: () => void;
}) {
  const categories = useMemo(() => [...new Set(boqItems.map((i) => i.category).filter(Boolean))] as string[], [boqItems]);
  const [zoneName, setZoneName] = useState('');
  const [boqCategory, setBoqCategory] = useState('');
  const [heightM, setHeightM] = useState('3.5');
  const [err, setErr] = useState('');

  // Link all BOQ items in the chosen category to this zone.
  const linkedIds = useMemo(() => boqItems.filter((i) => i.category === boqCategory).map((i) => i.id), [boqItems, boqCategory]);

  const save = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/drawings/zones`, {
      zoneName, boqCategory: boqCategory || undefined, roomType: zoneName,
      coordinates, heightM: Number(heightM) || undefined, boqItemIds: linkedIds,
    }),
    onSuccess: onSaved,
    onError: (e) => setErr(errMsg(e)),
  });

  return (
    <Modal title="New Zone" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); setErr(''); save.mutate(); }} className="space-y-3">
        <div><label className="label">Zone / room name *</label><input className="input" required value={zoneName} onChange={(e) => setZoneName(e.target.value)} placeholder="e.g. Freezer Room" /></div>
        <div>
          <label className="label">Link to BOQ category (drives completion %)</label>
          <select className="input" value={boqCategory} onChange={(e) => setBoqCategory(e.target.value)}>
            <option value="">— none —</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {boqCategory && <div className="mt-1 text-xs text-slate-400">{linkedIds.length} BOQ items will be linked.</div>}
        </div>
        <div><label className="label">Room height (m, for 3D)</label><input className="input" type="number" step="0.5" value={heightM} onChange={(e) => setHeightM(e.target.value)} /></div>
        {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Create Zone'}</button>
        </div>
      </form>
    </Modal>
  );
}
