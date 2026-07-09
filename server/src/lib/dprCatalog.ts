// Room-wise DPR master data — a 1:1 transcription of DPR_Cold_Storage_RoomWise.xlsx.
// (See docs/dpr-sheet/ for the archived workbook and its decoded formulas, and
// CRMCTS_DPR_RoomWise_PRD_v1.0.md §1.2 for how this was derived.)
//
// The sheet hard-codes 7 physical rooms × 15 activities + one "Common /
// Plant-wide" bucket × 13 activities = 118 activities, which is exactly what
// Dashboard!C7 counts. We reproduce that catalogue verbatim so the app's numbers
// can be checked against the sheet cell-for-cell.
//
// NOTE — this taxonomy is *execution* work (how the job is done on site). It is
// deliberately separate from BOQ_CATEGORIES in enums.ts, which is *procurement*
// work (what gets bought). Do not merge them.

export const DPR_ROOMS = [
  'Ambient',
  'Chiller',
  'Freezer',
  'Blast',
  'FNV',
  'Corridor & Warm Room',
  'Ante Room',
] as const;
export type DprRoom = (typeof DPR_ROOMS)[number];

/** The pseudo-room that holds plant-wide work. Matches the sheet's dropdown value. */
export const COMMON_BUCKET = 'Common / Plant-wide';

// Categories that live inside a physical room (the 3 columns Room_Handover rolls up).
export const ROOM_CATEGORIES = ['PUF Panel', 'Door Work', 'Floor & Racking'] as const;
// Categories that only ever live in the Common / Plant-wide bucket.
export const COMMON_CATEGORIES = ['Refrigeration', 'Electrical'] as const;

export const EXECUTION_CATEGORIES = [...ROOM_CATEGORIES, ...COMMON_CATEGORIES] as const;
export type ExecutionCategory = (typeof EXECUTION_CATEGORIES)[number];

export interface CatalogActivity {
  category: ExecutionCategory;
  activity: string;
  uom: string;
}

/** The 15 activities every physical room gets, in sheet row order (rows 7–21). */
export const ROOM_ACTIVITIES: CatalogActivity[] = [
  { category: 'PUF Panel', activity: 'Front Wall', uom: 'Sq.m' },
  { category: 'PUF Panel', activity: 'Back Wall', uom: 'Sq.m' },
  { category: 'PUF Panel', activity: 'Left Side Wall', uom: 'Sq.m' },
  { category: 'PUF Panel', activity: 'Right Side Wall', uom: 'Sq.m' },
  { category: 'PUF Panel', activity: 'Top Ceiling', uom: 'Sq.m' },
  { category: 'PUF Panel', activity: 'PUF Slab (Floor)', uom: 'Sq.m' },
  { category: 'PUF Panel', activity: 'Door Cutting', uom: 'Nos' },
  { category: 'PUF Panel', activity: 'Silicon Filling - Inside', uom: 'Rmt' },
  { category: 'PUF Panel', activity: 'Silicon Filling - Outside', uom: 'Rmt' },
  { category: 'Door Work', activity: 'Door Installation', uom: 'Nos' },
  { category: 'Door Work', activity: 'Falcon Sensor Installation', uom: 'Nos' },
  { category: 'Door Work', activity: 'Air Curtain Installation', uom: 'Nos' },
  { category: 'Door Work', activity: 'PVC Curtain Installation', uom: 'Nos' },
  { category: 'Door Work', activity: 'Door Alarm & Hooter Installation', uom: 'Nos' },
  { category: 'Floor & Racking', activity: 'Floor & Racking Work', uom: 'Sq.m' },
];

/** The 13 plant-wide activities, in sheet row order (Common_Works rows 5–17). */
export const COMMON_ACTIVITIES: CatalogActivity[] = [
  { category: 'Refrigeration', activity: 'ODU Hanging', uom: 'Nos' },
  { category: 'Refrigeration', activity: 'ODU MS Structure', uom: 'Nos' },
  { category: 'Refrigeration', activity: 'Refrigeration Piping', uom: 'Rmt' },
  { category: 'Refrigeration', activity: 'GI Cable', uom: 'Rmt' },
  { category: 'Refrigeration', activity: 'Drain Piping', uom: 'Rmt' },
  { category: 'Refrigeration', activity: 'IDU Hanging', uom: 'Nos' },
  { category: 'Refrigeration', activity: 'IDU Connection', uom: 'Nos' },
  { category: 'Refrigeration', activity: 'Control Panel Installation', uom: 'Nos' },
  { category: 'Refrigeration', activity: 'Nitrogen Holding', uom: 'Job' },
  { category: 'Refrigeration', activity: 'Vacuum Pressure Test', uom: 'Job' },
  { category: 'Refrigeration', activity: 'Machine Start', uom: 'Job' },
  { category: 'Electrical', activity: 'Copper FRLS Cable Laying', uom: 'Rmt' },
  { category: 'Electrical', activity: 'Final Handover to Client', uom: 'Job' },
];

export const TOTAL_ACTIVITIES = DPR_ROOMS.length * ROOM_ACTIVITIES.length + COMMON_ACTIVITIES.length; // 118

// Real projects already carry ProjectZone rows drawn from the floor plan, named
// the way the drawing names them. The sheet uses shorter names. When seeding the
// room-wise scope we must attach it to the EXISTING zone rather than create
// "Ambient" alongside "Ambient Room" — otherwise the 2D/3D floor plan and the
// DPR end up pointing at two different objects for the same physical room.
const ROOM_ALIASES: Record<string, string[]> = {
  Ambient: ['Ambient Room'],
  Chiller: ['Chiller Room'],
  Freezer: ['Freezer Room'],
  Blast: ['Blast Freezer', 'Blast Room', 'Blast Freezer Room'],
  FNV: ['F&V Cold Room', 'FNV Room', 'F&V Room'],
  'Corridor & Warm Room': ['Corridor', 'Warm Room'],
  'Ante Room': ['Ante'],
};

/**
 * Zone names to look for, most-preferred first, when resolving a catalogue room
 * against a project's existing zones. Nothing is ever renamed — we adopt the
 * project's name for the room.
 */
export function zoneNameCandidates(room: string, isCommon = false): string[] {
  if (isCommon) return [COMMON_BUCKET];
  return [room, ...(ROOM_ALIASES[room] ?? [])];
}

/** Activities valid for a given room. `null`/COMMON_BUCKET → the plant-wide list. */
export function activitiesFor(room: string | null): CatalogActivity[] {
  return !room || room === COMMON_BUCKET ? COMMON_ACTIVITIES : ROOM_ACTIVITIES;
}

/**
 * Is (room, category, activity) a legal combination?
 *
 * The sheet does NOT enforce this — its Item dropdown is one flat list of all
 * 28 activities, so "Freezer + Refrigeration + Refrigeration Piping" is
 * selectable, and the 10 Rmt logged against it on 14-Jun-26 land in no tab at
 * all. (PRD §4 bug B4 — silent data loss.) We reject such rows at write time.
 */
export function isValidCombo(room: string | null, category: string, activity: string): boolean {
  return activitiesFor(room).some((a) => a.category === category && a.activity === activity);
}

/** The UOM is a property of the scope row, never typed by the daily-entry user (bug B5). */
export function uomFor(room: string | null, activity: string): string | null {
  return activitiesFor(room).find((a) => a.activity === activity)?.uom ?? null;
}

/** The 4-way status thresholds used by both the room sheets (I4) and Room_Handover (I). */
export function handoverStatus(pct: number): 'Ready for Handover' | 'Near Completion' | 'In Progress' | 'Not Started' {
  if (pct >= 1) return 'Ready for Handover';
  if (pct >= 0.75) return 'Near Completion';
  if (pct > 0) return 'In Progress';
  return 'Not Started';
}

/** Per-activity status, mirroring the room sheets' column M. */
export function activityStatus(cumQty: number, targetQty: number | null): 'Completed' | 'In Progress' | 'Not Started' {
  if (cumQty === 0) return 'Not Started';
  if (targetQty != null && targetQty > 0 && cumQty >= targetQty) return 'Completed';
  return 'In Progress';
}
