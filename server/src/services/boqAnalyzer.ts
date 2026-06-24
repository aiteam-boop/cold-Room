// ── AI BOQ analyzer (the "bible") ───────────────────────────────────────────
// Reads the raw BOQ line items and produces a CLEAN, structured procurement
// breakdown — key requirements, specs, quantities, dependencies, notes —
// instead of the long verbatim descriptions. The raw BOQItem table is untouched.

import { aiProvider } from './boqParser';

export interface AnalyzedItem {
  srNo?: string;
  itemName: string;
  category?: string;
  quantity?: number | null;
  unit?: string;
  specifications?: string;
  requirements?: string;
  dependencies?: string;
  notes?: string;
}

export interface RawItem { srNo?: string | null; description: string; category?: string | null; unit?: string | null; plannedQty?: number | null; }

const SYSTEM =
  'You are a senior procurement analyst for cold-storage / cold-room construction. ' +
  'You are given RAW BOQ (Bill of Quantities) line items with long technical descriptions, notes and terms mixed together. ' +
  'Produce a CLEAN, structured procurement breakdown that a buyer can act on. For each meaningful procurement ITEM return: ' +
  'itemName (short clear name, e.g. "DX Cold Room Unit (Indoor+Outdoor)"), category, quantity (number or null), unit, ' +
  'specifications (the KEY technical specs only, concise, separated by "; " — strip filler/marketing words), ' +
  'requirements (what the vendor must supply/approve/submit, concise), ' +
  'dependencies (what it must coordinate with or depends on, concise; "" if none), ' +
  'notes (important caveats/conditions, concise; "" if none). ' +
  'MERGE continuation rows and duplicate descriptions into one item. Fold standalone "Note:"/terms rows into the notes of the most relevant item rather than creating empty items. ' +
  'Keep it faithful — do not invent specs. Return strict JSON: ' +
  '{"items":[{"srNo":string,"itemName":string,"category":string,"quantity":number|null,"unit":string,"specifications":string,"requirements":string,"dependencies":string,"notes":string}]}.';

async function callGroq(user: string): Promise<string> {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: 8000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
async function callAnthropic(user: string): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const msg = await client.messages.create({ model, max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: user }] });
  return msg.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}

function parseItems(text: string): AnalyzedItem[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return []; }
  return (parsed.items || [])
    .map((r: any) => ({
      srNo: r.srNo ? String(r.srNo) : undefined,
      itemName: String(r.itemName || '').trim(),
      category: r.category ? String(r.category).trim() : undefined,
      quantity: r.quantity != null && isFinite(Number(r.quantity)) ? Number(r.quantity) : null,
      unit: r.unit ? String(r.unit).trim() : undefined,
      specifications: r.specifications ? String(r.specifications).trim() : undefined,
      requirements: r.requirements ? String(r.requirements).trim() : undefined,
      dependencies: r.dependencies ? String(r.dependencies).trim() : undefined,
      notes: r.notes ? String(r.notes).trim() : undefined,
    }))
    .filter((r: AnalyzedItem) => r.itemName);
}

// Analyze the whole BOQ, batching to stay within model limits.
export async function analyzeBOQ(raw: RawItem[]): Promise<AnalyzedItem[] | null> {
  const provider = aiProvider();
  if (!provider) return null;

  const rows = raw.filter((r) => r.description && r.description.trim());
  if (rows.length === 0) return [];

  const BATCH = 28;
  const out: AnalyzedItem[] = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const user =
      `Raw BOQ line items (analyze and clean these):\n\n` +
      chunk.map((r, idx) =>
        `${i + idx + 1}. [${r.srNo || '-'}] (cat: ${r.category || '-'}) qty: ${r.plannedQty ?? '-'} ${r.unit || ''}\n${r.description.slice(0, 900)}`
      ).join('\n\n');
    try {
      const text = provider === 'groq' ? await callGroq(user) : await callAnthropic(user);
      out.push(...parseItems(text));
    } catch (err) {
      console.error(`[analyzeBOQ] batch ${i} failed:`, (err as Error).message);
      // Continue with other batches rather than failing the whole analysis.
    }
  }
  return out;
}
