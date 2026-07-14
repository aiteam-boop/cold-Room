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
  makeModel?: string;
  remarks?: string;
  plannedQty: number;
  isGroup?: boolean;
  flagged?: boolean; // low-confidence quantity mapping — review before import
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

type Cols = { sr?: number; desc?: number; unit?: number; qty?: number; makeModel?: number; remarks?: number };

// Find the header row + column indexes by fuzzy header matching. Real BOQ sheets
// often SPLIT the header across two rows (e.g. "Quantity"/"Units" on one row and
// "MAKE & MODEL" typed into the next), so once the primary header row is found we
// also pick up any still-unassigned column labels from the next two rows.
// `qtyCols` is the full set of columns the Quantity header spans (it is commonly
// merged across several per-site columns), so the value can be read from whichever
// of them actually holds it.
function detectColumns(rows: unknown[][], merges: MergeRange[]): {
  headerIdx: number;
  cols: Cols;
  qtyCols: number[];
} | null {
  const scan = (cols: Cols, rowIdx: number) => {
    const row = (rows[rowIdx] ?? []).map((c) => String(c ?? '').toLowerCase().trim());
    row.forEach((cell, i) => {
      if (!cell) return;
      if (cols.sr === undefined && /(sr\.?\s*no|s\.?\s*no|sl\.?\s*no|item\s*no|^#$)/.test(cell)) cols.sr = i;
      if (cols.desc === undefined && /(description|particular|item|activity|scope|work)/.test(cell)) cols.desc = i;
      if (cols.unit === undefined && /(unit|uom|u\.o\.m)/.test(cell)) cols.unit = i;
      if (cols.qty === undefined && /(qty|quantity|planned|nos\b)/.test(cell)) cols.qty = i;
      if (cols.makeModel === undefined && /(make\s*&?\s*model|make\s*\/\s*model|make and model|^make$|^model$|brand)/.test(cell)) cols.makeModel = i;
      if (cols.remarks === undefined && /(remark|^notes?$)/.test(cell)) cols.remarks = i;
    });
  };

  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cols: Cols = {};
    scan(cols, r);
    if (cols.desc !== undefined && (cols.qty !== undefined || cols.unit !== undefined)) {
      // Pick up split header labels (e.g. MAKE & MODEL) from the next two rows.
      scan(cols, r + 1);
      scan(cols, r + 2);

      // Quantity is frequently a merged header spanning several columns; collect
      // them so the row reader can take the value from whichever column holds it.
      let qtyCols: number[] = cols.qty !== undefined ? [cols.qty] : [];
      if (cols.qty !== undefined) {
        const span = merges.find((m) => m.s.r <= r && m.e.r >= r && m.s.c <= cols.qty! && m.e.c >= cols.qty! && m.e.c > m.s.c);
        if (span) {
          qtyCols = [];
          for (let c = span.s.c; c <= span.e.c; c++) qtyCols.push(c);
        }
      }
      return { headerIdx: r, cols, qtyCols };
    }
  }
  return null;
}

// Under a merged "Quantity" header, real BOQ cost sheets place several per-site
// sub-columns (e.g. a reference "Ranchi" column beside THIS sheet's own column).
// The header-detected column is only the FIRST of the span and may belong to a
// different site, so pick the sub-column that actually holds this sheet's
// quantity: a sub-header naming this very sheet/site wins; otherwise an
// UNLABELED column (the current site's — they leave its sub-header blank),
// choosing the densest. `resolved` is true only when we deliberately picked a
// site column, so the caller can treat it as authoritative (and stop flagging a
// differing foreign-site column as an "ambiguous" duplicate).
function choosePrimaryQtyCol(
  rows: unknown[][], headerIdx: number, qtyCols: number[], sheetName: string, fallback: number,
): { col: number; resolved: boolean } {
  if (qtyCols.length <= 1) return { col: fallback, resolved: false };
  const sub = rows[headerIdx + 1] ?? [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const site = norm(sheetName);
  const labelOf = (c: number) => String(sub[c] ?? '').trim();

  // 1. A sub-header naming this very sheet/site is unambiguous.
  if (site) {
    const named = qtyCols.find((c) => { const l = norm(labelOf(c)); return !!l && (l === site || l.includes(site) || site.includes(l)); });
    if (named !== undefined) return { col: named, resolved: true };
  }
  // 2. An unlabeled sub-column is the current site's own quantity; pick the one
  //    carrying the most values (the live column, not an empty spare).
  const density = (c: number) => { let n = 0; for (let r = headerIdx + 2; r < rows.length; r++) if (toNumber(rows[r]?.[c]) != null) n++; return n; };
  const blanks = qtyCols.filter((c) => !labelOf(c));
  if (blanks.length) return { col: blanks.reduce((best, c) => (density(c) > density(best) ? c : best), blanks[0]), resolved: true };
  // 3. All sub-columns are labelled foreign sites — keep the header column and
  //    let the caller flag the row for manual review.
  return { col: fallback, resolved: false };
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

// BOQ sheets merge cells like "Make & Model" / "Remarks" across the rows they
// apply to; XLSX only stores the value in the merge's top-left cell, leaving the
// spanned rows blank. This resolves a cell to its merged value so those columns
// fill in for every line they cover. `merges` use the same 0-based row/col
// indexing as a header:1 grid read with blankrows kept.
type MergeRange = { s: { r: number; c: number }; e: { r: number; c: number } };
function resolveMerged(rows: unknown[][], merges: MergeRange[], r: number, c: number): unknown {
  const v = rows[r]?.[c];
  if (v !== undefined && String(v).trim() !== '') return v;
  for (const m of merges) {
    if (r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c) return rows[m.s.r]?.[m.s.c];
  }
  return v;
}

export function parseSpreadsheet(filePath: string): ParseResult {
  const warnings: string[] = [];
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const out: ParsedBOQRow[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    // Keep blank rows so row indices stay aligned with the merge ranges.
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true, defval: '' });
    const merges = ((sheet['!merges'] as MergeRange[]) || []);
    if (!rows.length) continue;
    const detected = detectColumns(rows, merges);
    if (!detected) {
      warnings.push(`Sheet "${sheetName}": could not detect a header row — skipped.`);
      continue;
    }
    const { headerIdx, cols, qtyCols } = detected;
    // Under a merged Quantity header (per-site sub-columns), pick THIS sheet's
    // own quantity column rather than the first (possibly a different site's).
    const { col: primaryQtyCol, resolved: qtyResolved } = choosePrimaryQtyCol(rows, headerIdx, qtyCols, sheetName, cols.qty ?? -1);
    let currentCategory: string | undefined = wb.SheetNames.length > 1 ? sheetName : undefined;
    let flaggedCount = 0;

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const desc = String(row[cols.desc ?? 1] ?? '').trim();
      if (!desc) continue;
      // Drop only obvious page-break / continuation artifacts. Subtotal & total
      // rows ARE imported as line items (per project preference) — note this can
      // double-count against the detailed lines in completion math.
      if (/^(page\s*\d+|continued\b)/i.test(desc)) continue;

      // srNo & unit may be merged down a block of rows (e.g. one "a" over 5 rows).
      const srRaw = cols.sr !== undefined ? String(resolveMerged(rows, merges, r, cols.sr) ?? '').trim() : '';
      const sr = srRaw || undefined;
      const unit = cols.unit !== undefined ? normalizeUnit(resolveMerged(rows, merges, r, cols.unit)) : undefined;

      // Quantity: read DIRECTLY from this row only (never filled down from a
      // merge — each line keeps its own quantity, e.g. a/0/2 across a block).
      // The labeled "Quantity" column (cols.qty) is authoritative. It is often a
      // merged header spanning extra columns where a value occasionally lands; we
      // use those only as a fallback and flag the row for manual review whenever
      // the source is ambiguous (value only in a secondary column, or two columns
      // disagree). This keeps the common case an exact 1:1 match.
      const primaryQty = primaryQtyCol >= 0 ? toNumber(row[primaryQtyCol]) : null;
      let qty: number | null;
      let ambiguousQty = false;
      if (qtyResolved) {
        // We identified THIS sheet's own quantity column; it is authoritative.
        // Values in the other (foreign-site) columns are expected, not ambiguous,
        // and an empty cell here means the item simply isn't in this site.
        qty = primaryQty;
      } else {
        // Quantity header may span extra columns where a value occasionally lands;
        // use the labelled column, fall back to a secondary, and flag when the
        // source is ambiguous (value only in a secondary column, or two disagree).
        const otherQty = qtyCols.filter((c) => c !== primaryQtyCol).map((c) => toNumber(row[c])).filter((n): n is number => n != null);
        if (primaryQty != null) {
          qty = primaryQty;
          if (otherQty.some((o) => o !== primaryQty)) ambiguousQty = true; // conflicting secondary value
        } else if (otherQty.length) {
          qty = otherQty[0]; // value sits only in a secondary column — use but flag
          ambiguousQty = true;
        } else {
          qty = null;
        }
      }

      // makeModel / remarks DO carry down merged blocks. Strip any header label
      // that leaked into a data cell (e.g. the literal "MAKE & MODEL").
      const HEADER_LEAK = /^(make\s*&?\s*model|make and model|make\s*\/\s*model|remarks?|units?|quantity|s\.?\s*no|sr\.?\s*no|description)$/i;
      const cleanCell = (v: unknown): string | undefined => {
        const s = String(v ?? '').trim();
        return s && !HEADER_LEAK.test(s) ? s : undefined;
      };
      const makeModel = cols.makeModel !== undefined ? cleanCell(resolveMerged(rows, merges, r, cols.makeModel)) : undefined;
      const remarks = cols.remarks !== undefined ? cleanCell(resolveMerged(rows, merges, r, cols.remarks)) : undefined;

      const isGroup = looksLikeGroup(desc, qty) && !unit;
      if (isGroup) {
        currentCategory = desc;
        out.push({ srNo: sr, description: desc, category: currentCategory, isGroup: true, plannedQty: 0 });
        continue;
      }
      if (ambiguousQty) flaggedCount++;
      out.push({
        srNo: sr,
        description: desc,
        category: currentCategory,
        unit,
        makeModel,
        remarks,
        plannedQty: qty ?? 0,
        flagged: ambiguousQty || undefined,
      });
    }
    if (flaggedCount > 0) warnings.push(`Sheet "${sheetName}": ${flaggedCount} row(s) had an ambiguous quantity (value in more than one column) — please review the highlighted rows.`);
  }

  if (out.length === 0) warnings.push('No BOQ rows could be extracted. You can add items manually.');
  return { rows: out, source: filePath.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx', warnings };
}

const AI_SYSTEM_PROMPT =
  'You are a BOQ (Bill of Quantities) extraction engine for cold-room construction projects. ' +
  'Extract EVERY priced line item from the document text. Return ONLY valid JSON of the form ' +
  '{"rows":[{"srNo":string,"description":string,"category":string,"roomZone":string,"unit":string,"makeModel":string,"remarks":string,"plannedQty":number,"isGroup":boolean}]}. ' +
  'makeModel = the "Make & Model" / brand / equivalent text for the item if stated, else "". ' +
  'remarks = the "Remarks" column text (specs/notes) for the item if stated, else "". ' +
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
      makeModel: r.makeModel ? String(r.makeModel).trim() : undefined,
      remarks: r.remarks ? String(r.remarks).trim() : undefined,
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
