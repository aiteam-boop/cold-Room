import { useEffect, useState } from 'react';

// Cards | Grid segmented control. The choice is remembered per list (localStorage
// key) so a user who prefers the table keeps it across visits.
export type VendorView = 'cards' | 'grid';

export function useViewMode(storageKey: string, fallback: VendorView = 'cards') {
  const [view, setView] = useState<VendorView>(() => {
    try { const v = localStorage.getItem(storageKey); if (v === 'cards' || v === 'grid') return v; } catch { /* ignore */ }
    return fallback;
  });
  useEffect(() => { try { localStorage.setItem(storageKey, view); } catch { /* ignore */ } }, [storageKey, view]);
  return [view, setView] as const;
}

export default function ViewToggle({ view, onChange }: { view: VendorView; onChange: (v: VendorView) => void }) {
  return (
    <div className="inline-flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
      <Seg active={view === 'cards'} onClick={() => onChange('cards')} label="Cards" icon={CARDS_ICON} />
      <Seg active={view === 'grid'} onClick={() => onChange('grid')} label="Grid" icon={GRID_ICON} />
    </div>
  );
}

function Seg({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition ${active ? 'bg-navy text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
      {icon}{label}
    </button>
  );
}

const CARDS_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
const GRID_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="1.5" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="9" x2="9" y2="20" /></svg>
);
