import { useState } from 'react';
import { COLOR_HEX } from '../lib/format';

interface FloorZone {
  id: string; zoneName: string; completionPct: number; colorStatus: string;
  coordinates?: { x: number; y: number }[] | null;
}

// Renders zones as filled SVG polygons in a 0..100 coordinate space.
export default function FloorPlan2D<Z extends FloorZone>({ zones, onSelect, selectedId }: {
  zones: Z[]; onSelect: (z: Z) => void; selectedId?: string;
}) {
  const [hover, setHover] = useState<{ z: Z; x: number; y: number } | null>(null);

  const centroid = (pts: { x: number; y: number }[]) => {
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { x, y };
  };

  return (
    <div className="relative">
      <svg viewBox="0 0 100 100" className="w-full rounded-lg border border-slate-200 bg-slate-50" style={{ aspectRatio: '1 / 1', maxHeight: 560 }}>
        {/* grid */}
        {Array.from({ length: 11 }).map((_, i) => (
          <g key={i} stroke="#e2e8f0" strokeWidth={0.15}>
            <line x1={i * 10} y1={0} x2={i * 10} y2={100} />
            <line x1={0} y1={i * 10} x2={100} y2={i * 10} />
          </g>
        ))}
        {zones.map((z) => {
          if (!z.coordinates?.length) return null;
          const color = COLOR_HEX[z.colorStatus as keyof typeof COLOR_HEX] || COLOR_HEX.RED;
          const points = z.coordinates.map((p) => `${p.x},${p.y}`).join(' ');
          const c = centroid(z.coordinates);
          const isSel = z.id === selectedId;
          return (
            <g key={z.id} className="cursor-pointer" onClick={() => onSelect(z)}
               onMouseMove={(e) => { const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setHover({ z, x: e.clientX - r.left, y: e.clientY - r.top }); }}
               onMouseLeave={() => setHover(null)}>
              <polygon points={points} fill={color} fillOpacity={isSel ? 0.85 : 0.62} stroke={isSel ? '#0f2942' : '#ffffff'} strokeWidth={isSel ? 0.8 : 0.5} />
              <text x={c.x} y={c.y - 1} textAnchor="middle" style={{ fontSize: 2.6, fontWeight: 600, fill: '#0f2942' }}>{z.zoneName}</text>
              <text x={c.x} y={c.y + 2.6} textAnchor="middle" style={{ fontSize: 2.4, fill: '#1e293b' }}>{z.completionPct}%</text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 rounded-lg bg-navy px-2 py-1 text-xs text-white shadow-lg" style={{ left: hover.x + 10, top: hover.y + 10 }}>
          <div className="font-semibold">{hover.z.zoneName}</div>
          <div>{hover.z.completionPct}% complete</div>
        </div>
      )}
    </div>
  );
}
