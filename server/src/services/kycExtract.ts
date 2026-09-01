// ── KYC document reader ──────────────────────────────────────────────────────
// Reads a vendor's GST certificate / PAN card / incorporation certificate and
// pulls out the GSTIN, PAN and CIN so the Financial tab fills itself instead of
// being retyped by hand.
//
// Two paths, cheapest first:
//   1. PDF with a text layer  → pdfjs text + regex. Deterministic, free, exact.
//   2. Image or scanned PDF   → a vision model reads it (Groq or Anthropic).
// Whatever a model returns is still run through the SAME regexes below, so a
// hallucinated or malformed number can never reach the vendor record.

import fs from 'fs';
import { extractPdfText } from './pdfText';

export interface KycExtract {
  gstin?: string;
  pan?: string;
  cin?: string;
  /** How it was read — surfaced to the UI so the user knows what to trust. */
  source: 'pdf-text' | 'vision' | 'none';
  /** Set when nothing could be read, to explain why. */
  note?: string;
}

// Statutory formats. Anchored on word boundaries so a number embedded in a
// longer string can't produce a partial match.
//   GSTIN 15: 2-digit state + 10-char PAN + entity code + 'Z' + checksum
//   PAN   10: 5 letters + 4 digits + 1 letter
//   CIN   21: L/U + 5 digits + 2-letter state + 4-digit year + 3-letter type + 6 digits
const RE_GSTIN = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/;
const RE_PAN = /\b([A-Z]{5}\d{4}[A-Z])\b/;
const RE_CIN = /\b([LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/;

/** Pull the three numbers out of any text. The only place a value is accepted. */
export function fieldsFromText(text: string): Pick<KycExtract, 'gstin' | 'pan' | 'cin'> {
  // OCR and PDF text often break a number across spaces ("23 AAACK1091J1ZS").
  const up = (text || '').toUpperCase();
  const tight = up.replace(/[\s ._-]+/g, ' ');
  const glued = up.replace(/[\s ._-]+/g, '');
  const find = (re: RegExp) => tight.match(re)?.[1] ?? glued.match(re)?.[1];

  const gstin = find(RE_GSTIN);
  // A GSTIN embeds the PAN at characters 3–12, so a GST certificate alone gives
  // us both — no need for the PAN card to be uploaded too.
  const pan = find(RE_PAN) ?? (gstin ? gstin.slice(2, 12) : undefined);
  const cin = find(RE_CIN);
  return { gstin, pan, cin };
}

const hasAny = (f: Pick<KycExtract, 'gstin' | 'pan' | 'cin'>) => !!(f.gstin || f.pan || f.cin);

const VISION_PROMPT =
  'This is an Indian statutory document (GST registration certificate, PAN card, or certificate of incorporation). ' +
  'Read it and return ONLY JSON: {"gstin":string,"pan":string,"cin":string}. ' +
  'Use "" for anything not printed on the document. Copy the characters exactly as printed — do not guess, correct or invent. ' +
  'GSTIN is 15 characters, PAN is 10 characters, CIN is 21 characters.';

// Groq (OpenAI-compatible) with a vision model — the default path, since GROQ_API_KEY
// is the key this deployment has. GROQ_MODEL is a text model, so vision needs its own.
async function groqVision(b64: string, mime: string): Promise<string> {
  const model = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Anthropic — better at this, and the only one that can read a SCANNED PDF
// directly (as a document block). Used when ANTHROPIC_API_KEY is configured.
async function anthropicVision(b64: string, mime: string, isPdf: boolean): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const block: any = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  const msg = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    max_tokens: 300,
    messages: [{ role: 'user', content: [block, { type: 'text', text: VISION_PROMPT }] }],
  });
  return msg.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}

/**
 * Read a KYC file. Never throws — on any failure it returns source:'none' with a
 * note, so an upload is never blocked by the reader.
 */
export async function extractKycFields(filePath: string, mimeType?: string): Promise<KycExtract> {
  const isPdf = /pdf$/i.test(filePath) || !!mimeType?.includes('pdf');

  // 1. A digitally-generated PDF carries its own text — exact, free, no model.
  if (isPdf) {
    const text = await extractPdfText(filePath, 8000);
    const f = fieldsFromText(text);
    if (hasAny(f)) return { ...f, source: 'pdf-text' };
  }

  // 2. Otherwise it is an image (or a scan), so a vision model has to read it.
  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  const groq = !!process.env.GROQ_API_KEY;
  if (!anthropic && !groq) {
    return { source: 'none', note: 'No AI key configured — set GROQ_API_KEY or ANTHROPIC_API_KEY to read scans and images.' };
  }
  // Groq cannot read a PDF; only Anthropic can. A scanned PDF with no Anthropic
  // key is the one case we genuinely cannot handle.
  if (isPdf && !anthropic) {
    return { source: 'none', note: 'This PDF is a scan (no text layer). Upload it as an image, or set ANTHROPIC_API_KEY to read scanned PDFs.' };
  }

  try {
    const b64 = fs.readFileSync(filePath).toString('base64');
    const mime = mimeType || (/\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg');
    const raw = anthropic ? await anthropicVision(b64, mime, isPdf) : await groqVision(b64, mime);
    // The model's answer is treated as untrusted text: the regexes decide.
    const json = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
    const f = fieldsFromText(json);
    if (hasAny(f)) return { ...f, source: 'vision' };
    return { source: 'none', note: 'Could not find a GSTIN, PAN or CIN on this document.' };
  } catch (err) {
    console.error('[extractKycFields] vision failed:', (err as Error).message);
    return { source: 'none', note: 'Could not read this document automatically — please fill the fields manually.' };
  }
}
