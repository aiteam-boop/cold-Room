// ── DXF analysis (PRD §5.1.2) ───────────────────────────────────────────────
// Parses a DXF and extracts text labels with their real coordinates plus the
// global bounding box. Labels are the reliable signal in a CAD floor plan; we
// let the AI decide which ones are actual rooms (see aiClassify.ts).

import DxfParser from 'dxf-parser';
import fs from 'fs';

export interface DxfLabel {
  text: string;
  x: number;
  y: number;
}

export interface DxfAnalysis {
  labels: DxfLabel[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  entityCount: number;
}

// Strip AutoCAD MTEXT inline formatting → plain text.
// e.g. "{\fVerdana|b0|i0|c0|p34;BLAST FREEZER}" → "BLAST FREEZER"
export function cleanMText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\\P/gi, ' ')               // paragraph break → space
    .replace(/\\[A-Za-z]+\|[^;]*;/g, '') // font/format block  \fVerdana|...;
    .replace(/\\[A-Za-z]/g, '')          // stray formatting codes \L \l \O ...
    .replace(/[{}]/g, '')                // grouping braces
    .replace(/\\~/g, ' ')                // non-breaking space
    .replace(/\s+/g, ' ')
    .trim();
}

export function analyzeDxf(filePath: string): DxfAnalysis {
  const content = fs.readFileSync(filePath, 'utf8');
  const dxf: any = new DxfParser().parseSync(content);
  const ents: any[] = dxf?.entities ?? [];

  const labels: DxfLabel[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const seen = new Set<string>();

  for (const e of ents) {
    // Track bounding box from polyline/line geometry for normalization.
    if (e.vertices?.length) {
      for (const v of e.vertices) {
        if (typeof v.x === 'number' && typeof v.y === 'number') {
          minX = Math.min(minX, v.x); minY = Math.min(minY, v.y);
          maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y);
        }
      }
    }
    if (e.type === 'MTEXT' || e.type === 'TEXT') {
      const text = cleanMText(e.text);
      if (!text || text.length < 2) continue;
      const p = e.position || e.startPoint || e.insertionPoint || { x: 0, y: 0 };
      if (typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      // Dedup identical text at near-identical position (MTEXT often doubled).
      const key = `${text}|${Math.round(p.x)}|${Math.round(p.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push({ text, x: p.x, y: p.y });
    }
  }

  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  return { labels, bbox: { minX, minY, maxX, maxY }, entityCount: ents.length };
}
