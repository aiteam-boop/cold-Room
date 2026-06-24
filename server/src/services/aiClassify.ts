// ── AI room classification (PRD §5.1.2) ─────────────────────────────────────
// Given the raw text labels pulled from a drawing, ask the AI which ones are
// real rooms/zones and classify each into a cold-room category + room type,
// extracting the stated area when present. Provider auto-detected (Groq first).

import { aiProvider } from './boqParser';

export interface ClassifiedRoom {
  matchText: string;   // the original label text (so we can recover its x,y)
  roomName: string;    // cleaned, human-friendly name
  category: string;    // best-fit cold-room category
  roomType: string;    // e.g. "Freezer (-25C)"
  areaSqFt: number | null;
}

const SYSTEM =
  'You analyze text labels extracted from a cold-room / cold-storage architectural floor plan. ' +
  'From the given labels, return ONLY the ones that name an actual ROOM, ZONE or AREA ' +
  '(e.g. Blast Freezer, Freezer Room, Chiller, Ambient, Anteroom, Cold Room, F&V Cold Room, Dock, ' +
  'Electrical Room, Staging Area). EXCLUDE pallet counts, equipment notes, dimensions, "SLOPE", ' +
  '"PROVISION", socket/symbol callouts and generic notes. ' +
  'Return strict JSON: {"rooms":[{"matchText":string,"roomName":string,"category":string,"roomType":string,"areaSqFt":number|null}]}. ' +
  'matchText MUST be copied verbatim from the input label so it can be located. ' +
  'roomName is a short clean name. areaSqFt = the area number if the label mentions one (sq.ft/sqft), else null.';

async function groqChat(userContent: string): Promise<string> {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

async function anthropicChat(userContent: string): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const msg = await client.messages.create({ model, max_tokens: 4000, system: SYSTEM, messages: [{ role: 'user', content: userContent }] });
  return msg.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}

// ── Drawing-level classification ────────────────────────────────────────────
// Given each uploaded drawing (filename + optional text hints), determine which
// building part/discipline it covers and which rooms it relates to.

export interface DrawingClassification {
  id: string;
  part: string;        // e.g. "Floor Layout", "Ceiling", "Doors & Panels", "Section/Elevation"
  discipline: string;  // e.g. "Architectural", "Refrigeration", "Electrical", "Structural"
  rooms: string[];     // rooms/zones this diagram covers (specific when text available)
  floors: number | null; // building levels shown (sections/elevations); null if not applicable
  summary: string;     // one-line description
}

const DRAWING_SYSTEM =
  'You classify construction drawings for a cold-storage facility. For EACH drawing given (id + filename + extracted text content), determine: ' +
  'part (what the drawing shows, e.g. "Floor Layout", "Ceiling & Floor", "Doors & Panels", "Fabrication Layout", "Section/Elevation", "Refrigeration Layout", "Electrical Layout"), ' +
  'discipline (Architectural | Refrigeration | Electrical | Structural | Mechanical), ' +
  'rooms (array of the SPECIFIC rooms/zones named in the drawing text — match to the provided room list; only use ["All"] if it truly spans the whole facility with no specific rooms), ' +
  'floors (ONLY for a SECTION or ELEVATION: the number of distinct stacked building STOREYS/LEVELS shown — Ground, First, Mezzanine. A wall/panel/ceiling-to-floor detail of a single-height room is 1 floor. Report >1 ONLY if multiple occupiable levels are clearly stacked vertically. Otherwise null), ' +
  'and a concise one-line summary of what the drawing contains. ' +
  'Return strict JSON: {"drawings":[{"id":string,"part":string,"discipline":string,"rooms":[string],"floors":number|null,"summary":string}]}. ' +
  'Echo each id exactly.';

export async function classifyDrawings(
  drawings: { id: string; fileName: string; hint?: string }[],
  roomList: string[]
): Promise<DrawingClassification[] | null> {
  const provider = aiProvider();
  if (!provider) return null;
  const user =
    `Known rooms/zones: ${roomList.join(', ') || '(unknown)'}\n\nDrawings to classify:\n` +
    drawings.map((d) => `- id=${d.id} | file="${d.fileName}"${d.hint ? ` | text: ${d.hint.slice(0, 400)}` : ''}`).join('\n');
  try {
    const text = provider === 'groq'
      ? await groqChatWith(DRAWING_SYSTEM, user)
      : await anthropicChatWith(DRAWING_SYSTEM, user);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return (parsed.drawings || []).map((d: any) => ({
      id: String(d.id || ''),
      part: String(d.part || 'Drawing').trim(),
      discipline: String(d.discipline || 'Architectural').trim(),
      rooms: Array.isArray(d.rooms) ? d.rooms.map((r: any) => String(r)).filter(Boolean) : [],
      floors: d.floors != null && isFinite(Number(d.floors)) ? Number(d.floors) : null,
      summary: String(d.summary || '').trim(),
    })).filter((d: DrawingClassification) => d.id);
  } catch (err) {
    console.error(`[classifyDrawings] ${provider} failed:`, err);
    return null;
  }
}

// ── Per-room detail + facility extraction from raw drawing text ─────────────

export interface RoomDetails {
  name: string;
  areaSqFt: number | null;
  temperature: string | null;       // e.g. "-25C" inferred from room type
  palletCapacity: { type: string; count: number }[];
  equipment: { type: string; count: number }[];
  notes: string[];
}
export interface FacilitySummary {
  floors: number;
  floorsBasis: string;
  totalAreaSqFt: number | null;
  roomCount: number;
  summary: string;
}

const DETAIL_SYSTEM =
  'You extract structured engineering details from text labels on a cold-storage facility floor plan. ' +
  'You are given a list of ROOMS, each with the raw text labels found inside it, plus the full label list for facility context. ' +
  'For EACH room return: name, areaSqFt (number from "area NNN sq.ft" text, else null), temperature (from room type if obvious e.g. Blast Freezer=-30C, Freezer=-25C, Chiller=2C, Ambient=18C, else null), ' +
  'palletCapacity (array of {type,count} parsed from labels like "OB PALLETS-44", "IB PALLETS-20", "EMPTY TOTE -24", "RIWIT-10"), ' +
  'equipment (array of {type,count} from labels like "SAR-32nos", "TYPE G-3 nos", "IB table 1 nos", "DEO/Super Visor 1 nos"), and notes (other meaningful short labels). ' +
  'Also return facility: floors (count of building levels — look for FFL/LEVEL/GROUND FLOOR/FIRST FLOOR/storey text; if none found assume 1), floorsBasis (how you decided), totalAreaSqFt (sum of room areas or null), roomCount, and a 2-3 sentence summary. ' +
  'Return strict JSON: {"rooms":[{"name","areaSqFt","temperature","palletCapacity":[{"type","count"}],"equipment":[{"type","count"}],"notes":[]}],"facility":{"floors","floorsBasis","totalAreaSqFt","roomCount","summary"}}.';

export async function extractRoomDetails(
  rooms: { name: string; labels: string[] }[],
  allLabels: string[]
): Promise<{ rooms: RoomDetails[]; facility: FacilitySummary } | null> {
  const provider = aiProvider();
  if (!provider) return null;
  const user =
    `ROOMS and their inside-labels:\n` +
    rooms.map((r) => `### ${r.name}\n${r.labels.slice(0, 40).join(' | ')}`).join('\n') +
    `\n\nFULL label list (facility context):\n${[...new Set(allLabels)].slice(0, 250).join(' | ')}`;
  try {
    const text = provider === 'groq' ? await groqChatWith(DETAIL_SYSTEM, user) : await anthropicChatWith(DETAIL_SYSTEM, user);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const num = (v: any) => (v != null && isFinite(Number(v)) ? Number(v) : null);
    const roomsOut: RoomDetails[] = (parsed.rooms || []).map((r: any) => ({
      name: String(r.name || '').trim(),
      areaSqFt: num(r.areaSqFt),
      temperature: r.temperature ? String(r.temperature) : null,
      palletCapacity: Array.isArray(r.palletCapacity) ? r.palletCapacity.map((p: any) => ({ type: String(p.type || ''), count: Number(p.count) || 0 })).filter((p: any) => p.type) : [],
      equipment: Array.isArray(r.equipment) ? r.equipment.map((p: any) => ({ type: String(p.type || ''), count: Number(p.count) || 0 })).filter((p: any) => p.type) : [],
      notes: Array.isArray(r.notes) ? r.notes.map((n: any) => String(n)).filter(Boolean).slice(0, 8) : [],
    }));
    const f = parsed.facility || {};
    const facility: FacilitySummary = {
      floors: Number(f.floors) || 1,
      floorsBasis: String(f.floorsBasis || 'No multi-level markers found — assumed single storey.'),
      totalAreaSqFt: num(f.totalAreaSqFt),
      roomCount: Number(f.roomCount) || roomsOut.length,
      summary: String(f.summary || ''),
    };
    return { rooms: roomsOut, facility };
  } catch (err) {
    console.error(`[extractRoomDetails] ${provider} failed:`, err);
    return null;
  }
}

// Generic chat helpers (system + user) reused by the drawing classifier.
async function groqChatWith(system: string, user: string): Promise<string> {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
async function anthropicChatWith(system: string, user: string): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const msg = await client.messages.create({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] });
  return msg.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('');
}

// Returns classified rooms, or null when AI is disabled / fails.
export async function classifyRooms(labels: string[], boqCategories: string[]): Promise<ClassifiedRoom[] | null> {
  const provider = aiProvider();
  if (!provider) return null;

  // Dedup + cap to keep the prompt tight.
  const unique = [...new Set(labels.map((l) => l.trim()).filter(Boolean))].slice(0, 200);
  const user =
    `BOQ categories available for mapping (pick the closest for each room's "category"):\n${boqCategories.join(', ') || '(none)'}\n\n` +
    `Labels extracted from the drawing:\n${unique.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;

  try {
    const text = provider === 'groq' ? await groqChat(user) : await anthropicChat(user);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const rooms: ClassifiedRoom[] = (parsed.rooms || [])
      .map((r: any) => ({
        matchText: String(r.matchText || '').trim(),
        roomName: String(r.roomName || r.matchText || '').trim(),
        category: String(r.category || '').trim(),
        roomType: String(r.roomType || '').trim(),
        areaSqFt: r.areaSqFt != null && isFinite(Number(r.areaSqFt)) ? Number(r.areaSqFt) : null,
      }))
      .filter((r: ClassifiedRoom) => r.matchText && r.roomName);
    return rooms;
  } catch (err) {
    console.error(`[classifyRooms] ${provider} failed:`, err);
    return null;
  }
}
