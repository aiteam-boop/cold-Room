// Drawing Approval checklist — the anchor for a project's official start date.
// (Sprint PRD §2.)
//
// A project is in "pending start" until EVERY drawing in the checklist is
// approved. `officialStartDate` = the latest actualDate across the checklist,
// i.e. the day the LAST drawing was ticked. Order receipt and advance payment
// are recorded on the Project row but never start the clock.
//
// The checklist lives in Project.drawingApprovals (Json) rather than its own
// table: it is a small, always-loaded-together, per-project array whose shape
// the admin can extend with custom drawing types.
//
// Open question OQ-S1 asked whether the 4-day TAT runs from drawing receipt or
// from review start. We sidestep it by storing `drawingReceivedDate` as an
// explicit field: plannedDate defaults to receivedDate + TAT working days, and
// an admin can always override plannedDate directly.

import { DRAWING_APPROVAL_STATUSES, DRAWING_APPROVAL_TYPES } from '../lib/enums';
import type { DrawingApprovalStatus, DrawingApprovalType } from '../lib/enums';

export interface DrawingApproval {
  id: string;
  type: DrawingApprovalType;
  name: string;
  tatDays: number;
  drawingReceivedDate: string | null; // ISO yyyy-mm-dd — starts the TAT clock
  plannedDate: string | null;         // ISO yyyy-mm-dd — defaults to received + TAT
  actualDate: string | null;          // ISO yyyy-mm-dd — set when ticked Approved
  responsibleUserId: string | null;
  responsibleName: string;
  documentUrl: string | null;         // final approved drawing PDF
  status: DrawingApprovalStatus;
}

/** Live, computed view of a checklist row. */
export interface DerivedDrawingApproval extends DrawingApproval {
  effectivePlannedDate: string | null;
  delayDays: number; // > 0 only when overdue AND not yet approved
}

export interface DrawingApprovalSummary {
  items: DerivedDrawingApproval[];
  total: number;
  approved: number;
  allApproved: boolean;
  officialStartDate: string | null; // null until every drawing is approved
  worstDelayDays: number;
  /** e.g. "Pending Drawing Approval (2 of 4 done)" — ready to render. */
  label: string;
}

const MS_DAY = 86_400_000;
const DEFAULT_TAT_DAYS = 4;
const DEFAULT_RESPONSIBLE = 'Amisha';

// The 4 standard drawings every cold-room project needs (Sprint PRD §2.2).
const STANDARD: { type: DrawingApprovalType; name: string }[] = [
  { type: 'PUF_PANEL', name: 'PUF Panel Drawing' },
  { type: 'REFRIGERATION', name: 'Refrigeration Drawing' },
  { type: 'DOOR', name: 'Door Drawing' },
  { type: 'ELECTRICAL', name: 'Electrical Layout' },
];

/** Add N *working* days (Mon–Fri) to a date. */
export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  let left = Math.max(0, Math.trunc(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toIsoDay = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : isoDay(d);
};

/** The checklist a brand-new project starts with. */
export function defaultDrawingApprovals(): DrawingApproval[] {
  return STANDARD.map((s, i) => ({
    id: `dwg-${i + 1}-${s.type.toLowerCase()}`,
    type: s.type,
    name: s.name,
    tatDays: DEFAULT_TAT_DAYS,
    drawingReceivedDate: null,
    plannedDate: null,
    actualDate: null,
    responsibleUserId: null,
    responsibleName: DEFAULT_RESPONSIBLE,
    documentUrl: null,
    status: 'PENDING',
  }));
}

/**
 * Coerce whatever is in the Json column (or an untrusted request body) into a
 * well-formed checklist. Unknown fields are dropped; a missing/empty array
 * falls back to the 4 standard drawings so the UI always has something to show.
 * A row can only be APPROVED if it carries an actualDate — that invariant is
 * what makes officialStartDate trustworthy.
 */
export function normalizeDrawingApprovals(raw: unknown): DrawingApproval[] {
  if (!Array.isArray(raw) || raw.length === 0) return defaultDrawingApprovals();
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const type = DRAWING_APPROVAL_TYPES.includes(o.type as DrawingApprovalType)
      ? (o.type as DrawingApprovalType)
      : 'CUSTOM';
    const actualDate = toIsoDay(o.actualDate);
    let status = DRAWING_APPROVAL_STATUSES.includes(o.status as DrawingApprovalStatus)
      ? (o.status as DrawingApprovalStatus)
      : 'PENDING';
    // Approved without a date is meaningless, and a date without Approved is a
    // half-saved tick — reconcile both to the date, which is the audit fact.
    if (status === 'APPROVED' && !actualDate) status = 'IN_REVIEW';
    if (actualDate) status = 'APPROVED';

    const tat = Number(o.tatDays);
    return {
      id: typeof o.id === 'string' && o.id ? o.id : `dwg-${i + 1}-${Date.now().toString(36)}`,
      type,
      name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : STANDARD[i]?.name ?? 'Drawing',
      tatDays: Number.isFinite(tat) && tat > 0 ? Math.trunc(tat) : DEFAULT_TAT_DAYS,
      drawingReceivedDate: toIsoDay(o.drawingReceivedDate),
      plannedDate: toIsoDay(o.plannedDate),
      actualDate,
      responsibleUserId: typeof o.responsibleUserId === 'string' && o.responsibleUserId ? o.responsibleUserId : null,
      responsibleName: typeof o.responsibleName === 'string' && o.responsibleName.trim() ? o.responsibleName.trim() : DEFAULT_RESPONSIBLE,
      documentUrl: typeof o.documentUrl === 'string' && o.documentUrl ? o.documentUrl : null,
      status,
    };
  });
}

/**
 * The project's official start date: the latest approval date, but ONLY once
 * every drawing in the checklist is approved. Returns null otherwise — the
 * project stays in "pending start" and the Gantt delay clock does not tick.
 */
export function computeOfficialStartDate(items: DrawingApproval[]): Date | null {
  if (items.length === 0) return null;
  if (!items.every((i) => i.status === 'APPROVED' && i.actualDate)) return null;
  const latest = items.reduce((max, i) => {
    const t = new Date(i.actualDate!).getTime();
    return t > max ? t : max;
  }, -Infinity);
  return Number.isFinite(latest) ? new Date(latest) : null;
}

/** Planned approval date: explicit override, else received + TAT working days. */
function effectivePlanned(item: DrawingApproval): string | null {
  if (item.plannedDate) return item.plannedDate;
  if (!item.drawingReceivedDate) return null;
  return isoDay(addWorkingDays(new Date(item.drawingReceivedDate), item.tatDays));
}

/** Attach live delay + rollup. Delay only accrues on drawings not yet approved. */
export function summarizeDrawingApprovals(items: DrawingApproval[], now = new Date()): DrawingApprovalSummary {
  const derived: DerivedDrawingApproval[] = items.map((i) => {
    const planned = effectivePlanned(i);
    const overdue = !!planned && i.status !== 'APPROVED' && now.getTime() > new Date(planned).getTime();
    return {
      ...i,
      effectivePlannedDate: planned,
      delayDays: overdue ? Math.ceil((now.getTime() - new Date(planned!).getTime()) / MS_DAY) : 0,
    };
  });
  const approved = derived.filter((i) => i.status === 'APPROVED').length;
  const start = computeOfficialStartDate(items);
  return {
    items: derived,
    total: derived.length,
    approved,
    allApproved: derived.length > 0 && approved === derived.length,
    officialStartDate: start ? isoDay(start) : null,
    worstDelayDays: derived.reduce((m, i) => Math.max(m, i.delayDays), 0),
    label: start
      ? `Project Start: ${isoDay(start)}`
      : `Pending Drawing Approval (${approved} of ${derived.length} done)`,
  };
}
