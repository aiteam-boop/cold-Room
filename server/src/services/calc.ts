// ── Calculations engine (PRD §5.2.3 + §8) ──────────────────────────────────
// Pure functions over BOQ items and approved progress entries. No DB access
// here so it is trivially testable and reusable by dashboards + reports.

export interface CalcEntry {
  boqItemId: string;
  date: Date;
  quantityInstalled: number;
  status: string;
}

export interface CalcItem {
  id: string;
  description: string;
  category?: string | null;
  roomZone?: string | null;
  unit?: string | null;
  plannedQty: number;
  isGroup: boolean;
  zoneId?: string | null;
}

export interface ItemProgress {
  id: string;
  description: string;
  category: string | null;
  roomZone: string | null;
  unit: string | null;
  plannedQty: number;
  installedQty: number;
  remainingQty: number;
  completionPct: number; // 0..100
  dailyRate: number; // rolling 7-day avg per working day
  estimatedCompletionDate: string | null; // ISO date
  colorStatus: ColorStatus;
}

export type ColorStatus = 'GREEN' | 'YELLOW' | 'RED';

export const MS_PER_DAY = 86_400_000;

export function clampPct(n: number): number {
  if (!isFinite(n) || n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

// PRD §5.1.3 colour coding: Green >=80, Yellow 20-79, Red <20.
export function colorFor(pct: number): ColorStatus {
  if (pct >= 80) return 'GREEN';
  if (pct >= 20) return 'YELLOW';
  return 'RED';
}

// Sum of approved entries for an item.
function installedFor(itemId: string, entries: CalcEntry[]): number {
  return entries
    .filter((e) => e.boqItemId === itemId && e.status === 'APPROVED')
    .reduce((sum, e) => sum + e.quantityInstalled, 0);
}

// Rolling N-day average daily work rate for one item (PRD: rolling 7-day avg).
// We average over the number of *distinct working days* observed in the window,
// which is robust when work happens on non-consecutive days.
export function dailyRate(itemId: string, entries: CalcEntry[], now: Date, windowDays = 7): number {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const recent = entries.filter(
    (e) => e.boqItemId === itemId && e.status === 'APPROVED' && e.date.getTime() >= cutoff
  );
  if (recent.length === 0) return 0;
  const total = recent.reduce((s, e) => s + e.quantityInstalled, 0);
  const workingDays = new Set(recent.map((e) => e.date.toISOString().slice(0, 10))).size || 1;
  return total / workingDays;
}

export function estimateCompletion(
  remaining: number,
  rate: number,
  now: Date
): string | null {
  if (remaining <= 0) return now.toISOString().slice(0, 10); // already done
  if (rate <= 0) return null; // no velocity → unknown
  const days = Math.ceil(remaining / rate);
  return new Date(now.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

export function computeItem(item: CalcItem, entries: CalcEntry[], now: Date): ItemProgress {
  const installed = installedFor(item.id, entries);
  const planned = item.plannedQty || 0;
  const remaining = Math.max(planned - installed, 0);
  const pct = planned > 0 ? clampPct((installed / planned) * 100) : installed > 0 ? 100 : 0;
  const rate = dailyRate(item.id, entries, now);
  return {
    id: item.id,
    description: item.description,
    category: item.category ?? null,
    roomZone: item.roomZone ?? null,
    unit: item.unit ?? null,
    plannedQty: planned,
    installedQty: Math.round(installed * 1000) / 1000,
    remainingQty: Math.round(remaining * 1000) / 1000,
    completionPct: pct,
    dailyRate: Math.round(rate * 1000) / 1000,
    estimatedCompletionDate: estimateCompletion(remaining, rate, now),
    colorStatus: colorFor(pct),
  };
}

export interface CategoryProgress {
  category: string;
  plannedQty: number;
  installedQty: number;
  remainingQty: number;
  completionPct: number; // weighted by planned qty
  colorStatus: ColorStatus;
  estimatedCompletionDate: string | null;
  itemCount: number;
}

// Category completion = weighted average across its line items, weighted by
// planned quantity volume (PRD §5.2.3). Items with no planned qty (groups,
// TBC) are excluded from the weighting.
export function computeCategories(items: ItemProgress[]): CategoryProgress[] {
  const map = new Map<string, ItemProgress[]>();
  for (const it of items) {
    const key = it.category || 'Uncategorized';
    (map.get(key) ?? map.set(key, []).get(key)!).push(it);
  }
  const out: CategoryProgress[] = [];
  for (const [category, list] of map) {
    const planned = list.reduce((s, i) => s + i.plannedQty, 0);
    const installed = list.reduce((s, i) => s + i.installedQty, 0);
    const remaining = list.reduce((s, i) => s + i.remainingQty, 0);
    const pct = planned > 0 ? clampPct((installed / planned) * 100) : 0;
    // Category est. completion = the latest (max) item estimate; null if any unknown
    // item still has remaining work.
    let est: string | null = null;
    let unknown = false;
    for (const i of list) {
      if (i.remainingQty > 0 && !i.estimatedCompletionDate) unknown = true;
      if (i.estimatedCompletionDate && (!est || i.estimatedCompletionDate > est)) {
        est = i.estimatedCompletionDate;
      }
    }
    out.push({
      category,
      plannedQty: planned,
      installedQty: Math.round(installed * 1000) / 1000,
      remainingQty: Math.round(remaining * 1000) / 1000,
      completionPct: pct,
      colorStatus: colorFor(pct),
      estimatedCompletionDate: unknown ? null : est,
      itemCount: list.length,
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category));
}

export interface OverallProgress {
  completionPct: number;
  plannedQty: number;
  installedQty: number;
  remainingQty: number;
  estimatedCompletionDate: string | null;
  totalItems: number;
  itemsCompleted: number;
  itemsInProgress: number;
  itemsNotStarted: number;
}

// Overall completion = weighted average across all categories, weighted by
// planned quantity volume (PRD §5.2.3). Since each category is itself volume-
// weighted, this reduces to total installed / total planned across all items.
export function computeOverall(items: ItemProgress[]): OverallProgress {
  const tracked = items.filter((i) => !Number.isNaN(i.plannedQty));
  const planned = tracked.reduce((s, i) => s + i.plannedQty, 0);
  const installed = tracked.reduce((s, i) => s + i.installedQty, 0);
  const remaining = tracked.reduce((s, i) => s + i.remainingQty, 0);
  const pct = planned > 0 ? clampPct((installed / planned) * 100) : 0;

  let est: string | null = null;
  let unknown = false;
  for (const i of tracked) {
    if (i.remainingQty > 0 && !i.estimatedCompletionDate) unknown = true;
    if (i.estimatedCompletionDate && (!est || i.estimatedCompletionDate > est)) {
      est = i.estimatedCompletionDate;
    }
  }
  return {
    completionPct: pct,
    plannedQty: planned,
    installedQty: Math.round(installed * 1000) / 1000,
    remainingQty: Math.round(remaining * 1000) / 1000,
    estimatedCompletionDate: unknown ? null : est,
    totalItems: tracked.length,
    itemsCompleted: tracked.filter((i) => i.completionPct >= 100).length,
    itemsInProgress: tracked.filter((i) => i.completionPct > 0 && i.completionPct < 100).length,
    itemsNotStarted: tracked.filter((i) => i.completionPct === 0).length,
  };
}

export type RiskLevel = 'ON_TRACK' | 'AT_RISK' | 'DELAYED' | 'UNKNOWN';

export interface DelayRisk {
  level: RiskLevel;
  estimatedCompletionDate: string | null;
  targetCompletionDate: string | null;
  projectedOverrunDays: number; // positive = late
  message: string;
}

// PRD §3.1.6 / §8: compare velocity-based estimate to target. Flag At-Risk
// when projected to overrun (>= 7 days lead time before overrun = AT_RISK
// threshold), DELAYED when target already passed or estimate beyond it.
export function assessDelay(
  estimatedISO: string | null,
  targetDate: Date | null,
  now: Date
): DelayRisk {
  const targetISO = targetDate ? targetDate.toISOString().slice(0, 10) : null;
  if (!targetDate) {
    return {
      level: 'UNKNOWN',
      estimatedCompletionDate: estimatedISO,
      targetCompletionDate: null,
      projectedOverrunDays: 0,
      message: 'No target completion date set.',
    };
  }
  if (!estimatedISO) {
    // No velocity yet. If target already passed, that's a hard delay.
    const overdue = Math.floor((now.getTime() - targetDate.getTime()) / MS_PER_DAY);
    if (overdue > 0) {
      return {
        level: 'DELAYED',
        estimatedCompletionDate: null,
        targetCompletionDate: targetISO,
        projectedOverrunDays: overdue,
        message: `Target date passed ${overdue} day(s) ago with work still pending.`,
      };
    }
    return {
      level: 'UNKNOWN',
      estimatedCompletionDate: null,
      targetCompletionDate: targetISO,
      projectedOverrunDays: 0,
      message: 'Not enough progress data to estimate a finish date yet.',
    };
  }
  const est = new Date(estimatedISO + 'T00:00:00Z').getTime();
  const overrun = Math.round((est - targetDate.getTime()) / MS_PER_DAY);
  if (overrun > 0) {
    // Distinguish "flagged early" (AT_RISK) vs already past target (DELAYED).
    const level: RiskLevel = now.getTime() > targetDate.getTime() ? 'DELAYED' : 'AT_RISK';
    return {
      level,
      estimatedCompletionDate: estimatedISO,
      targetCompletionDate: targetISO,
      projectedOverrunDays: overrun,
      message:
        level === 'DELAYED'
          ? `Projected to finish ${overrun} day(s) past target.`
          : `At current pace, projected to overrun target by ${overrun} day(s).`,
    };
  }
  return {
    level: 'ON_TRACK',
    estimatedCompletionDate: estimatedISO,
    targetCompletionDate: targetISO,
    projectedOverrunDays: overrun,
    message: `On track — projected to finish ${Math.abs(overrun)} day(s) before target.`,
  };
}
