// Crystal Group Travel Policy (TA/DA) — the per-day entitlement matrix used to
// auto-fill a travel plan's sanctioned amounts from the traveller's M-Level and
// the destination city, plus the allowed mode/class of travel per grade.
// Source: Employee Handbook — Travel Policy (Doc HRBP/25/072020, v1.4).

// ── Grade → group (I–V). S-1..S-4 = group V ("All Others"). ──────────────────
export type TravelGroup = 'I' | 'II' | 'III' | 'IV' | 'V';
export function travelGroupForMLevel(mLevel?: string | null): TravelGroup {
  const raw = String(mLevel || '').toUpperCase().replace(/\s/g, '');
  // S-levels (S-1..S-4) or anything non-M → All Others (V).
  const m = /M-?(\d+)/.exec(raw);
  if (!m) return 'V';
  const n = Number(m[1]);
  if (n >= 2 && n <= 4) return 'I';
  if (n >= 5 && n <= 9) return 'II';
  if (n >= 10 && n <= 11) return 'III';
  if (n >= 12 && n <= 16) return 'IV';
  return 'V';
}

// ── City → category (A/B/C/D). ───────────────────────────────────────────────
const CITY_A = ['mumbai', 'delhi', 'new delhi', 'kolkata', 'calcutta', 'chennai', 'madras', 'bangalore', 'bengaluru', 'hyderabad', 'pune'];
// B: union of the two policy tables (Ahmedabad, Baroda/Vadodara, Jaipur, Indore,
// Coimbatore, plus Surat & Vizag which the entitlements table also lists as B).
const CITY_B = ['ahmedabad', 'baroda', 'vadodara', 'jaipur', 'indore', 'coimbatore', 'surat', 'vizag', 'visakhapatnam'];
// C: all OTHER state capitals (except any already in A/B). Rest of India = D.
const STATE_CAPITALS_C = [
  'bhopal', 'lucknow', 'patna', 'chandigarh', 'bhubaneswar', 'raipur', 'ranchi', 'dehradun', 'gandhinagar',
  'panaji', 'panjim', 'shimla', 'srinagar', 'jammu', 'thiruvananthapuram', 'trivandrum', 'amaravati', 'vijayawada',
  'itanagar', 'dispur', 'guwahati', 'aizawl', 'imphal', 'shillong', 'kohima', 'agartala', 'gangtok',
  'gandhinagar', 'shimla', 'puducherry', 'pondicherry', 'port blair', 'kavaratti', 'daman', 'silvassa',
];
export type CityCategory = 'A' | 'B' | 'C' | 'D';
export function cityCategory(city?: string | null): CityCategory {
  const c = String(city || '').trim().toLowerCase();
  if (!c) return 'D';
  const hit = (list: string[]) => list.some((k) => c === k || c.includes(k));
  if (hit(CITY_A)) return 'A';
  if (hit(CITY_B)) return 'B';
  if (hit(STATE_CAPITALS_C)) return 'C';
  return 'D';
}

// ── Per-day entitlement (₹) by group. lodging keyed by city category. ─────────
interface Entitlement { lodging: Record<CityCategory, number>; boarding: number; incidental: number; }
export const TRAVEL_ENTITLEMENTS: Record<TravelGroup, Entitlement> = {
  I:   { lodging: { A: 2000, B: 1800, C: 1500, D: 1500 }, boarding: 800, incidental: 200 },
  II:  { lodging: { A: 1500, B: 1200, C: 1200, D: 1100 }, boarding: 500, incidental: 200 },
  III: { lodging: { A: 1200, B: 1000, C: 1100, D: 1100 }, boarding: 400, incidental: 100 },
  IV:  { lodging: { A: 1000, B: 1000, C: 1000, D: 900 },  boarding: 400, incidental: 100 },
  V:   { lodging: { A: 800,  B: 800,  C: 800,  D: 700 },  boarding: 300, incidental: 100 },
};

// ── Allowed mode + class of travel by group. ─────────────────────────────────
// modes = which of the app's Flight / Train / Bus / Taxi buttons are permitted.
interface ModeRule { modes: ('Flight' | 'Train' | 'Bus' | 'Taxi')[]; classText: string; note?: string; }
export const TRAVEL_MODES: Record<TravelGroup, ModeRule> = {
  I:   { modes: ['Flight', 'Train', 'Taxi'], classText: 'Air (Economy); AC-II' },
  II:  { modes: ['Flight', 'Train', 'Taxi'], classText: 'Air (Economy); AC-II', note: "Air needs Director's written approval." },
  III: { modes: ['Train', 'Taxi'],           classText: 'AC-II', note: 'AC Taxi with prior HOD approval.' },
  IV:  { modes: ['Train', 'Taxi', 'Bus'],    classText: 'AC-III', note: 'Shared Taxi / AC Bus / Bus.' },
  V:   { modes: ['Train', 'Bus'],            classText: 'Sleeper' },
};

// Is the chosen mode OUTSIDE the traveller's grade entitlement? Only meaningful
// when the M-Level AND a mode are both known — this mirrors the New-request UI,
// which gates its out-of-policy check on a present M-Level (no M-Level ⇒ no
// restriction). Returns null when the check doesn't apply, so callers can skip
// the warning entirely. Used to flag the approver (email + Approval Form) that
// e.g. Flight was picked by an M-13 (Grade IV, allowed: Train / Taxi / Bus).
export function modeOutsidePolicy(mLevel?: string | null, travelMode?: string | null):
  { outside: boolean; allowed: ('Flight' | 'Train' | 'Bus' | 'Taxi')[]; group: TravelGroup } | null {
  if (!mLevel || !travelMode) return null;
  const group = travelGroupForMLevel(mLevel);
  const allowed = TRAVEL_MODES[group].modes;
  return { outside: !allowed.includes(travelMode as 'Flight' | 'Train' | 'Bus' | 'Taxi'), allowed: [...allowed], group };
}

// One call: everything the travel form needs for a traveller + destination.
export function travelEntitlement(mLevel?: string | null, city?: string | null) {
  const group = travelGroupForMLevel(mLevel);
  const category = cityCategory(city);
  const e = TRAVEL_ENTITLEMENTS[group];
  const mode = TRAVEL_MODES[group];
  return {
    group, category,
    // Per-day amounts mapped to the plan's categories.
    hotel: e.lodging[category],   // Lodging (city-class dependent)
    food: e.boarding,             // Boarding daily allowance
    other: e.incidental,          // Personal incidental
    // travel (local conveyance) has no fixed daily slab in the policy → manual.
    modes: mode.modes, classText: mode.classText, modeNote: mode.note ?? null,
  };
}
