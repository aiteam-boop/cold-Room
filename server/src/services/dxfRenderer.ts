// ── Focused DXF floor-plan renderer (PRD §5.1.3) ────────────────────────────
// Real architectural DXFs are huge multi-sheet files (blocks, PDF underlays).
// We: (1) find the densest cluster of cold-room labels = the main plan,
// (2) expand blocks to world-coordinate polylines via the `dxf` package,
// (3) crop to the plan region and emit compact SVG <path> markup.

import { Helper } from 'dxf';
import fs from 'fs';
import { analyzeDxf, DxfLabel } from './dxfAnalyzer';

const ROOM_RE = /(blast\s*freezer|freezer|chiller|ambient|anteroom|cold\s*room|f&v|electrical room|dock|staging|batching|dry)/i;

export interface Poly { v: number[][]; area: number }

export interface FocusedPlan {
  pathsMarkup: string;                 // concatenated <path/> elements (world coords, Y-up)
  viewBox: { x: number; y: number; w: number; h: number };
  crop: { x0: number; y0: number; x1: number; y1: number };
  cropArea: number;
  roomLabels: DxfLabel[];              // room-like labels inside the crop (world coords)
  allLabels: DxfLabel[];
  roomPolys: Poly[];                   // candidate closed polygons in crop (for footprints)
  pathCount: number;
}

function polyArea(v: number[][]): number {
  let a = 0;
  for (let i = 0; i < v.length; i++) { const j = (i + 1) % v.length; a += v[i][0] * v[j][1] - v[j][0] * v[i][1]; }
  return Math.abs(a) / 2;
}

export function pointInPolygon(px: number, py: number, v: number[][]): boolean {
  return pointInPoly(px, py, v);
}

function pointInPoly(px: number, py: number, v: number[][]): boolean {
  let c = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    if (((v[i][1] > py) !== (v[j][1] > py)) && (px < ((v[j][0] - v[i][0]) * (py - v[i][1])) / (v[j][1] - v[i][1]) + v[i][0])) c = !c;
  }
  return c;
}

// Find the tightest sensible polygon that encloses a room label point.
// Returns world-coordinate vertices, or null if none qualifies.
export function pickFootprint(x: number, y: number, polys: Poly[], cropArea: number): number[][] | null {
  const min = cropArea * 0.003, max = cropArea * 0.5;
  let best: Poly | null = null;
  for (const p of polys) {
    if (p.area < min || p.area > max) continue;
    if (!pointInPoly(x, y, p.v)) continue;
    if (!best || p.area < best.area) best = p;
  }
  return best ? best.v : null;
}

// Densest spatial cluster of room-like labels → the actual floor plan region.
function clusterCrop(labels: DxfLabel[]): { crop: FocusedPlan['crop']; members: DxfLabel[] } {
  const rooms = labels.filter((l) => ROOM_RE.test(l.text));
  if (rooms.length === 0) {
    // Fall back to the bbox of all labels.
    const xs = labels.map((l) => l.x), ys = labels.map((l) => l.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    return { crop: { x0, y0, x1, y1 }, members: labels };
  }
  // Window radius scaled to the overall spread so it adapts to any drawing units.
  const xs = rooms.map((r) => r.x), ys = rooms.map((r) => r.y);
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const R = spread * 0.06 + 1;
  let best: DxfLabel[] = rooms, bestScore = -1;
  for (const c of rooms) {
    const near = rooms.filter((p) => Math.abs(p.x - c.x) < R && Math.abs(p.y - c.y) < R);
    if (near.length > bestScore) { bestScore = near.length; best = near; }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of best) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pad = Math.max((x1 - x0), (y1 - y0)) * 0.18 || spread * 0.05;
  return { crop: { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }, members: best };
}

export function buildFocusedPlan(filePath: string): FocusedPlan {
  const content = fs.readFileSync(filePath, 'utf8');

  // Labels (with positions) from dxf-parser.
  const { labels } = analyzeDxf(filePath);
  const { crop } = clusterCrop(labels);
  const inCrop = (x: number, y: number) => x >= crop.x0 && x <= crop.x1 && y >= crop.y0 && y <= crop.y1;

  // Expand blocks → world polylines via the `dxf` package.
  const { polylines } = new Helper(content).toPolylines() as any;
  const fix = (n: number) => Math.round(n * 10) / 10;
  const paths: string[] = [];
  const roomPolys: Poly[] = [];
  for (const pl of polylines) {
    const vs: number[][] = pl.vertices;
    if (!vs || vs.length < 2) continue;
    if (!vs.some((v) => inCrop(v[0], v[1]))) continue;
    const d = vs.map((v, i) => `${i ? 'L' : 'M'}${fix(v[0])} ${fix(v[1])}`).join(' ');
    paths.push(`<path d="${d}"/>`);
    if (vs.length >= 4) roomPolys.push({ v: vs, area: polyArea(vs) });
  }

  const roomLabels = labels.filter((l) => ROOM_RE.test(l.text) && inCrop(l.x, l.y));
  return {
    pathsMarkup: paths.join(''),
    viewBox: { x: crop.x0, y: crop.y0, w: crop.x1 - crop.x0, h: crop.y1 - crop.y0 },
    crop,
    cropArea: (crop.x1 - crop.x0) * (crop.y1 - crop.y0),
    roomLabels,
    allLabels: labels.filter((l) => inCrop(l.x, l.y)),
    roomPolys,
    pathCount: paths.length,
  };
}
