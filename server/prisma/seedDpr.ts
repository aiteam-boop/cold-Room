// One-time import of DPR_Cold_Storage_RoomWise.xlsx into the room-wise DPR
// tables, so the app opens showing exactly what the sheet showed.
//
//   npx tsx prisma/seedDpr.ts <projectId>
//
// Reads docs/dpr-sheet/dpr-sheet-snapshot.json (produced by
// scripts/_tmp_dprDump.ts) rather than hard-coded values, so re-pulling the
// workbook and re-running this stays honest.
//
// Two rows in the source cannot be imported verbatim; both are reported loudly:
//
//  1. Daily_Entry row 9 — "Freezer / Refrigeration / Refrigeration Piping / 10".
//     Refrigeration is plant-wide, so no room sheet and no Common_Works SUMIFS
//     ever picks this up: in the sheet those 10 Rmt land nowhere (PRD §4 bug B4).
//     We re-home it onto Common / Plant-wide and record the original room in the
//     remarks, rather than dropping it.
//
//  2. 'Ambient Room'!I8 — Cumulative Qty Done for Back Wall reads 200, but the
//     cell HAS NO FORMULA: someone typed over the SUMIFS. The Daily_Entry log
//     only contains 55 Sq.m for that activity (PRD §4 bug B11). Typing over the
//     cell is a real, intentional workflow — a cumulative known from site that
//     was never logged day-by-day — so we keep the number and import the missing
//     145 Sq.m as an ADJUSTMENT entry. Same total, but now with an author, a date
//     and a reason. Any cell in column I whose formula was overwritten is
//     detected and imported this way, not just this one.

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  COMMON_ACTIVITIES,
  COMMON_BUCKET,
  DPR_ROOMS,
  ROOM_ACTIVITIES,
  isValidCombo,
} from '../src/lib/dprCatalog';

const prisma = new PrismaClient();
const SNAPSHOT = path.resolve(__dirname, '../../docs/dpr-sheet/dpr-sheet-snapshot.json');

// Real projects already carry ProjectZone rows drawn from the floor plan, under
// their own names. The sheet uses shorter ones. Attaching the room-wise scope to
// the EXISTING zone (rather than creating "Ambient" next to "Ambient Room")
// keeps the 2D/3D floor plan and the DPR pointing at the same room.
//
// Matching order: exact zoneName → alias → create. Nothing is ever renamed or
// deleted, and a zone that matches keeps its coordinates and sortOrder.
const ROOM_ALIASES: Record<string, string[]> = {
  Ambient: ['Ambient Room'],
  Chiller: ['Chiller Room'],
  Freezer: ['Freezer Room'],
  Blast: ['Blast Freezer', 'Blast Room', 'Blast Freezer Room'],
  FNV: ['F&V Cold Room', 'FNV Room', 'F&V Room'],
  'Corridor & Warm Room': ['Corridor', 'Warm Room'],
  'Ante Room': ['Ante'],
};

/** Find the project's existing zone for a catalogue room, or null. */
async function findZone(projectId: string, room: string, isCommon: boolean) {
  const candidates = isCommon ? [COMMON_BUCKET] : [room, ...(ROOM_ALIASES[room] ?? [])];
  for (const name of candidates) {
    const z = await prisma.projectZone.findFirst({ where: { projectId, zoneName: name } });
    if (z) return { zone: z, matchedBy: name };
  }
  return null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "26-Jun-26" → 2026-06-26T00:00:00Z. Returns null for blanks / junk. */
function parseSheetDate(v: unknown): Date | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(s);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return null;
  const yr = Number(m[3]);
  return new Date(Date.UTC(yr < 100 ? 2000 + yr : yr, mon, day));
}

const num = (v: unknown): number | null => {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s || null;
};

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error('Usage: tsx prisma/seedDpr.ts <projectId>');

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (!project) throw new Error(`Project ${projectId} not found`);

  const importer = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
  if (!importer) throw new Error('No ADMIN user to attribute the imported entries to');

  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const sheets = snap.sheets as Record<string, { rows: string[][]; formulas: Record<string, string> }>;
  console.log(`Project: ${project.name}`);
  console.log(`Source : ${snap.source?.name} (pulled ${snap.pulledAt})\n`);

  // ── 1. Rooms + Common bucket ───────────────────────────────────────────────
  const zoneOf = new Map<string, string>(); // room name → zoneId
  const wanted = [...DPR_ROOMS.map((r) => ({ name: r as string, common: false })), { name: COMMON_BUCKET, common: true }];

  for (const [i, w] of wanted.entries()) {
    const hit = await findZone(projectId, w.name, w.common);
    if (hit) {
      // Reuse the project's own zone. Only flip isCommonBucket when it is wrong —
      // never touch zoneName, coordinates or sortOrder on an existing room.
      const zone = hit.zone.isCommonBucket === w.common
        ? hit.zone
        : await prisma.projectZone.update({ where: { id: hit.zone.id }, data: { isCommonBucket: w.common } });
      zoneOf.set(w.name, zone.id);
      console.log(`  reuse  ${w.name.padEnd(22)} → existing zone "${hit.matchedBy}"`);
    } else {
      const zone = await prisma.projectZone.create({
        data: { projectId, zoneName: w.name, isCommonBucket: w.common, sortOrder: 100 + i },
      });
      zoneOf.set(w.name, zone.id);
      console.log(`  create ${w.name.padEnd(22)} → new zone (no matching room on the floor plan)`);
    }
  }
  console.log(`rooms          : ${zoneOf.size} (7 rooms + ${COMMON_BUCKET})`);

  // ── 2. The 118 scope rows, with target qty + planned dates from the sheet ──
  // Room sheets: header on row index 2, data from row 3. Common_Works: header on
  // row 1, data from row 2. Columns are identical:
  //   0 S.No | 1 Category | 2 Item | 3 UOM | 4 Target | 5 PlStart | 6 PlFinish
  //   7 PlHandover | 8 Cum | 9 % | 10 Balance | 11 LastUpd | 12 Status | 13 Remarks
  let scopeCount = 0;
  let targetsFound = 0;

  for (const w of wanted) {
    const zoneId = zoneOf.get(w.name)!;
    const catalog = w.common ? COMMON_ACTIVITIES : ROOM_ACTIVITIES;
    const tabName = w.common ? 'Common_Works' : `${w.name} Room`;
    const tab = sheets[tabName] ?? sheets[w.name];
    const dataRows = tab ? tab.rows.slice(w.common ? 2 : 3) : [];

    for (const [i, c] of catalog.entries()) {
      const row = dataRows.find((r) => str(r[2]) === c.activity);
      const targetQty = row ? num(row[4]) : null;
      if (targetQty != null) targetsFound++;

      await prisma.roomScopeItem.upsert({
        where: { projectId_zoneId_activity: { projectId, zoneId, activity: c.activity } },
        create: {
          projectId, zoneId, category: c.category, activity: c.activity, uom: c.uom, sortOrder: i,
          targetQty, targetSource: targetQty != null ? 'DRAWING' : null,
          plannedStart: row ? parseSheetDate(row[5]) : null,
          plannedFinish: row ? parseSheetDate(row[6]) : null,
          plannedHandover: row ? parseSheetDate(row[7]) : null,
          remarks: row ? str(row[13]) : null,
        },
        update: {
          targetQty, targetSource: targetQty != null ? 'DRAWING' : null,
          plannedStart: row ? parseSheetDate(row[5]) : null,
          plannedFinish: row ? parseSheetDate(row[6]) : null,
          plannedHandover: row ? parseSheetDate(row[7]) : null,
        },
      });
      scopeCount++;
    }
  }
  console.log(`scope items    : ${scopeCount} (${targetsFound} with a Target Qty, ${scopeCount - targetsFound} blank → PRD bug B1)`);

  // ── 3. Daily_Entry log ─────────────────────────────────────────────────────
  // Columns: 0 Date | 1 Room | 2 Category | 3 Item | 4 UOM | 5 Qty | 6 Team | 7 Remarks
  const dailyRows = (sheets['Daily_Entry']?.rows ?? []).slice(3);
  await prisma.dPREntry.deleteMany({ where: { projectId } }); // idempotent re-import

  let imported = 0;
  const rehomed: string[] = [];

  for (const r of dailyRows) {
    const date = parseSheetDate(r[0]);
    const room = str(r[1]);
    const category = str(r[2]);
    const activity = str(r[3]);
    const qty = num(r[5]);
    if (!date || !room || !category || !activity || qty == null || qty <= 0) continue;

    // Bug B4: the sheet's flat Item dropdown allows Freezer + Refrigeration.
    // Nothing sums it. Re-home to the plant-wide bucket instead of losing it.
    let targetRoom = room;
    let note = str(r[7]);
    if (!isValidCombo(room, category, activity)) {
      targetRoom = COMMON_BUCKET;
      note = [note, `Imported from sheet with Room="${room}" — ${category} is plant-wide work, so the sheet's SUMIFS never counted it (bug B4). Re-homed on import.`]
        .filter(Boolean).join(' | ');
      rehomed.push(`${r[0]} ${room}/${activity} (${qty})`);
    }

    const zoneId = zoneOf.get(targetRoom);
    if (!zoneId) { console.warn(`  ! unknown room "${targetRoom}" — skipped`); continue; }

    const scope = await prisma.roomScopeItem.findUnique({
      where: { projectId_zoneId_activity: { projectId, zoneId, activity } },
    });
    if (!scope) { console.warn(`  ! no scope row for ${targetRoom}/${activity} — skipped`); continue; }

    await prisma.dPREntry.create({
      data: {
        projectId, roomScopeItemId: scope.id, date, qtyDoneToday: qty,
        labourTeam: str(r[6]), remarks: note, submittedById: importer.id, status: 'APPROVED',
      },
    });
    imported++;
  }
  console.log(`daily entries  : ${imported} imported`);
  for (const x of rehomed) console.log(`  ↳ re-homed to "${COMMON_BUCKET}": ${x}`);

  // ── 3b. Overtyped cumulative cells → ADJUSTMENT entries (bug B11) ──────────
  // Column I should be a SUMIFS. Where the formula is gone, someone typed the
  // running total in by hand. Keep their number; import the gap as an auditable
  // adjustment so cumulative still equals the sum of its entries.
  let adjustments = 0;
  for (const w of wanted) {
    const zoneId = zoneOf.get(w.name)!;
    const catalog = w.common ? COMMON_ACTIVITIES : ROOM_ACTIVITIES;
    const tabName = w.common ? 'Common_Works' : `${w.name} Room`;
    const tab = sheets[tabName];
    if (!tab) continue;
    const firstExcelRow = w.common ? 5 : 7; // Common_Works data starts at row 5, room sheets at row 7
    const dataRows = tab.rows.slice(w.common ? 2 : 3);

    for (const [i, c] of catalog.entries()) {
      const cell = `I${firstExcelRow + i}`;
      const hadFormula = !!tab.formulas[cell];
      const row = dataRows.find((r) => str(r[2]) === c.activity);
      const sheetCum = row ? num(row[8]) : null;
      if (hadFormula || sheetCum == null || sheetCum <= 0) continue;

      const scope = await prisma.roomScopeItem.findUnique({
        where: { projectId_zoneId_activity: { projectId, zoneId, activity: c.activity } },
      });
      if (!scope) continue;

      const logged = await prisma.dPREntry.aggregate({
        where: { roomScopeItemId: scope.id, status: 'APPROVED' },
        _sum: { qtyDoneToday: true },
      });
      const delta = Math.round((sheetCum - (logged._sum.qtyDoneToday ?? 0)) * 10_000) / 10_000;
      if (delta <= 0) continue;

      const lastEntry = await prisma.dPREntry.findFirst({
        where: { roomScopeItemId: scope.id }, orderBy: { date: 'desc' }, select: { date: true },
      });

      await prisma.dPREntry.create({
        data: {
          projectId, roomScopeItemId: scope.id, kind: 'OPENING',
          date: lastEntry?.date ?? new Date(),
          qtyDoneToday: delta,
          remarks:
            `Imported from '${tabName}'!${cell}, which read ${sheetCum} ${c.uom} with the SUMIFS formula overwritten. ` +
            `The Daily_Entry log accounted for ${(logged._sum.qtyDoneToday ?? 0)} ${c.uom}; the remaining ${delta} ${c.uom} ` +
            `is carried in as an opening balance (PRD §4 bug B11).`,
          submittedById: importer.id, status: 'APPROVED',
        },
      });
      adjustments++;
      console.log(`  ↳ opening balance: ${w.name}/${c.activity} +${delta} ${c.uom} (sheet ${cell} was overtyped to ${sheetCum})`);
    }
  }
  console.log(`adjustments    : ${adjustments}`);

  // ── 4. Room planned handover dates (Room_Handover!F) ───────────────────────
  for (const room of DPR_ROOMS) {
    const zoneId = zoneOf.get(room)!;
    const earliest = await prisma.roomScopeItem.findFirst({
      where: { projectId, zoneId, plannedHandover: { not: null } },
      orderBy: { plannedHandover: 'asc' },
      select: { plannedHandover: true },
    });
    if (earliest?.plannedHandover) {
      await prisma.projectZone.update({ where: { id: zoneId }, data: { plannedHandoverDate: earliest.plannedHandover } });
    }
  }

  // NOTE: we deliberately do NOT import an actualHandoverDate. The sheet derives
  // Ambient's as 07-Jul-26 (delay −3 days) from the last completed activity,
  // while the room is 30% built (bug B3). Handover is now an explicit sign-off.

  // ── 5. Milestones ──────────────────────────────────────────────────────────
  // Columns: 0 Name | 1 Committed (Vendor) | 2 FKI text | 3 Actual | 4 Delay
  // The FKI column holds "7th", "10th"… — text, never a date, which is why the
  // sheet's Delay formula ignores it entirely (bug B8). We resolve the ordinal
  // against the committed date's month/year and keep the raw text in remarks.
  const msRows = (sheets['Milestones']?.rows ?? []).slice(2);
  await prisma.projectMilestone.deleteMany({ where: { projectId } });

  let msCount = 0;
  for (const [i, r] of msRows.entries()) {
    const name = str(r[0]);
    if (!name) continue;
    const committed = parseSheetDate(r[1]);
    const fkiRaw = str(r[2]);

    let fki: Date | null = null;
    const ord = fkiRaw && /^(\d{1,2})(st|nd|rd|th)$/i.exec(fkiRaw);
    if (ord && committed) {
      fki = new Date(Date.UTC(committed.getUTCFullYear(), committed.getUTCMonth(), Number(ord[1])));
    } else if (fkiRaw) {
      fki = parseSheetDate(fkiRaw);
    }

    await prisma.projectMilestone.create({
      data: {
        projectId, name, sortOrder: i,
        zoneId: zoneOf.get(name) ?? null,
        committedDateVendor: committed,
        fkiFreezeDate: fki,
        actualDate: parseSheetDate(r[3]),
        remarks: fkiRaw && ord ? `FKI recorded in the sheet as "${fkiRaw}" (text) — resolved to ${fki?.toISOString().slice(0, 10)}. Confirm.` : null,
      },
    });
    msCount++;
  }
  console.log(`milestones     : ${msCount}`);

  console.log('\nDone. Open the project → DPR (Room-wise).');
  console.log('Sheet mode reproduces the workbook; Corrected mode applies PRD §4.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
