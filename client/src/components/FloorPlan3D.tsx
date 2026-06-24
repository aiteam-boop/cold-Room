import { COLOR_HEX } from '../lib/format';

interface FloorZone {
  id: string; zoneName: string; completionPct: number; colorStatus: string; heightM?: number;
  coordinates?: { x: number; y: number }[] | null;
}

// Lightweight isometric 3D-style view (no WebGL dependency): each zone is
// extruded by its room height. Uses the same colour scheme as 2D (PRD §5.1.4).
export default function FloorPlan3D<Z extends FloorZone>({ zones, onSelect, selectedId }: {
  zones: Z[]; onSelect: (z: Z) => void; selectedId?: string;
}) {
  // Isometric projection of a ground point (x,y in 0..100) to screen.
  const iso = (x: number, y: number, z = 0) => ({
    sx: 50 + (x - y) * 0.62,
    sy: 28 + (x + y) * 0.32 - z,
  });

  const sorted = [...zones].sort((a, b) => {
    const ca = a.coordinates ? a.coordinates.reduce((s, p) => s + p.x + p.y, 0) / a.coordinates.length : 0;
    const cb = b.coordinates ? b.coordinates.reduce((s, p) => s + p.x + p.y, 0) / b.coordinates.length : 0;
    return ca - cb; // draw back-to-front
  });

  return (
    <svg viewBox="0 0 130 110" className="w-full rounded-lg border border-slate-200 bg-gradient-to-b from-slate-100 to-slate-200" style={{ maxHeight: 560 }}>
      {sorted.map((z) => {
        if (!z.coordinates?.length) return null;
        const base = z.colorStatus as keyof typeof COLOR_HEX;
        const top = COLOR_HEX[base] || COLOR_HEX.RED;
        const h = ((z.heightM ?? 3) / 4) * 18 + 6; // extrusion height
        const isSel = z.id === selectedId;

        const ground = z.coordinates.map((p) => iso(p.x * 0.95, p.y * 0.95, 0));
        const roof = z.coordinates.map((p) => iso(p.x * 0.95, p.y * 0.95, h));
        const roofPts = roof.map((p) => `${p.sx},${p.sy}`).join(' ');

        // Side walls: connect each ground edge to its roof edge.
        const walls = z.coordinates.map((_, i) => {
          const n = (i + 1) % z.coordinates!.length;
          return [ground[i], ground[n], roof[n], roof[i]].map((p) => `${p.sx},${p.sy}`).join(' ');
        });
        const cx = roof.reduce((s, p) => s + p.sx, 0) / roof.length;
        const cy = roof.reduce((s, p) => s + p.sy, 0) / roof.length;

        return (
          <g key={z.id} className="cursor-pointer" onClick={() => onSelect(z)} opacity={isSel ? 1 : 0.95}>
            {walls.map((w, i) => (
              <polygon key={i} points={w} fill={top} fillOpacity={0.45} stroke="#ffffff" strokeWidth={0.2} />
            ))}
            <polygon points={roofPts} fill={top} fillOpacity={isSel ? 0.95 : 0.8} stroke={isSel ? '#0f2942' : '#ffffff'} strokeWidth={isSel ? 0.6 : 0.3} />
            <text x={cx} y={cy} textAnchor="middle" style={{ fontSize: 2.4, fontWeight: 600, fill: '#0f2942' }}>{z.zoneName}</text>
            <text x={cx} y={cy + 2.6} textAnchor="middle" style={{ fontSize: 2.2, fill: '#0f172a' }}>{z.completionPct}%</text>
          </g>
        );
      })}
    </svg>
  );
}
