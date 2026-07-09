// Room-wise DPR calculation engine.
//
// Two modes, both computed from the same rows:
//
//   'sheet'     — reproduces DPR_Cold_Storage_RoomWise.xlsx formula-for-formula,
//                 bugs included, so the app's numbers can be checked against the
//                 archived workbook cell-for-cell. Every unsound number carries a
//                 `warnings[]` entry explaining why it is unsound.
//
//   'corrected' — the calculation the PRD argues for (§4, §5.3): blank targets
//                 count as 0%, percentages are weighted and capped, and the
//                 handover date is an explicitly recorded event.
//
// The two differ substantially. On the archived data, 'sheet' reports the
// project at 89% and 'corrected' at ~1.5% — because only 2 of the 118 activities
// have a target quantity, and Excel's AVERAGE() silently skips the other 116.
//
// Cumulative quantity is always SUM(qtyDoneToday) over APPROVED entries — the
// direct analogue of the sheet's SUMIFS(Daily_Entry.F, room, activity).

import { prisma } from '../lib/prisma';
import {
  COMMON_CATEGORIES,
  ROOM_CATEGORIES,
  TOTAL_ACTIVITIES,
  activityStatus,
  handoverStatus,
} from '../lib/dprCatalog';

export type DprMode = 'sheet' | 'corrected';

const MS_DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / MS_DAY);
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export interface DprActivityRow {
  id: string;
  category: string;
  activity: string;
  uom: string;
  targetQty: number | null;
  weight: number;
  plannedStart: Date | null;
  plannedFinish: Date | null;
  plannedHandover: Date | null;
  cumQty: number;
  /** null renders as a blank cell — only ever null in 'sheet' mode. */
  pctComplete: number | null;
  balanceQty: number | null;
  lastUpdated: Date | null;
  status: string;
  remarks: string | null;
  /** True when no target has been supplied by the drawing team yet. */
  targetMissing: boolean;
  /** Quantity that came from OPENING/ADJUSTMENT entries rather than daily work. */
  adjustedQty: number;
}

export interface DprRoomRollup {
  zoneId: string;
  roomName: string;
  isCommonBucket: boolean;
  activities: DprActivityRow[];
  /** Per-category %, keyed by category name. */
  categoryPct: Record<string, number>;
  overallPct: number;
  plannedHandoverDate: Date | null;
  actualHandoverDate: Date | null;
  delayDays: number | null;
  handoverStatus: string;
  lastUpdated: Date | null;
  /** Days since the most recent entry anywhere in this room (bug B10). */
  staleDays: number | null;
  targetMissingCount: number;
  activityCount: number;
}

export interface DprSummary {
  mode: DprMode;
  rooms: DprRoomRollup[];
  common: DprRoomRollup | null;
  overallPct: number;
  totalActivities: number;
  expectedActivities: number;
  roomsReady: number;
  totalRooms: number;
  plantWide: { category: string; pct: number; lastUpdated: Date | null; status: string }[];
  targetMissingCount: number;
  /** Activities that actually contributed to `overallPct`. */
  activitiesCounted: number;
  warnings: DprWarning[];
}

export interface DprWarning {
  code: string;
  severity: 'high' | 'medium' | 'low';
  /** The PRD §4 bug id this corresponds to, when applicable. */
  bug?: string;
  message: string;
}

// ── Mean helpers ─────────────────────────────────────────────────────────────
/** Excel AVERAGE(): skips blanks entirely. Returns null when nothing is left. */
const excelAverage = (xs: (number | null)[]): number | null => {
  const vals = xs.filter((x): x is number => x != null);
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
};
/** Excel IFERROR(AVERAGE(...), 0). */
const excelAverage0 = (xs: (number | null)[]): number => excelAverage(xs) ?? 0;

/** Σ(pct × weight) / Σ(weight). Blank targets contribute 0%, not nothing. */
const weightedMean = (rows: { pctComplete: number | null; weight: number }[]): number => {
  const totalW = rows.reduce((s, r) => s + r.weight, 0);
  if (totalW <= 0) return 0;
  return rows.reduce((s, r) => s + (r.pctComplete ?? 0) * r.weight, 0) / totalW;
};

// ── Core ─────────────────────────────────────────────────────────────────────

export async function buildDprSummary(
  projectId: string,
  mode: DprMode = 'sheet',
  now = new Date(),
): Promise<DprSummary> {
  const [zones, scope, entries] = await Promise.all([
    prisma.projectZone.findMany({ where: { projectId }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.roomScopeItem.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } }),
    prisma.dPREntry.groupBy({
      by: ['roomScopeItemId', 'kind'],
      where: { projectId, status: 'APPROVED' },
      _sum: { qtyDoneToday: true },
      _max: { date: true },
    }),
  ]);

  // Cumulative = every APPROVED entry, whatever its kind — the analogue of the
  // sheet's SUMIFS. `adj` isolates the part that did NOT come from daily work
  // (the auditable replacement for typing over the formula — bug B11).
  const agg = new Map<string, { cum: number; adj: number; last: Date | null }>();
  for (const e of entries) {
    const prev = agg.get(e.roomScopeItemId) ?? { cum: 0, adj: 0, last: null as Date | null };
    const qty = e._sum.qtyDoneToday ?? 0;
    agg.set(e.roomScopeItemId, {
      cum: prev.cum + qty,
      adj: prev.adj + (e.kind === 'DAILY' ? 0 : qty),
      last: e._max.date && (!prev.last || e._max.date > prev.last) ? e._max.date : prev.last,
    });
  }
  const scopeByZone = new Map<string, typeof scope>();
  for (const s of scope) {
    const list = scopeByZone.get(s.zoneId) ?? [];
    list.push(s);
    scopeByZone.set(s.zoneId, list);
  }

  const rollups = zones
    .filter((z) => scopeByZone.has(z.id))
    .map((z) => rollUpRoom(z, scopeByZone.get(z.id)!, agg, mode, now));

  const rooms = rollups.filter((r) => !r.isCommonBucket);
  const common = rollups.find((r) => r.isCommonBucket) ?? null;

  // Dashboard!A7 — the project headline.
  const allActivities = rollups.flatMap((r) => r.activities);
  const overallPct =
    mode === 'sheet'
      ? excelAverage0(allActivities.map((a) => a.pctComplete)) //  ← skips blanks (bug B1)
      : weightedMean(allActivities);

  const activitiesCounted =
    mode === 'sheet' ? allActivities.filter((a) => a.pctComplete != null).length : allActivities.length;

  // Room_Handover's plant-wide strip.
  const plantWide = COMMON_CATEGORIES.map((c) => {
    const acts = common?.activities.filter((a) => a.category === c) ?? [];
    const pct = mode === 'sheet' ? excelAverage0(acts.map((a) => a.pctComplete)) : weightedMean(acts);
    const lastUpdated = acts.reduce<Date | null>((m, a) => (a.lastUpdated && (!m || a.lastUpdated > m) ? a.lastUpdated : m), null);
    return { category: c as string, pct: r4(pct), lastUpdated, status: handoverStatus(pct) };
  });

  const targetMissingCount = allActivities.filter((a) => a.targetMissing).length;

  return {
    mode,
    rooms,
    common,
    overallPct: r4(overallPct),
    totalActivities: allActivities.length,
    expectedActivities: TOTAL_ACTIVITIES,
    roomsReady: rooms.filter((r) => r.handoverStatus === 'Ready for Handover').length,
    totalRooms: rooms.length, // derived, not hard-coded to 7 (bug B9)
    plantWide,
    targetMissingCount,
    activitiesCounted,
    warnings: buildWarnings({ mode, rooms, allActivities, targetMissingCount, activitiesCounted }),
  };
}

function rollUpRoom(
  zone: { id: string; zoneName: string; isCommonBucket: boolean; plannedHandoverDate: Date | null; actualHandoverDate: Date | null },
  scope: {
    id: string; category: string; activity: string; uom: string; targetQty: number | null; weight: number;
    plannedStart: Date | null; plannedFinish: Date | null; plannedHandover: Date | null; remarks: string | null;
  }[],
  agg: Map<string, { cum: number; adj: number; last: Date | null }>,
  mode: DprMode,
  now: Date,
): DprRoomRollup {
  const activities: DprActivityRow[] = scope.map((s) => {
    const { cum, adj, last } = agg.get(s.id) ?? { cum: 0, adj: 0, last: null };
    const hasTarget = s.targetQty != null && s.targetQty > 0;

    // Column J. Sheet: IF(OR(E="",E=0), "", I/E) — blank, and uncapped (bug B7).
    // Corrected: blank target → 0%, and cap at 100% (over-run belongs in a Change Order).
    const pctComplete =
      mode === 'sheet'
        ? hasTarget ? r4(cum / s.targetQty!) : null
        : hasTarget ? r4(Math.min(cum / s.targetQty!, 1)) : 0;

    // Column K. Sheet lets this go negative; corrected floors it at 0.
    const balanceQty = hasTarget
      ? mode === 'sheet' ? r4(s.targetQty! - cum) : r4(Math.max(s.targetQty! - cum, 0))
      : null;

    return {
      id: s.id,
      category: s.category,
      activity: s.activity,
      uom: s.uom,
      targetQty: s.targetQty,
      weight: s.weight,
      plannedStart: s.plannedStart,
      plannedFinish: s.plannedFinish,
      plannedHandover: s.plannedHandover,
      cumQty: r4(cum),
      pctComplete,
      balanceQty,
      lastUpdated: last,
      status: activityStatus(cum, s.targetQty),
      remarks: s.remarks,
      targetMissing: !hasTarget,
      adjustedQty: r4(adj),
    };
  });

  // Room_Handover columns B/C/D — per-category %.
  const cats = zone.isCommonBucket ? COMMON_CATEGORIES : ROOM_CATEGORIES;
  const categoryPct: Record<string, number> = {};
  for (const c of cats) {
    const acts = activities.filter((a) => a.category === c);
    categoryPct[c] = r4(mode === 'sheet' ? excelAverage0(acts.map((a) => a.pctComplete)) : weightedMean(acts));
  }

  // Room_Handover column E.
  //   sheet     — AVERAGE(B:D): an unweighted mean OF MEANS, excluding
  //               Refrigeration/Electrical entirely (bug B2).
  //   corrected — one weighted mean over every activity in the room.
  const overallPct = r4(
    mode === 'sheet'
      ? excelAverage0(Object.values(categoryPct))
      : weightedMean(activities),
  );

  // Column F — MIN(planned handover across the room's activities), falling back
  // to the room's own date.
  const plannedFromItems = activities
    .map((a) => a.plannedHandover)
    .filter((d): d is Date => d != null)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const plannedHandoverDate = plannedFromItems ?? zone.plannedHandoverDate;

  // Column G. The sheet derives this as "date the last activity was completed",
  // which reports a 30%-built room as handed over (bug B3). Corrected mode uses
  // only the explicitly recorded sign-off.
  const actualHandoverDate =
    mode === 'sheet'
      ? activities
          .filter((a) => a.status === 'Completed' && a.lastUpdated)
          .map((a) => a.lastUpdated!)
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
      : zone.actualHandoverDate;

  // Column H.
  let delayDays: number | null = null;
  if (plannedHandoverDate && actualHandoverDate) delayDays = dayDiff(actualHandoverDate, plannedHandoverDate);
  else if (plannedHandoverDate && overallPct < 1 && startOfDay(now) > startOfDay(plannedHandoverDate)) {
    delayDays = dayDiff(now, plannedHandoverDate);
  }

  const lastUpdated = activities.reduce<Date | null>((m, a) => (a.lastUpdated && (!m || a.lastUpdated > m) ? a.lastUpdated : m), null);

  return {
    zoneId: zone.id,
    roomName: zone.zoneName,
    isCommonBucket: zone.isCommonBucket,
    activities,
    categoryPct,
    overallPct,
    plannedHandoverDate,
    actualHandoverDate,
    delayDays,
    handoverStatus: handoverStatus(overallPct),
    lastUpdated,
    staleDays: lastUpdated ? dayDiff(now, lastUpdated) : null,
    targetMissingCount: activities.filter((a) => a.targetMissing).length,
    activityCount: activities.length,
  };
}

// ── Warnings ─────────────────────────────────────────────────────────────────
// Every unsound number the sheet produces gets an explicit, quantified warning
// so nobody reads 89% and believes it. These are the PRD §4 bugs, live.

function buildWarnings(ctx: {
  mode: DprMode;
  rooms: DprRoomRollup[];
  allActivities: DprActivityRow[];
  targetMissingCount: number;
  activitiesCounted: number;
}): DprWarning[] {
  const w: DprWarning[] = [];
  const total = ctx.allActivities.length;

  if (ctx.targetMissingCount > 0) {
    w.push({
      code: 'TARGET_MISSING',
      severity: 'high',
      message:
        `${ctx.targetMissingCount} of ${total} activities have no Target Qty yet. ` +
        `The drawing team must supply the room-wise breakup before any percentage is meaningful.`,
    });
  }

  if (ctx.mode === 'sheet') {
    if (ctx.activitiesCounted < total) {
      w.push({
        code: 'AVERAGE_SKIPS_BLANKS',
        severity: 'high',
        bug: 'B1',
        message:
          `The headline % is an average over only ${ctx.activitiesCounted} of ${total} activities — ` +
          `Excel's AVERAGE() silently skips the ${total - ctx.activitiesCounted} rows with no target. ` +
          `Switch to Corrected mode to count them as 0%.`,
      });
    }
    w.push({
      code: 'MEAN_OF_MEANS',
      severity: 'medium',
      bug: 'B2',
      message:
        'Overall Room % is an unweighted mean of the three category means, so a 213 Sq.m wall counts the same as a ' +
        'single door alarm — and Refrigeration/Electrical are excluded from the room % entirely.',
    });

    const fake = ctx.rooms.filter((r) => r.actualHandoverDate && r.overallPct < 1);
    if (fake.length) {
      w.push({
        code: 'DERIVED_HANDOVER_DATE',
        severity: 'high',
        bug: 'B3',
        message:
          `${fake.map((r) => r.roomName).join(', ')} show an Actual Handover Date while below 100% complete. ` +
          `The sheet derives this from the last completed activity, not from a real handover. Corrected mode shows it blank.`,
      });
    }

    const overrun = ctx.allActivities.filter((a) => a.pctComplete != null && a.pctComplete > 1);
    if (overrun.length) {
      w.push({
        code: 'OVER_100_PCT',
        severity: 'medium',
        bug: 'B7',
        message: `${overrun.length} activities are over 100% complete. Over-run should be raised as a Change Order.`,
      });
    }
  }

  const stale = ctx.rooms.filter((r) => r.staleDays != null && r.staleDays > 7);
  if (stale.length) {
    w.push({
      code: 'STALE_ROOM',
      severity: 'low',
      bug: 'B10',
      message: `No progress logged for over 7 days in: ${stale.map((r) => `${r.roomName} (${r.staleDays}d)`).join(', ')}.`,
    });
  }

  // In the workbook this quantity was invisible — someone simply typed over the
  // SUMIFS. Here it is a first-class, attributable entry, so we say so.
  const adjusted = ctx.allActivities.filter((a) => a.adjustedQty !== 0);
  if (adjusted.length) {
    w.push({
      code: 'MANUAL_ADJUSTMENT',
      severity: 'medium',
      bug: 'B11',
      message:
        `${adjusted.length} activities carry quantity from an opening balance or manual adjustment rather than the ` +
        `daily log: ${adjusted.map((a) => `${a.activity} (${a.adjustedQty > 0 ? '+' : ''}${a.adjustedQty} ${a.uom})`).join(', ')}. ` +
        `In the sheet this was done by typing over the formula, leaving no trail.`,
    });
  }

  return w;
}
