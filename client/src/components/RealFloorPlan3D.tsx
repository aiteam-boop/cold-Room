import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { COLOR_HEX } from '../lib/format';
import { Spinner } from './ui';

interface Room {
  zoneId: string; name: string; roomType?: string; category?: string;
  worldX: number; worldY: number; footprint: number[][] | null; areaSqFt: number | null;
  details?: any;
  completionPct: number; colorStatus: string; linkedItemCount: number;
}
interface FloorPlanData { viewBox: { x: number; y: number; w: number; h: number }; rooms: Room[]; }

function darken(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

// Real-geometry isometric 3D: extrudes each room's actual footprint polygon.
export default function RealFloorPlan3D({ projectId, drawingId, onSelect, selectedId }: {
  projectId: string; drawingId?: string; onSelect: (r: Room) => void; selectedId?: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['floorplan', drawingId],
    enabled: !!drawingId,
    queryFn: async () => (await api.get(`/projects/${projectId}/drawings/${drawingId}/floorplan`)).data as FloorPlanData,
  });

  if (!drawingId) return <Hint text="No drawing selected." />;
  if (isLoading) return <Spinner label="Building 3D model…" />;
  if (error) return <Hint text={errMsg(error) + ' — analyze a DXF drawing first.'} />;
  if (!data?.rooms?.length) return <Hint text="No rooms to model yet." />;

  // 1. Build each room's footprint in world coords (fallback: square around label).
  const haveFp = data.rooms.filter((r) => r.footprint?.length);
  const medSize = (() => {
    if (!haveFp.length) return (data.viewBox.w || 1000) * 0.12;
    const sizes = haveFp.map((r) => {
      const xs = r.footprint!.map((v) => v[0]), ys = r.footprint!.map((v) => v[1]);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }).sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)] || (data.viewBox.w || 1000) * 0.12;
  })();
  const polysWorld = data.rooms.map((r) => {
    if (r.footprint?.length) return { r, poly: r.footprint };
    const h = medSize / 2;
    return { r, poly: [[r.worldX - h, r.worldY - h], [r.worldX + h, r.worldY - h], [r.worldX + h, r.worldY + h], [r.worldX - h, r.worldY + h]] as number[][] };
  });

  // 2. Normalize world → local 0..100 (uniform scale, flip Y).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { poly } of polysWorld) for (const v of poly) { minX = Math.min(minX, v[0]); minY = Math.min(minY, v[1]); maxX = Math.max(maxX, v[0]); maxY = Math.max(maxY, v[1]); }
  const scale = 100 / Math.max(maxX - minX, maxY - minY || 1);
  const NX = (x: number) => (x - minX) * scale;
  const NY = (y: number) => (maxY - y) * scale; // flip so north is back

  // 3. Isometric projection. Height scaled a touch by area for subtle variety.
  const H_BASE = 16;
  const areas = data.rooms.map((r) => r.areaSqFt).filter((a): a is number => !!a && a > 0);
  const maxArea = areas.length ? Math.max(...areas) : 0;
  const heightFor = (a: number | null) => (a && maxArea ? H_BASE * (0.7 + 0.5 * Math.sqrt(a / maxArea)) : H_BASE);
  const COS = 0.866, SIN = 0.5;
  const iso = (x: number, y: number, z: number) => ({ sx: (x - y) * COS, sy: (x + y) * SIN - z });

  // 4. Build room solids; depth-sort back→front by centroid (x+y).
  const solids = polysWorld.map(({ r, poly }) => {
    const ring = poly.map((v) => ({ x: NX(v[0]), y: NY(v[1]) }));
    const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
    return { r, ring, depth: cx + cy, h: heightFor(r.areaSqFt), cx, cy };
  }).sort((a, b) => a.depth - b.depth);

  // 5. Compute screen bounds for the viewBox.
  let sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
  for (const s of solids) for (const p of s.ring) {
    for (const z of [0, s.h]) { const q = iso(p.x, p.y, z); sxMin = Math.min(sxMin, q.sx); syMin = Math.min(syMin, q.sy); sxMax = Math.max(sxMax, q.sx); syMax = Math.max(syMax, q.sy); }
  }
  const pad = 8;
  const vb = `${sxMin - pad} ${syMin - pad} ${sxMax - sxMin + pad * 2} ${syMax - syMin + pad * 2}`;
  const font = (sxMax - sxMin) * 0.022;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-gradient-to-b from-slate-100 to-slate-300">
      <svg viewBox={vb} className="w-full" style={{ maxHeight: 620 }} preserveAspectRatio="xMidYMid meet">
        {solids.map((s) => {
          const col = COLOR_HEX[s.r.colorStatus as keyof typeof COLOR_HEX] || COLOR_HEX.RED;
          const sel = s.r.zoneId === selectedId;
          const ground = s.ring.map((p) => iso(p.x, p.y, 0));
          const roof = s.ring.map((p) => iso(p.x, p.y, s.h));
          const roofPts = roof.map((p) => `${p.sx},${p.sy}`).join(' ');
          // Walls: draw only the front/visible faces (screen-facing). Shade by side.
          const walls = s.ring.map((_, i) => {
            const n = (i + 1) % s.ring.length;
            const g0 = ground[i], g1 = ground[n], r1 = roof[n], r0 = roof[i];
            // Visible if the edge runs "downhill" toward viewer (front faces).
            const facing = g1.sx - g0.sx; // heuristic for left/right shade
            const shade = facing >= 0 ? 0.62 : 0.46;
            return { pts: `${g0.sx},${g0.sy} ${g1.sx},${g1.sy} ${r1.sx},${r1.sy} ${r0.sx},${r0.sy}`, shade, front: (g0.sy + g1.sy) / 2 };
          }).sort((a, b) => a.front - b.front);
          const ctr = iso(s.cx, s.cy, s.h);
          return (
            <g key={s.r.zoneId} style={{ cursor: 'pointer' }} onClick={() => onSelect(s.r)}>
              {walls.map((w, i) => (
                <polygon key={i} points={w.pts} fill={darken(col, w.shade)} stroke={darken(col, 0.4)} strokeWidth={0.15} />
              ))}
              <polygon points={roofPts} fill={col} fillOpacity={sel ? 0.95 : 0.82} stroke={sel ? '#052379' : '#ffffff'} strokeWidth={sel ? 0.5 : 0.28} />
              <text x={ctr.sx} y={ctr.sy - font * 0.5} textAnchor="middle" style={{ fontSize: font, fontWeight: 700, fill: '#052379', paintOrder: 'stroke', stroke: '#fff', strokeWidth: font * 0.14 }}>{s.r.name}</text>
              {(s.r.details?.areaSqFt ?? s.r.areaSqFt) != null && (
                <text x={ctr.sx} y={ctr.sy + font * 0.5} textAnchor="middle" style={{ fontSize: font * 0.72, fill: '#334155', paintOrder: 'stroke', stroke: '#fff', strokeWidth: font * 0.12 }}>{(s.r.details?.areaSqFt ?? s.r.areaSqFt).toLocaleString()} sq.ft{s.r.details?.temperature ? ` · ${s.r.details.temperature}°C` : ''}</text>
              )}
              <text x={ctr.sx} y={ctr.sy + font * 1.35} textAnchor="middle" style={{ fontSize: font * 0.8, fontWeight: 600, fill: darken(col, 0.7), paintOrder: 'stroke', stroke: '#fff', strokeWidth: font * 0.14 }}>{s.r.completionPct}%</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Hint({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">{text}</div>;
}
