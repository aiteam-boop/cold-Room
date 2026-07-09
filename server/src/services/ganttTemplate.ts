// Standard Gantt activity template — the default TAT (turnaround time, in
// working days) and responsible party for each activity in AA sir's project
// timeline. (Sprint PRD §4.1.)
//
// These are DEFAULTS ONLY. When an activity is created from the template the
// resolved TAT is written onto the GanttActivity row, so a later edit to this
// table never rewrites history — existing activities keep the value they were
// created with. `matchStandardTat` is a convenience for the "new activity" form
// so typing a known activity name pre-fills its TAT.

export interface StandardActivity {
  activityName: string;
  tatDays: number;
  responsibleName: string;
  /** Human note about what the TAT is measured from. */
  clockStart: string;
  /** Days offset from the project's official start (day 0) for the planned bar. */
  offsetDays: number;
}

// Ordered as the work actually happens; offsetDays chains them so "Apply
// template" lays out a sensible first-pass schedule from day 0.
export const STANDARD_ACTIVITIES: StandardActivity[] = [
  { activityName: 'Drawing Approval', tatDays: 4, responsibleName: 'Amisha', clockStart: 'from drawing receipt', offsetDays: 0 },
  { activityName: 'PO Issue to Vendor', tatDays: 3, responsibleName: 'Amisha', clockStart: 'from drawing approval', offsetDays: 0 },
  { activityName: 'Production of PUF Panels', tatDays: 14, responsibleName: 'Vendor (Kingspan or equivalent)', clockStart: 'from PO issue', offsetDays: 3 },
  { activityName: 'Production of Doors', tatDays: 14, responsibleName: 'Door vendor', clockStart: 'from PO issue', offsetDays: 3 },
  { activityName: 'Delivery to Site — Panels', tatDays: 7, responsibleName: 'Logistics/Vendor', clockStart: 'from production complete', offsetDays: 17 },
  { activityName: 'Delivery to Site — Doors', tatDays: 7, responsibleName: 'Logistics/Vendor', clockStart: 'from production complete', offsetDays: 17 },
  { activityName: 'PUF Panel Installation', tatDays: 7, responsibleName: 'Installation contractor', clockStart: 'can extend to max 10 days', offsetDays: 24 },
  { activityName: 'Refrigeration System Installation', tatDays: 10, responsibleName: 'Refrigeration contractor', clockStart: '', offsetDays: 31 },
  { activityName: 'Electrical Works', tatDays: 5, responsibleName: 'Electrical contractor', clockStart: '', offsetDays: 41 },
  { activityName: 'Testing & Commissioning', tatDays: 3, responsibleName: 'Site Engineer + Vendor rep', clockStart: '', offsetDays: 46 },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Look up the standard TAT for an activity name. Exact (normalized) match
 * first, then a containment match so "PUF Panel Installation - Room 2" still
 * resolves. Returns undefined when nothing matches — the caller then requires
 * the user to type a TAT (it is a mandatory field).
 */
export function matchStandardTat(activityName: string): StandardActivity | undefined {
  const q = norm(activityName);
  if (!q) return undefined;
  return (
    STANDARD_ACTIVITIES.find((a) => norm(a.activityName) === q) ??
    STANDARD_ACTIVITIES.find((a) => q.includes(norm(a.activityName)) || norm(a.activityName).includes(q))
  );
}
