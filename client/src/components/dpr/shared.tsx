// Shared pieces for the room-wise DPR tabs.
//
// The whole module renders in one of two modes:
//   'sheet'     — the numbers DPR_Cold_Storage_RoomWise.xlsx produces, bugs and all
//   'corrected' — the calculation CRMCTS_DPR_RoomWise_PRD_v1.0.md §4 argues for
// The mode is a module-wide choice, so it lives in localStorage and every tab
// reads it from the same hook.

import { useCallback, useEffect, useState } from 'react';

export type DprMode = 'sheet' | 'corrected';

export interface DprWarning {
  code: string;
  severity: 'high' | 'medium' | 'low';
  bug?: string;
  message: string;
}

export interface DprActivity {
  id: string;
  category: string;
  activity: string;
  uom: string;
  targetQty: number | null;
  weight: number;
  plannedStart: string | null;
  plannedFinish: string | null;
  plannedHandover: string | null;
  cumQty: number;
  pctComplete: number | null;
  balanceQty: number | null;
  lastUpdated: string | null;
  status: string;
  remarks: string | null;
  targetMissing: boolean;
  adjustedQty: number;
}

export interface DprRoom {
  zoneId: string;
  roomName: string;
  isCommonBucket: boolean;
  activities: DprActivity[];
  categoryPct: Record<string, number>;
  overallPct: number;
  plannedHandoverDate: string | null;
  actualHandoverDate: string | null;
  delayDays: number | null;
  handoverStatus: string;
  lastUpdated: string | null;
  staleDays: number | null;
  targetMissingCount: number;
  activityCount: number;
}

export interface DprSummary {
  mode: DprMode;
  rooms: DprRoom[];
  common: DprRoom | null;
  overallPct: number;
  totalActivities: number;
  expectedActivities: number;
  roomsReady: number;
  totalRooms: number;
  plantWide: { category: string; pct: number; lastUpdated: string | null; status: string }[];
  targetMissingCount: number;
  activitiesCounted: number;
  warnings: DprWarning[];
}

const KEY = 'crmcts.dpr.mode';

export function useDprMode(): [DprMode, (m: DprMode) => void] {
  const [mode, setMode] = useState<DprMode>(() => (localStorage.getItem(KEY) === 'corrected' ? 'corrected' : 'sheet'));
  // Keep every mounted DPR tab in step when the toggle is flipped on any of them.
  useEffect(() => {
    const onChange = (e: Event) => setMode((e as CustomEvent<DprMode>).detail);
    window.addEventListener('dpr-mode', onChange);
    return () => window.removeEventListener('dpr-mode', onChange);
  }, []);
  const set = useCallback((m: DprMode) => {
    localStorage.setItem(KEY, m);
    window.dispatchEvent(new CustomEvent('dpr-mode', { detail: m }));
  }, []);
  return [mode, set];
}

export function ModeToggle({ mode, onChange }: { mode: DprMode; onChange: (m: DprMode) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Calculation</span>
      <div className="flex overflow-hidden rounded-lg border border-slate-200">
        {(['sheet', 'corrected'] as DprMode[]).map((m) => (
          <button
            key={m}
            onClick={() => onChange(m)}
            title={m === 'sheet'
              ? 'Reproduce DPR_Cold_Storage_RoomWise.xlsx exactly — including its calculation bugs'
              : 'Apply the corrections in CRMCTS_DPR_RoomWise_PRD_v1.0.md §4'}
            className={`px-3 py-1.5 text-xs font-semibold transition ${
              mode === m ? 'bg-navy text-white' : 'bg-white text-slate-500 hover:bg-slate-50'
            }`}
          >
            {m === 'sheet' ? 'As per Sheet' : 'Corrected'}
          </button>
        ))}
      </div>
    </div>
  );
}

const SEV: Record<DprWarning['severity'], { box: string; dot: string; label: string }> = {
  high: { box: 'border-red-200 bg-red-50 text-red-800', dot: 'bg-red-500', label: 'text-red-600' },
  medium: { box: 'border-amber-200 bg-amber-50 text-amber-800', dot: 'bg-amber-500', label: 'text-amber-600' },
  low: { box: 'border-slate-200 bg-slate-50 text-slate-600', dot: 'bg-slate-400', label: 'text-slate-500' },
};

export function WarningList({ warnings }: { warnings: DprWarning[] }) {
  if (!warnings.length) return null;
  const order = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...warnings].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <div className="mb-4 space-y-1.5">
      {sorted.map((w) => {
        const s = SEV[w.severity];
        return (
          <div key={w.code} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs ${s.box}`}>
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
            <div>
              {w.bug && <span className={`mr-1.5 font-mono text-[10px] font-bold uppercase ${s.label}`}>{w.bug}</span>}
              {w.message}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A percentage cell. `null` renders blank — that is exactly what the sheet shows. */
export function Pct({ value, missing }: { value: number | null; missing?: boolean }) {
  if (value == null) {
    return (
      <span className="text-slate-300" title="No Target Qty set — the sheet leaves this blank and AVERAGE() skips the row">
        —
      </span>
    );
  }
  const pct = Math.round(value * 100);
  const tone = pct > 100 ? 'text-red-600' : pct >= 100 ? 'text-green-700' : pct >= 75 ? 'text-amber-600' : 'text-slate-700';
  return (
    <span className={`font-semibold ${tone}`} title={missing ? 'No target set — counted as 0%' : undefined}>
      {pct}%
    </span>
  );
}

const STATUS_PILL: Record<string, string> = {
  'Ready for Handover': 'bg-green-100 text-green-700',
  'Near Completion': 'bg-amber-100 text-amber-700',
  Completed: 'bg-green-100 text-green-700',
  'In Progress': 'bg-amber-100 text-amber-700',
  'Not Started': 'bg-red-100 text-red-600',
  Delayed: 'bg-red-100 text-red-700',
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`badge ${STATUS_PILL[status] ?? 'bg-slate-100 text-slate-600'}`}>{status}</span>;
}

/** Sheet-style short date: 07-Jul-26. */
export function sheetDate(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()];
  return `${String(dt.getUTCDate()).padStart(2, '0')}-${mon}-${String(dt.getUTCFullYear()).slice(2)}`;
}

export const numOrDash = (n: number | null | undefined) =>
  n == null ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2);

/** Delay in days, signed the way the sheet signs it (negative = early). */
export function DelayCell({ days }: { days: number | null }) {
  if (days == null) return <span className="text-slate-300">—</span>;
  if (days === 0) return <span className="text-slate-600">0</span>;
  return <span className={days > 0 ? 'font-semibold text-red-600' : 'font-semibold text-green-700'}>{days > 0 ? `+${days}` : days}</span>;
}
