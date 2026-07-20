// ── Proforma Invoice (PI) reader ─────────────────────────────────────────────
// Reads a vendor's proforma invoice and pulls out the PI number, its date and the
// final payable value, so the payment form fills itself instead of being retyped.
//
// Two paths, cheapest first (same shape as the KYC/TDS readers):
//   1. PDF with a text layer  → pdfjs text + label matching. Deterministic, free.
//   2. Image or scanned PDF   → a vision model reads it (Groq or Anthropic).
// A model's answer is never trusted directly: it is parsed by the SAME helpers
// below, so a hallucinated number can't reach the form.

import fs from 'fs';
import { extractPdfText } from './pdfText';

export interface PiExtract {
  piNumber?: string;
  /** ISO yyyy-mm-dd. */
  piDate?: string;
  /** The final payable amount (grand total), in rupees. */
  piValue?: number;
  source: 'pdf-text' | 'vision' | 'none';
  note?: string;
}

// ── Number / date helpers ─────────────────────────────────────────────────────
const toAmount = (s: string): number | undefined => {
  const n = Number(String(s).replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
/** Accepts 17-07-2026, 17/07/26, 17 Jul 2026, 2026-07-17. Day-first (Indian). */
function toIsoDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) return iso(yr(+m[3]), +m[2], +m[1]);
  m = s.match(/\b(\d{1,2})[\s\-]*([A-Za-z]{3,})[\s\-]*(\d{2,4})\b/);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return iso(yr(+m[3]), mo, +m[1]); }
  return undefined;
}
const yr = (y: number) => (y < 100 ? 2000 + y : y);
function iso(y: number, mo: number, d: number): string | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return undefined;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ── Field extraction from text ────────────────────────────────────────────────
// A PI number sits next to a label; keep it to invoice-ish characters so a stray
// phone number or GSTIN can't be mistaken for one.
// Longest label alternative first, or "Number" would match "num" and capture "ber".
const RE_PI_NO = /(?:proforma\s*invoice|performa\s*invoice|pro[\s-]?forma|p\.?i\.?|invoice|bill|quotation)\s*(?:number|num|no\.?|#)\s*[:.\-#]?\s*([A-Za-z0-9][A-Za-z0-9\/\-_]{1,28})/i;
const RE_DATE_LABELLED = /(?:invoice\s*date|pi\s*date|date)\s*[:.\-]?\s*([0-9]{1,4}[\/\-.\s][A-Za-z0-9]{1,9}[\/\-.\s][0-9]{2,4})/i;
// Total labels, most specific first — a PI's payable figure is the grand total.
const TOTAL_LABELS = [
  /grand\s*total\s*[:.\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  /(?:total\s*(?:invoice\s*)?value|invoice\s*value)\s*[:.\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  /(?:net\s*(?:amount|payable)|amount\s*payable|payable\s*amount)\s*[:.\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  /total\s*[:.\-]?\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d{1,2})?)/i,
];

/** Pull the PI fields out of any text. The only place a value is accepted. */
export function fieldsFromText(text: string): Omit<PiExtract, 'source' | 'note'> {
  const t = (text || '').replace(/ /g, ' ');
  const piNumber = t.match(RE_PI_NO)?.[1]?.trim();

  const dateRaw = t.match(RE_DATE_LABELLED)?.[1];
  const piDate = dateRaw ? toIsoDate(dateRaw) : undefined;

  // Take the LARGEST match from the most specific label that hits — a PI lists
  // sub-totals and taxes too, and the payable figure is the biggest of them.
  let piValue: number | undefined;
  for (const re of TOTAL_LABELS) {
    const all = [...t.matchAll(new RegExp(re.source, re.flags + 'g'))]
      .map((m) => toAmount(m[1])).filter((n): n is number => n != null);
    if (all.length) { piValue = Math.max(...all); break; }
  }
  return { piNumber, piDate, piValue };
}

const hasAny = (f: Omit<PiExtract, 'source' | 'note'>) => !!(f.piNumber || f.piDate || f.piValue != null);

const VISION_PROMPT =
  'This is a vendor proforma invoice (PI) / invoice. Read it and return ONLY JSON: ' +
  '{"piNumber":string,"piDate":string,"piValue":string}. ' +
  'piNumber is the invoice/proforma number as printed. piDate is the invoice date. ' +
  'piValue is the FINAL payable grand total (after taxes), digits only. ' +
  'Use "" for anything not printed. Copy exactly as printed — do not guess or invent.';

async function groqVision(b64: string, mime: string): Promise<string> {
  const model = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model, temperature: 0, max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'text', text: VISION_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function anthropicVision(b64: string, mime: string, isPdf: boolean): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest', max_tokens: 400,
      messages: [{ role: 'user', content: [
        isPdf
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
          : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: VISION_PROMPT },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data.content?.[0]?.text ?? '';
}

/** Parse the model's JSON answer through the same trusted helpers. */
function fieldsFromModelJson(raw: string): Omit<PiExtract, 'source' | 'note'> {
  const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
  let o: Record<string, unknown> = {};
  try { o = JSON.parse(json); } catch { return fieldsFromText(raw); }
  const piNumber = typeof o.piNumber === 'string' && o.piNumber.trim() ? o.piNumber.trim().slice(0, 40) : undefined;
  const piDate = typeof o.piDate === 'string' && o.piDate.trim() ? toIsoDate(o.piDate) : undefined;
  const piValue = o.piValue != null && String(o.piValue).trim() ? toAmount(String(o.piValue)) : undefined;
  return { piNumber, piDate, piValue };
}

/**
 * Read a PI file. Never throws — on any failure it returns source:'none' with a
 * note, so an upload is never blocked by the reader.
 */
export async function extractPiFields(filePath: string, mimeType?: string): Promise<PiExtract> {
  const isPdf = /pdf$/i.test(filePath) || !!mimeType?.includes('pdf');

  // 1. A digitally-generated PDF carries its own text — exact, free, no model.
  if (isPdf) {
    const text = await extractPdfText(filePath, 12000);
    const f = fieldsFromText(text);
    if (hasAny(f)) return { ...f, source: 'pdf-text' };
  }

  // 2. Otherwise it is an image (or a scan), so a vision model has to read it.
  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  const groq = !!process.env.GROQ_API_KEY;
  if (!anthropic && !groq) return { source: 'none', note: 'No AI key configured — set GROQ_API_KEY or ANTHROPIC_API_KEY to read scans and images.' };
  if (isPdf && !anthropic) return { source: 'none', note: 'This PDF is a scan (no text layer). Upload it as an image, or set ANTHROPIC_API_KEY to read scanned PDFs.' };

  try {
    const b64 = fs.readFileSync(filePath).toString('base64');
    const mime = mimeType || (/\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg');
    const raw = anthropic ? await anthropicVision(b64, mime, isPdf) : await groqVision(b64, mime);
    const f = fieldsFromModelJson(raw);
    if (hasAny(f)) return { ...f, source: 'vision' };
    return { source: 'none', note: 'Could not read the PI number, date or total on this document.' };
  } catch (err) {
    console.error('[extractPiFields] vision failed:', (err as Error).message);
    return { source: 'none', note: 'Could not read this PI automatically — please fill the fields manually.' };
  }
}
