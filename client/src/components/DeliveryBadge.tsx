// Delivery verdict for a PO/WO — the client mirror of server/src/services/delivery.ts.
// Shared by the PO/WO builder, the document register and the Reports page.

import { fmtDate } from '../lib/format';

export type DeliveryStatus = 'ON_TIME' | 'LATE' | 'PENDING' | 'OVERDUE' | 'UNKNOWN';

export interface Delivery {
  promisedDeliveryDate: string | null;
  requiredByDate: string | null;
  actualDeliveryDate: string | null;
  delayDays: number | null;
  status: DeliveryStatus;
  countsTowardsOnTimePct: boolean;
}

/** `<input type="date">` wants yyyy-mm-dd; the API hands back a full ISO string. */
export const isoDay = (d: string | null | undefined) => (d ? String(d).slice(0, 10) : '');

const STYLE: Record<DeliveryStatus, { pill: string; label: string }> = {
  ON_TIME: { pill: 'bg-green-100 text-green-700', label: 'On time' },
  LATE: { pill: 'bg-red-100 text-red-700', label: 'Late' },
  OVERDUE: { pill: 'bg-red-100 text-red-700', label: 'Overdue' },
  PENDING: { pill: 'bg-amber-100 text-amber-700', label: 'Awaiting delivery' },
  UNKNOWN: { pill: 'bg-slate-100 text-slate-500', label: 'No delivery date set' },
};

/** Full block: the actual date plus the verdict. Used in the PO/WO builder. */
export function DeliveryBadge({ delivery }: { delivery?: Delivery | null }) {
  if (!delivery) return <div className="pt-2 text-sm text-slate-400">—</div>;
  const s = STYLE[delivery.status] ?? STYLE.UNKNOWN;
  return (
    <div className="pt-1.5">
      <div className="text-sm font-semibold text-navy">
        {delivery.actualDeliveryDate ? fmtDate(delivery.actualDeliveryDate) : '—'}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className={`badge ${s.pill}`}>{s.label}</span>
        {delivery.delayDays != null && delivery.delayDays !== 0 && (
          <span className={`text-xs font-medium ${delivery.delayDays > 0 ? 'text-red-600' : 'text-green-700'}`}>
            {delivery.delayDays > 0 ? `+${delivery.delayDays}d` : `${delivery.delayDays}d`}
          </span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        {delivery.actualDeliveryDate ? 'From the first approved GRN' : 'Set when the first GRN is approved'}
      </div>
    </div>
  );
}

/** Compact pill only. Used in tables. */
export function DeliveryPill({ delivery }: { delivery?: Delivery | null }) {
  if (!delivery || delivery.status === 'UNKNOWN') return <span className="text-slate-300">—</span>;
  const s = STYLE[delivery.status];
  return (
    <span className={`badge ${s.pill}`} title={
      delivery.promisedDeliveryDate
        ? `Promised ${fmtDate(delivery.promisedDeliveryDate)}${delivery.actualDeliveryDate ? ` · delivered ${fmtDate(delivery.actualDeliveryDate)}` : ''}`
        : undefined
    }>
      {s.label}{delivery.delayDays != null && delivery.delayDays > 0 ? ` +${delivery.delayDays}d` : ''}
    </span>
  );
}
