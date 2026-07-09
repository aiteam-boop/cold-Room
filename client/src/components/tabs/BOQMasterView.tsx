// BOQ Master — the immutable contract document.
//
// AA sir (transcript P14/P15): "Main BOQ ko nahi chhed sakte hum log. Wo as it is
// pada rahega. Ye kuch change to ho hi nahi sakta na. Edit nahi hoga na koi bhi."
//
// So this view is the BOQ exactly as it was imported: the scope, the quantities,
// the specs. Nothing derived, nothing editable, and — crucially — no money. It is
// the denominator that "BOQ & Progress" and "BOQ & Cost" both measure against.
//
//   BOQ Master    → what was contracted        (this view, read-only)
//   BOQ & Progress→ how much of it is built    (installed qty, % complete)
//   BOQ & Cost    → what it cost to buy        (PO, GRN, invoice, payment)
//
// Financial columns are deliberately absent even for users who can see money —
// the split is what keeps the master document trustworthy.

import { useMemo, useState } from 'react';
import { EmptyState } from '../ui';
import { fmtNum } from '../../lib/format';

export interface MasterItem {
  id: string; srNo?: string; description: string; category?: string; roomZone?: string;
  unit?: string; makeModel?: string; remarks?: string; plannedQty: number; isGroup: boolean;
}

export default function BOQMasterView({ items, locked }: { items: MasterItem[]; locked: boolean }) {
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    // Keep a group header only when one of its children survives the filter.
    const matches = (i: MasterItem) =>
      [i.srNo, i.description, i.category, i.roomZone, i.makeModel, i.remarks]
        .some((v) => v?.toLowerCase().includes(needle));
    return items.filter((i) => !i.isGroup && matches(i));
  }, [items, q]);

  const leaves = items.filter((i) => !i.isGroup);
  const categories = new Set(leaves.map((i) => i.category || 'Uncategorized'));

  if (items.length === 0) {
    return <EmptyState title="No BOQ imported yet" hint="Import the BOQ spreadsheet from the action bar above. Once imported, this view never changes." />;
  }

  return (
    <div className="space-y-4">
      <div className={`rounded-lg px-3 py-2 text-sm ${locked ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-800'}`}>
        {locked
          ? 'This is the locked contract BOQ. It is read-only everywhere — progress and cost are tracked against it, never written into it.'
          : 'This BOQ is not locked yet. Lock the baseline once the contract scope is final — after that, quantity changes must go through a Change Order.'}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-500">
          <span className="font-semibold text-navy">{leaves.length}</span> items across{' '}
          <span className="font-semibold text-navy">{categories.size}</span> categories
        </div>
        <input
          className="input max-w-xs"
          placeholder="Search description, Sr.No, room, model…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-2 py-2">Sr.No</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-2">Category</th>
                <th className="px-2">Room / Zone</th>
                <th className="px-2">Make &amp; Model</th>
                <th className="px-2 text-right">Qty</th>
                <th className="px-2">Unit</th>
                <th className="px-2">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-slate-400">Nothing matches “{q}”.</td></tr>
              )}
              {rows.map((it) =>
                it.isGroup ? (
                  <tr key={it.id} className="bg-slate-100/60 font-semibold text-navy">
                    <td className="px-2 py-2 text-xs text-slate-500">{it.srNo || ''}</td>
                    <td className="px-4 py-2" colSpan={7}>{it.description}</td>
                  </tr>
                ) : (
                  <tr key={it.id} className="border-b border-slate-100 align-top">
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-500">{it.srNo || '—'}</td>
                    <td className="px-4 py-2 text-slate-700">{it.description}</td>
                    <td className="px-2 text-xs text-slate-500">{it.category || '—'}</td>
                    <td className="px-2 text-xs text-slate-500">{it.roomZone || '—'}</td>
                    <td className="px-2 text-xs text-slate-500">{it.makeModel || '—'}</td>
                    <td className="px-2 text-right font-medium text-navy">{fmtNum(it.plannedQty)}</td>
                    <td className="px-2 text-xs text-slate-500">{it.unit || '—'}</td>
                    <td className="max-w-[18rem] whitespace-pre-wrap px-2 text-xs text-slate-500">{it.remarks || '—'}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
