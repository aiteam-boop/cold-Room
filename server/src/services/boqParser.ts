// ── BOQ parser (PRD §5.2.1, FR-BQ-01/02) ───────────────────────────────────
// Extracts { srNo, description, unit, plannedQty, category } rows from an
// uploaded .xlsx / .csv / .pdf BOQ. Uses SheetJS for structured spreadsheets
// (no AI needed); optionally enriches/normalizes via Claude when a key is set.

import * as XLSX from 'xlsx';
import fs from 'fs';

export interface ParsedBOQRow {
  srNo?: string;
  description: string;
  category?: string;
  roomZone?: string;
  unit?: string;
  plannedQty: number;
  isGroup?: boolean;
}

export interface ParseResult {
  rows: ParsedBOQRow[];
  source: 'xlsx' | 'csv' | 'ai' | 'empty';
  warnings: string[];
}

const UNIT_TOKENS = ['no', 'nos', "no's", 'mtr', 'mtrs', 'm', 'sq.m', 'sqm', 'sq m', 'rmt', 'mt', 'set', 'lot', 'kg', 'ltr', 'pcs', 'unit', 'units'];

function normalizeUnit(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const low = s.toLowerCase().replace(/\s+/g, ' ');
  if (low === 'no' || low === 'nos' || low === "no's" || low === 'number' || low === 'unit' || low === 'units') return "No's";
  if (low === 'sqm' || low === 'sq.m' || low === 'sq m' || low === 'sq.mtr' || low === 'm2') return 'Sq.M';
  if (low === 'm' || low === 'mtr' || low === 'mtrs' || low === 'meter' || low === 'meters') return 'mtr';
  if (low === 'rmt') return 'RMT';
  if (low === 'mt') return 'MT';
  return s;
}

function toNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/,/g, '').replace(/[^0-9.\-]/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
}

// Find the header row + column indexes by fuzzy header matching.
function detectColumns(rows: unknown[][]): {
  headerIdx: number;
  cols: { sr?: number; desc?: number; unit?: number; qty?: number };
} | null {
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const row = rows[r].map((c) => String(c ?? '').toLowerCase().trim());
    const cols: { sr?: number; desc?: number; unit?: number; qty?: number } = {};
    row.forEach((cell, i) => {
      if (cols.sr === undefined && /(sr\.?\s*no|s\.?\s*no|sl\.?\s*no|item\s*no|^#$)/.test(cell)) cols.sr = i;
      if (cols.desc === undefined && /(description|particular|item|activity|scope|work)/.test(cell)) cols.desc = i;
      if (cols.unit === undefined && /(unit|uom|u\.o\.m)/.test(cell)) cols.unit = i;
      if (cols.qty === undefined && /(qty|quantity|planned|nos\b)/.test(cell)) cols.qty = i;
    });
    if (cols.desc !== undefined && (cols.qty !== undefined || cols.unit !== undefined)) {
      return { headerIdx: r, cols };
    }
  }
  return null;
}

// Heuristic: a row that looks like a category/group HEADER (no quantity, and
// reads like a heading rather than a prose note). Real headers in cold-room
// BOQs are short noun phrases ("Refrigerant Piping", "AIR CURTAINS"); note
// rows ("The SITC cost shall include the freight…") must NOT become categories.
const NOTE_STARTS = /^(the|all|any|this|these|note|notes?:|rates?|rate\b|quote|quotation|sitc|price|prices|cost|costs|bidder|vendor|contractor|please|kindly|terms?|scope|inclusive|including|excluding|gst|taxes?)\b/i;
function looksLikeGroup(desc: string, qty: number | null): boolean {
  if (qty != null && qty > 0) return false;
  const d = desc.trim();
  if (d.length === 0 || d.length > 80) return false;
  if (NOTE_STARTS.test(d)) return false;        // prose note, not a header
  if (/[.;:]\s*$/.test(d)) return false;         // ends like a sentence
  if (d.split(/\s+/).length > 9) return false;   // too wordy to be a heading
  return true;
}

export function parseSpreadsheet(filePath: string): ParseResult {
  const warnings: string[] = [];
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const out: ParsedBOQRow[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) continue;
    const detected = detectColumns(rows);
    if (!detected) {
      warnings.push(`Sheet "${sheetName}": could not detect a header row — skipped.`);
      continue;
    }
    const { headerIdx, cols } = detected;
    let currentCategory: string | undefined = wb.SheetNames.length > 1 ? sheetName : undefined;

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const desc = String(row[cols.desc ?? 1] ?? '').trim();
      if (!desc) continue;
      const sr = cols.sr !== undefined ? String(row[cols.sr] ?? '').trim() : undefined;
      const unit = cols.unit !== undefined ? normalizeUnit(row[cols.unit]) : undefined;
      const qty = cols.qty !== undefined ? toNumber(row[cols.qty]) : null;

      const isGroup = looksLikeGroup(desc, qty) && !unit;
      if (isGroup) {
        currentCategory = desc;
        out.push({ srNo: sr || undefined, description: desc, category: currentCategory, isGroup: true, plannedQty: 0 });
        continue;
      }
      out.push({
        srNo: sr || undefined,
        description: desc,
        category: currentCategory,
        unit,
        plannedQty: qty ?? 0,
      });
    }
  }

  if (out.length === 0) warnings.push('No BOQ rows could be extracted. You can add items manually.');
  return { rows: out, source: filePath.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx', warnings };
}

const AI_SYSTEM_PROMPT =
  'You are a BOQ (Bill of Quantities) extraction engine for cold-room construction projects. ' +
  'Extract EVERY priced line item from the document text. Return ONLY valid JSON of the form ' +
  '{"rows":[{"srNo":string,"description":string,"category":string,"roomZone":string,"unit":string,"plannedQty":number,"isGroup":boolean}]}. ' +
  "Rules: units must be one of No's, mtr, Sq.M, RMT, MT, set, lot. " +
  'category = the section/heading the item belongs to (e.g. "Refrigerant Piping", "PUF Panels", "Insulated Doors"). ' +
  'roomZone = the cold-room/zone the item is for if stated (e.g. "Blast Freezer", "Freezer", "Chiller", "Ambient", "Anteroom"), else "". ' +
  'isGroup=true ONLY for section header rows that have no quantity. ' +
  'IGNORE prose notes, terms & conditions, totals and freight/tax remarks — they are NOT line items or categories.';

// Returns the configured AI provider name, or null when AI is disabled.
export function aiProvider(): 'groq' | 'anthropic' | null {
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

// Ask Groq (OpenAI-compatible chat completions) to extract the BOQ as JSON.
async function groqExtract(rawText: string): Promise<string> {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: `Extract the BOQ from this document text:\n\n${rawText.slice(0, 50000)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Ask Anthropic Claude to extract the BOQ as JSON.
async function anthropicExtract(rawText: string): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const msg = await client.messages.create({
    model,
    max_tokens: 8000,
    system: AI_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Extract the BOQ from this document text:\n\n${rawText.slice(0, 60000)}` }],
  });
  return msg.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}

// Optional AI extraction. Provider auto-detected (Groq preferred). Falls back
// to null (no AI) gracefully on any error.
export async function aiParse(rawText: string): Promise<ParseResult | null> {
  const provider = aiProvider();
  if (!provider) return null;
  try {
    const text = provider === 'groq' ? await groqExtract(rawText) : await anthropicExtract(rawText);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    const rows: ParsedBOQRow[] = (parsed.rows || []).map((r: any) => ({
      srNo: r.srNo ? String(r.srNo) : undefined,
      description: String(r.description || '').trim(),
      category: r.category || undefined,
      roomZone: r.roomZone || undefined,
      unit: normalizeUnit(r.unit),
      plannedQty: Number(r.plannedQty) || 0,
      isGroup: !!r.isGroup,
    })).filter((r: ParsedBOQRow) => r.description);
    return { rows, source: 'ai', warnings: [] };
  } catch (err) {
    console.error(`[aiParse] ${provider} failed, falling back:`, err);
    return null;
  }
}

// Entry point used by the route: pick parser based on file type.
export async function parseBOQFile(filePath: string, mimeType?: string): Promise<ParseResult> {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) {
    return parseSpreadsheet(filePath);
  }
  if (lower.endsWith('.pdf') || (mimeType && mimeType.includes('pdf'))) {
    // Try AI on the raw bytes turned to text; if no key, return empty + guidance.
    const buf = fs.readFileSync(filePath);
    const text = buf.toString('latin1').replace(/[^\x20-\x7E\n]/g, ' ');
    const ai = await aiParse(text);
    if (ai) return ai;
    return {
      rows: [],
      source: 'empty',
      warnings: [
        'PDF BOQ parsing needs the Claude API (set ANTHROPIC_API_KEY in server/.env) or an .xlsx upload.',
        'You can also add BOQ items manually after creating the project.',
      ],
    };
  }
  return { rows: [], source: 'empty', warnings: ['Unsupported file type. Upload .xlsx, .csv or .pdf.'] };
}
