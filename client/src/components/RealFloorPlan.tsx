import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { COLOR_HEX } from '../lib/format';
import { Spinner } from './ui';

interface Room {
  zoneId: string; name: string; category?: string; roomType?: string;
  worldX: number; worldY: number; footprint: number[][] | null; areaSqFt: number | null;
  details?: any;
  completionPct: number; colorStatus: string; linkedItemCount: number;
}
interface FloorPlanData {
  viewBox: { x: number; y: number; w: number; h: number };
  pathsMarkup: string;
  pathCount: number;
  rooms: Room[];
}

// Renders the REAL DXF floor-plan geometry (walls) with AI-identified rooms
// overlaid as colour-coded markers driven by live completion.
export default function RealFloorPlan({ projectId, drawingId, onSelect, selectedId }: {
  projectId: string; drawingId?: string; onSelect: (r: Room) => void; selectedId?: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['floorplan', drawingId],
    enabled: !!drawingId,
    queryFn: async () => (await api.get(`/projects/${projectId}/drawings/${drawingId}/floorplan`)).data as FloorPlanData,
  });

  if (!drawingId) return <Hint text="No drawing selected." />;
  if (isLoading) return <Spinner label="Rendering real floor plan…" />;
  if (error) return <Hint text={errMsg(error) + ' — click “🤖 Analyze with AI” on a DXF drawing first.'} />;
  if (!data) return <Hint text="No plan data." />;

  const vb = data.viewBox;
  const base = Math.min(vb.w, vb.h) || 1000;
  // Map world Y (up) to screen Y within the viewBox (down).
  const flipY = (y: number) => 2 * vb.y + vb.h - y;
  const stroke = base * 0.0009;
  const font = base * 0.02;
  const areas = data.rooms.map((r) => r.areaSqFt).filter((a): a is number => !!a && a > 0);
  const maxArea = areas.length ? Math.max(...areas) : 0;
  const radius = (a: number | null) => (a && maxArea ? (0.03 + 0.045 * Math.sqrt(a / maxArea)) * base : 0.05 * base);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} className="w-full" style={{ maxHeight: 620 }} preserveAspectRatio="xMidYMid meet">
        {/* Real walls — flipped vertically so the plan reads upright. */}
        <g
          transform={`matrix(1 0 0 -1 0 ${2 * vb.y + vb.h})`}
          stroke="#64748b"
          strokeWidth={stroke}
          fill="none"
          vectorEffect="non-scaling-stroke"
          dangerouslySetInnerHTML={{ __html: data.pathsMarkup }}
        />
        {/* Room overlays (upright): fill the REAL footprint when available. */}
        {data.rooms.map((r) => {
          const sx = r.worldX, sy = flipY(r.worldY);
          const col = COLOR_HEX[r.colorStatus as keyof typeof COLOR_HEX] || COLOR_HEX.RED;
          const sel = r.zoneId === selectedId;
          const poly = r.footprint?.length
            ? r.footprint.map((v) => `${v[0]},${flipY(v[1])}`).join(' ')
            : null;
          return (
            <g key={r.zoneId} style={{ cursor: 'pointer' }} onClick={() => onSelect(r)}>
              {poly ? (
                <polygon points={poly} fill={col} fillOpacity={sel ? 0.5 : 0.34} stroke={col} strokeWidth={stroke * (sel ? 4 : 2.5)} strokeLinejoin="round" />
              ) : (
                <circle cx={sx} cy={sy} r={radius(r.areaSqFt)} fill={col} fillOpacity={sel ? 0.5 : 0.32} stroke={col} strokeWidth={stroke * (sel ? 4 : 2)} strokeDasharray={`${stroke * 6} ${stroke * 4}`} />
              )}
              <text x={sx} y={sy - font * 0.5} textAnchor="middle" style={{ fontSize: font, fontWeight: 700, fill: '#052379', paintOrder: 'stroke', stroke: '#fff', strokeWidth: font * 0.14 }}>{r.name}</text>
              {(r.details?.areaSqFt ?? r.areaSqFt) != null && (
                <text x={sx} y={sy + font * 0.55} textAnchor="middle" style={{ fontSize: font * 0.78, fill: '#334155', paintOrder: 'stroke', stroke: '#fff', strokeWidth: font * 0.12 }}>
                  {(r.details?.areaSqFt ?? r.areaSqFt).toLocaleString()} sq.ft{r.details?.temperature ? ` · ${r.details.temperature}°C` : ''}
                </text>
              )}
              <text x={sx} y={sy + font * 1.5} textAnchor="middle" style={{ fontSize: font * 0.85, fontWeight: 600, fill: col, paintOrder: 'stroke', stroke: '#fff', strokeWidth: font * 0.14 }}>{r.completionPct}% done</text>
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
