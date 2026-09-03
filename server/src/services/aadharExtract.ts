// Read the 12-digit Aadhaar number off an uploaded Aadhaar card. Same two-path
// approach as kycExtract:
//   1. PDF with a text layer  → pdfjs text + regex (free, exact).
//   2. Image or scanned PDF   → a vision model reads it (Groq or Anthropic).
// Works on JPG/PNG images too — a PDF is NOT required. Never throws; on failure it
// returns { aadhaar: null, note }, so an upload is never blocked by the reader.
import fs from 'fs';
import { extractPdfText } from './pdfText';

export interface AadharExtract { aadhaar: string | null; source: 'pdf-text' | 'vision' | 'none'; note?: string }

// Aadhaar is 12 digits, usually printed as "XXXX XXXX XXXX". Pull 12-digit groups
// and reject 10-digit (phone) / 16-digit (VID) neighbours by anchoring on the exact
// four-four-four shape first, then a bare 12-run.
export function aadhaarFromText(text: string): string | null {
  const spaced = text.match(/\b(\d{4}\s\d{4}\s\d{4})\b/);
  if (spaced) return spaced[1].replace(/\s/g, '');
  // A bare 12-digit run that is NOT part of a longer digit string (avoids VID-16).
  const bare = text.match(/(?<!\d)(\d{12})(?!\d)/);
  if (bare) return bare[1];
  return null;
}

const PROMPT = 'This is an Indian Aadhaar card. Return ONLY JSON: {"aadhaar":"<the 12-digit Aadhaar number, digits only, no spaces>"}. ' +
  'Copy the digits exactly as printed — do not guess or invent. Use "" if no 12-digit Aadhaar number is printed. Ignore any 16-digit VID.';

async function groqVision(b64: string, mime: string): Promise<string> {
  const model = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }] }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function anthropicVision(b64: string, mime: string, isPdf: boolean): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const block: any = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  const msg = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8', max_tokens: 200,
    messages: [{ role: 'user', content: [block, { type: 'text', text: PROMPT }] }],
  });
  return msg.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}

export async function extractAadharNumber(filePath: string, mimeType?: string): Promise<AadharExtract> {
  const isPdf = /pdf$/i.test(filePath) || !!mimeType?.includes('pdf');

  if (isPdf) {
    try {
      const text = await extractPdfText(filePath, 8000);
      const a = aadhaarFromText(text);
      if (a) return { aadhaar: a, source: 'pdf-text' };
    } catch { /* fall through to vision */ }
  }

  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  const groq = !!process.env.GROQ_API_KEY;
  if (!anthropic && !groq) return { aadhaar: null, source: 'none', note: 'No AI key configured — enter the Aadhaar number manually.' };
  if (isPdf && !anthropic) return { aadhaar: null, source: 'none', note: 'This PDF is a scan — upload it as an image, or enter the number manually.' };

  try {
    const b64 = fs.readFileSync(filePath).toString('base64');
    const mime = mimeType || (/\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg');
    const raw = anthropic ? await anthropicVision(b64, mime, isPdf) : await groqVision(b64, mime);
    const a = aadhaarFromText(raw);
    if (a) return { aadhaar: a, source: 'vision' };
    return { aadhaar: null, source: 'none', note: 'Could not read the Aadhaar number — please enter it manually.' };
  } catch (err) {
    console.error('[extractAadharNumber] vision failed:', (err as Error).message);
    return { aadhaar: null, source: 'none', note: 'Could not read this document automatically — enter the number manually.' };
  }
}
