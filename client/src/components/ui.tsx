import { ReactNode } from 'react';
import { COLOR_HEX, colorFor, riskPill, titleize } from '../lib/format';

export function ProgressBar({ pct, height = 10 }: { pct: number; height?: number }) {
  const color = COLOR_HEX[colorFor(pct)];
  return (
    <div className="w-full rounded-full bg-slate-200" style={{ height }}>
      <div
        className="rounded-full transition-all"
        style={{ width: `${Math.min(Math.max(pct, 0), 100)}%`, height, background: color }}
      />
    </div>
  );
}

export function Gauge({ pct, size = 160 }: { pct: number; size?: number }) {
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(pct, 100) / 100);
  const color = COLOR_HEX[colorFor(pct)];
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e2e8f0" strokeWidth={14} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={14}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset .6s ease' }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="rotate-90" style={{ transformOrigin: 'center', fontSize: 28, fontWeight: 800, fill: '#052379', fontFamily: 'Manrope, system-ui, sans-serif' }}>
        {pct}%
      </text>
    </svg>
  );
}

export function RiskBadge({ level }: { level: string }) {
  return <span className={`badge ${riskPill(level)}`}>{titleize(level)}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 p-10 text-slate-500">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-navy" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: 'var(--scrim, rgba(5,35,121,.34))', backdropFilter: 'blur(2px)' }} onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} my-auto overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h3 className="font-display text-[15px] font-extrabold text-navy">{title}</h3>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700">✕</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function KPI({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: string; accent?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1.5 font-display text-[22px] font-extrabold leading-tight tracking-tight" style={{ color: accent ?? '#052379' }}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-center">
      <div className="font-display text-base font-bold text-slate-700">{title}</div>
      {hint && <div className="max-w-md text-sm text-slate-500">{hint}</div>}
      {action}
    </div>
  );
}
