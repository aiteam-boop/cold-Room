// Delivery performance for a PO/WO. (DPR PRD §3.2 G7, transcript R12/R20:
// "PO has been raised on time as per BOQ and payment has been made on time and
//  delivery has made on time.")
//
// The actual delivery date is NEVER stored. It is MIN(grnDate) over the
// document's APPROVED GRNs — the day material first landed and was accepted. A
// stored copy would drift the moment a GRN was rejected or back-dated.
//
// A document with no promised date has no delivery verdict: UNKNOWN, not "late".
// A document whose material has not arrived is PENDING until the promised date
// passes, then OVERDUE. This keeps "on-time %" honest — it is only ever computed
// over documents that both promised a date and received something.

const MS_DAY = 86_400_000;
const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const diffDays = (a: Date, b: Date) => Math.round((day(a) - day(b)) / MS_DAY);

export type DeliveryStatus = 'ON_TIME' | 'LATE' | 'PENDING' | 'OVERDUE' | 'UNKNOWN';

export interface DeliveryInfo {
  promisedDeliveryDate: Date | null;
  requiredByDate: Date | null;
  /** MIN(grnDate) over APPROVED GRNs. Null until something is received. */
  actualDeliveryDate: Date | null;
  /** > 0 = late by N days, < 0 = early, 0 = on the day. Null when undecidable. */
  delayDays: number | null;
  status: DeliveryStatus;
  /** Only ON_TIME and LATE count towards the on-time percentage. */
  countsTowardsOnTimePct: boolean;
}

export interface GrnLike { grnDate: Date; status: string }

export function deliveryInfo(
  doc: { promisedDeliveryDate: Date | null; requiredByDate: Date | null },
  grns: GrnLike[],
  now = new Date(),
): DeliveryInfo {
  const received = grns
    .filter((g) => g.status === 'APPROVED')
    .map((g) => g.grnDate)
    .sort((a, b) => a.getTime() - b.getTime());
  const actualDeliveryDate = received[0] ?? null;
  const promised = doc.promisedDeliveryDate;

  let status: DeliveryStatus;
  let delayDays: number | null = null;

  if (!promised) {
    // No commitment was recorded, so nothing can be judged against it.
    status = 'UNKNOWN';
  } else if (actualDeliveryDate) {
    delayDays = diffDays(actualDeliveryDate, promised);
    status = delayDays > 0 ? 'LATE' : 'ON_TIME';
  } else if (day(now) > day(promised)) {
    delayDays = diffDays(now, promised); // slipping, live
    status = 'OVERDUE';
  } else {
    status = 'PENDING';
  }

  return {
    promisedDeliveryDate: promised,
    requiredByDate: doc.requiredByDate,
    actualDeliveryDate,
    delayDays,
    status,
    countsTowardsOnTimePct: status === 'ON_TIME' || status === 'LATE',
  };
}

/** On-time delivery %, over documents that promised a date and received material. */
export function onTimeDeliveryPct(infos: DeliveryInfo[]): { pct: number | null; onTime: number; measured: number } {
  const measured = infos.filter((i) => i.countsTowardsOnTimePct);
  const onTime = measured.filter((i) => i.status === 'ON_TIME').length;
  return { pct: measured.length ? onTime / measured.length : null, onTime, measured: measured.length };
}

// ── Payment punctuality ──────────────────────────────────────────────────────
// The mirror of the above, for PaymentMilestone. A milestone is "on time" when it
// was paid on or before its expected date. Milestones with no expected date are
// not measured; triggered-but-unpaid ones past their date are OVERDUE.

export type PaymentPunctuality = 'ON_TIME' | 'LATE' | 'PENDING' | 'OVERDUE' | 'UNKNOWN';

export interface MilestoneLike {
  status: string;
  expectedDate: Date | null;
  paymentDate: Date | null;
}

export function paymentPunctuality(m: MilestoneLike, now = new Date()): { status: PaymentPunctuality; delayDays: number | null } {
  if (!m.expectedDate) return { status: 'UNKNOWN', delayDays: null };
  if (m.status === 'PAID') {
    if (!m.paymentDate) return { status: 'UNKNOWN', delayDays: null };
    const d = diffDays(m.paymentDate, m.expectedDate);
    return { status: d > 0 ? 'LATE' : 'ON_TIME', delayDays: d };
  }
  if (day(now) > day(m.expectedDate)) return { status: 'OVERDUE', delayDays: diffDays(now, m.expectedDate) };
  return { status: 'PENDING', delayDays: null };
}

export function onTimePaymentPct(rows: { status: PaymentPunctuality }[]): { pct: number | null; onTime: number; measured: number } {
  const measured = rows.filter((r) => r.status === 'ON_TIME' || r.status === 'LATE');
  const onTime = measured.filter((r) => r.status === 'ON_TIME').length;
  return { pct: measured.length ? onTime / measured.length : null, onTime, measured: measured.length };
}
