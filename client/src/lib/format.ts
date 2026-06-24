export type ColorStatus = 'GREEN' | 'YELLOW' | 'RED';

export const COLOR_HEX: Record<ColorStatus, string> = {
  GREEN: '#16a34a',
  YELLOW: '#d97706',
  RED: '#dc2626',
};

export function colorFor(pct: number): ColorStatus {
  if (pct >= 80) return 'GREEN';
  if (pct >= 20) return 'YELLOW';
  return 'RED';
}

// Tailwind classes for status pills.
export function statusPill(pct: number): string {
  if (pct >= 80) return 'bg-green-100 text-green-700';
  if (pct >= 20) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

export function riskPill(level: string): string {
  switch (level) {
    case 'ON_TRACK':
      return 'bg-green-100 text-green-700';
    case 'AT_RISK':
      return 'bg-amber-100 text-amber-700';
    case 'DELAYED':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

export function projectStatusPill(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'bg-blue-100 text-blue-700';
    case 'COMPLETED':
      return 'bg-green-100 text-green-700';
    case 'ON_HOLD':
      return 'bg-amber-100 text-amber-700';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

export function fmtDate(d?: string | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return '0';
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Indian-format currency (₹ 1,23,456).
export function inr(n: number | null | undefined): string {
  if (n == null) return '₹0';
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function docStatusPill(status: string): string {
  switch (status) {
    case 'APPROVED': return 'bg-green-100 text-green-700';
    case 'PENDING_APPROVAL': case 'OPEN': return 'bg-amber-100 text-amber-700';
    case 'REJECTED': return 'bg-red-100 text-red-700';
    default: return 'bg-slate-100 text-slate-600';
  }
}
