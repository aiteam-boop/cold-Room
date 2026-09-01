// ── TDS (Technical Data Sheet) reader (Machine-Model/TDS PRD §1–§4) ────────────
// Reads a machine's datasheet and pulls the technical fields so the Machine Model
// master fills itself instead of being retyped.
//
// Two paths, cheapest first — the same shape as the KYC reader:
//   1. PDF with a text layer  → pdfjs text + label matching. Deterministic, free.
//   2. Image / scanned PDF    → a vision model (Groq / Anthropic) returns the same
//      fields as JSON, which is then normalised through the SAME logic below.
//
// IDU and ODU sheets label the same thing differently (Evaporator Temp vs
// Evaporating SST, Capacity vs Cooling Capacity), so every field matches on a set
// of synonyms. `specs` keeps every "Label: value" pair read off the sheet, so new
// datasheet formats still capture their data even before we columnise a field.

import fs from 'fs';
import { extractPdfText } from './pdfText';

export type TdsFormat = 'IDU' | 'ODU' | 'OTHER';

export interface TdsExtract {
  modelNumber?: string;
  make?: string;
  tdsFormat: TdsFormat;
  capacityKW?: number;
  refrigerantType?: string;
  evaporatorTempC?: number;
  condenserTempC?: number;
  ambientTempC?: number;
  airflow?: string;
  finSpacing?: string;
  fanDetail?: string;
  powerInputKw?: number;
  weightKg?: number;
  dimensions?: string;
  voltage?: string;
  compressorType?: string;
  compressorModel?: string;
  /** Every "Label: value" pair read off the sheet — nothing is lost. */
  specs: Record<string, string>;
  source: 'pdf-text' | 'vision' | 'none';
  note?: string;
}

const num = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : undefined;
};

// Turn the datasheet text into a flat { label: value } map. TDS sheets are
// two-column "Label   value" layouts, which pdfjs flattens to "Label value" runs.
// We split each meaningful line into a label (words) and its value (the rest,
// usually starting at a number/measurement).
function toSpecs(text: string): Record<string, string> {
  const specs: Record<string, string> = {};
  // pdfjs joins the page into one line; re-break before each known label-ish start
  // and on measurement boundaries. Work line-by-line where possible.
  const lines = text.split(/\n|(?=\b(?:Capacity|Surface|Air Flow|Air Throw|Refrigerant|Evaporat|Condens|Ambient|DT1|Fan |Fin Spacing|Voltage|Current|Defrost|Weight|Width|Length|Height|Power|Compressor|Unit |Series|Suction|Useful|Motor|Connection|Dimensions|Tubes|Fins|Inlet|Outlet)\b)/g);
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // "Label <value>" — the value starts at the first digit, currency, or all-caps token.
    const m = line.match(/^([A-Za-z][A-Za-z0-9°\/().%\- ]{1,40}?)\s+((?:[-+]?\d|R\d|Ø|COPPER|ALUM|GI |Air |Semi|Electric|DOL|Yes|No|Standard|Dew|Refer).*)$/);
    if (m) {
      const label = m[1].replace(/[:\s]+$/, '').trim();
      const value = m[2].trim();
      if (label && value && !specs[label]) specs[label] = value;
    }
  }
  return specs;
}

// pdfjs flattens the two-column layout onto one line, so a string value often runs
// into the NEXT field's label. Cut a value at the first known trailing label.
const TRAILING = [
  'Unit Type', 'Series', 'Reference Temperature', 'Evaporating', 'Condensing', 'Ambient', 'Suction', 'Useful',
  'Condensing Unit', 'COMPRESSOR', 'Compressor', 'Cooling', 'Capacity', 'Power', 'Voltage', 'Liquid', 'Motor',
  'Electrical', 'Max.', 'Total', 'Connection', 'Weight', 'Dimensions', 'Fan Current', 'Fan Voltage', 'Defrost',
  'Fin Spacing', 'Surface', 'Air Throw', 'Air Flow', 'Casing', 'Tubes', 'Fins', 'Width', 'Length', 'Height',
  'Inlet', 'Outlet', 'Oil Separator', 'Axial Fans', 'Vibration', 'Solenoid', 'Sight', 'Rotalock', 'Filter',
  'HP/LP', 'Discharge', 'DT1', 'Refrigerant',
];
function cleanValue(v: string | undefined, keepLabels: string[] = []): string | undefined {
  if (!v) return undefined;
  let out = v.trim();
  let cut = out.length;
  for (const lbl of TRAILING) {
    if (keepLabels.some((k) => lbl.toLowerCase() === k.toLowerCase())) continue;
    const i = out.indexOf(` ${lbl}`, 1);
    if (i > 0 && i < cut) cut = i;
  }
  out = out.slice(0, cut).trim();
  return out || undefined;
}

// Pull one field by trying each label synonym against the specs map (and, as a
// fallback, a direct regex over the whole text for oddly-wrapped lines). `keep`
// lists labels that are legitimately part of THIS value, so cleanValue won't cut
// them (e.g. "Fan Voltage" is the label, not a boundary inside the voltage value).
function pick(specs: Record<string, string>, text: string, labels: string[], keep: string[] = []): string | undefined {
  for (const key of Object.keys(specs)) {
    const kl = key.toLowerCase();
    if (labels.some((l) => kl === l.toLowerCase() || kl.startsWith(l.toLowerCase()))) return cleanValue(specs[key], keep);
  }
  for (const l of labels) {
    // `\s*:?\s*` — do NOT eat a leading "-" (that is the minus of a value like -25).
    const re = new RegExp(`${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:?\\s*([^\\n]{1,40})`, 'i');
    const m = text.match(re);
    if (m) return cleanValue(m[1].trim(), keep);
  }
  return undefined;
}

/** Fold a raw text (from pdfjs OR a vision model's JSON) into the normalised shape. */
export function fieldsFromText(text: string): Omit<TdsExtract, 'source' | 'note'> {
  const specs = toSpecs(text);
  const t = text;
  const format: TdsFormat = /Compressor Technical Data Sheet|Unit Model Name|Evaporating SST|Condensing SDT|CONDENSING UNIT|COMPRESSOR\b/i.test(t)
    ? 'ODU'
    : /Air Throw|Fin Spacing|Evaporator Temp|Fan Detail|Casing Details/i.test(t)
      ? 'IDU'
      : 'OTHER';

  // Prefer a full model code seen in the text (keeps the "MEE"/"MCSH" prefix that
  // the label capture can swallow), else the labelled value.
  const codeMatch = t.match(/\b(M[A-Z]{1,3}[- ]?\d{3,4}[- ]?\d?[A-Z]?(?:[ \-][0-9A-Z]{1,4}){0,4})\b/)?.[1];
  const labelledModel = pick(specs, t, ['Unit Model Name', 'Model']);
  const modelNumber = (codeMatch && (!labelledModel || codeMatch.includes(labelledModel.split(' ')[0])))
    ? codeMatch : (labelledModel || codeMatch);
  const make = /micro\s*coils|microcool/i.test(t) ? 'Micro Coils / MicroCool'
    : (t.match(/property of\s+([A-Z][A-Za-z .&]+?(?:PVT LTD|LTD|LIMITED))/i)?.[1]);

  return {
    tdsFormat: format,
    modelNumber: modelNumber?.trim(),
    make: make?.trim(),
    capacityKW: num(pick(specs, t, ['Cooling Capacity', 'Capacity'])),
    refrigerantType: pick(specs, t, ['Refrigerant Type', 'Refrigerant'])?.split(/\s/)[0],
    evaporatorTempC: num(pick(specs, t, ['Evaporating SST', 'Evaporator Temp'])),
    condenserTempC: num(pick(specs, t, ['Condensing SDT', 'Condenser Temp'])),
    ambientTempC: num(pick(specs, t, ['Ambient temperature', 'Ambient'])),
    airflow: pick(specs, t, ['Condensing Unit Air Flow', 'Air Flow'], ['Air Flow']),
    finSpacing: pick(specs, t, ['Fin Spacing']),
    fanDetail: pick(specs, t, ['Fan Detail', 'Axial Fans']),
    powerInputKw: num(pick(specs, t, ['Power Input', 'Max. Power Input to the Compressor Motor'])),
    weightKg: num(pick(specs, t, ['Weight (Approx.)', 'Weight'])),
    dimensions: (() => {
      const L = num(pick(specs, t, ['Total Length (L)', 'Length']));
      const W = num(pick(specs, t, ['Total Width (W)', 'Width']));
      const H = num(pick(specs, t, ['Total Height (H)', 'Height']));
      return L && W && H ? `${L} x ${W} x ${H} mm` : undefined;
    })(),
    // "Fan Voltage" / "Voltage Range" are the labels; keep them from being cut.
    voltage: pick(specs, t, ['Voltage Range', 'Fan Voltage', 'Power Supply'], ['Voltage', 'Fan Voltage']),
    compressorType: pick(specs, t, ['Compressor Type']),
    // The compressor MODEL (e.g. "HGX56e/995-4L (Bock)") sits after the all-caps
    // COMPRESSOR heading; its value starts with a letter so grab it directly.
    compressorModel: t.match(/COMPRESSOR\s+([A-Z0-9][A-Za-z0-9/\-]+(?:\s*\([^)]+\))?)/)?.[1]?.trim(),
    specs,
  };
}

const anyField = (f: Omit<TdsExtract, 'source' | 'note'>) =>
  !!(f.modelNumber || f.capacityKW != null || f.evaporatorTempC != null || f.condenserTempC != null || Object.keys(f.specs).length > 2);

const VISION_PROMPT =
  'This is a refrigeration/HVAC Technical Data Sheet (TDS) for an indoor unit (IDU), outdoor/condensing unit (ODU) or expansion device. ' +
  'Read every "Label: value" line and return ONLY JSON: {"lines":["Label: value", ...]}. ' +
  'Copy the text exactly as printed — do not summarise, reformat, or invent values.';

async function groqVision(b64: string, mime: string): Promise<string> {
  const model = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }] }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
  return Array.isArray(parsed.lines) ? parsed.lines.join('\n') : JSON.stringify(parsed);
}

async function anthropicVision(b64: string, mime: string, isPdf: boolean): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const block: any = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  const msg = await client.messages.create({ model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8', max_tokens: 1500, messages: [{ role: 'user', content: [block, { type: 'text', text: VISION_PROMPT }] }] });
  const raw = msg.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
  try { const p = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}'); return Array.isArray(p.lines) ? p.lines.join('\n') : raw; } catch { return raw; }
}

/**
 * Read a TDS. Never throws — on failure returns source:'none' with a note, so an
 * upload is never blocked and the user just fills the fields by hand.
 */
export async function extractTds(filePath: string, mimeType?: string): Promise<TdsExtract> {
  const isPdf = /pdf$/i.test(filePath) || !!mimeType?.includes('pdf');

  // 1. Digitally-generated PDF (both our samples are) — exact, free, no model.
  if (isPdf) {
    const text = await extractPdfText(filePath, 12000);
    const f = fieldsFromText(text);
    if (anyField(f)) return { ...f, source: 'pdf-text' };
  }

  // 2. Image / scan → a vision model reads it.
  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  const groq = !!process.env.GROQ_API_KEY;
  if (!anthropic && !groq) return { tdsFormat: 'OTHER', specs: {}, source: 'none', note: 'No AI key configured — set GROQ_API_KEY or ANTHROPIC_API_KEY to read scanned TDS.' };
  if (isPdf && !anthropic) return { tdsFormat: 'OTHER', specs: {}, source: 'none', note: 'This PDF is a scan (no text layer). Upload it as an image, or set ANTHROPIC_API_KEY.' };

  try {
    const b64 = fs.readFileSync(filePath).toString('base64');
    const mime = mimeType || (/\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg');
    const text = anthropic ? await anthropicVision(b64, mime, isPdf) : await groqVision(b64, mime);
    const f = fieldsFromText(text);
    if (anyField(f)) return { ...f, source: 'vision' };
    return { tdsFormat: 'OTHER', specs: {}, source: 'none', note: 'Could not read the datasheet automatically — please fill the fields manually.' };
  } catch (err) {
    console.error('[extractTds] failed:', (err as Error).message);
    return { tdsFormat: 'OTHER', specs: {}, source: 'none', note: 'Could not read this TDS automatically — please fill the fields manually.' };
  }
}
