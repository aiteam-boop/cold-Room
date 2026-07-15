// ── BOQ & Budget (BOQ & Budget PRD v1 §3) ────────────────────────────────────
// The internal costing the bid was built on — one line per BOQ item, grouped by
// category so it can be costed category-by-category and still compared to POs
// line-by-line.
//
// Once FROZEN it is read-only for everyone and becomes the benchmark every PO is
// measured against (see the Budget / Variance columns on BOQ Cost).
//
// This is INTERNAL. It never appears on a vendor-facing PO.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { inr } from '../../lib/format';

interface Row {
  boqItemId: string; srNo?: string | null; description: string;
  category: string; roomZone?: string | null; unit?: string | null;
  plannedQty: number;
  budgetQty: number | null; budgetRate: number | null; budgetAmount: number | null;
  notes: string | null;
}
interface Budget {
  status: string; frozen: boolean;
  frozenAt: string | null; frozenBy: { name: string; email: string } | null;
  contingencyPct: number;
  rows: Row[];
  totals: { subtotal: number; contingencyPct: number; contingency: number; total: number; linesCosted: number; linesTotal: number };
}

export default function BudgetView({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { can, isAdmin } = useAuth();
  const canEdit = can('canEditBudget');
  const canFreeze = can('canFreezeBudget');
  const [msg, setMsg] = useState('');

  const q = useQuery({
    queryKey: ['budget', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/budget`)).data as Budget,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['budget', projectId] });
    // The variance on BOQ Cost is derived from this — keep it in step.
    qc.invalidateQueries({ queryKey: ['boq-cost', projectId] });
  };

  const saveLine = useMutation({
    mutationFn: (v: { boqItemId: string; budgetQty?: number | null; budgetRate?: number | null; notes?: string | null }) =>
      api.patch(`/projects/${projectId}/budget/lines/${v.boqItemId}`, v),
    onSuccess: () => { setMsg(''); refresh(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const saveContingency = useMutation({
    mutationFn: (pct: number) => api.patch(`/projects/${projectId}/budget/settings`, { contingencyPct: pct }),
    onSuccess: () => { setMsg(''); refresh(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const freeze = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/budget/freeze`),
    onSuccess: () => { setMsg('Budget frozen. It is now the benchmark for every PO on this project.'); refresh(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const unfreeze = useMutation({
    mutationFn: (reason: string) => api.post(`/projects/${projectId}/budget/unfreeze`, { reason }),
    onSuccess: () => { setMsg('Budget unfrozen — this is logged.'); refresh(); },
    onError: (e) => setMsg(errMsg(e)),
  });

  if (q.isLoading) return <Spinner label="Loading budget…" />;
  if (q.error) return <div className="card p-6 text-red-600">{errMsg(q.error)}</div>;
  const b = q.data!;
  const editable = !b.frozen && canEdit;

  if (b.rows.length === 0) {
    return <EmptyState title="No BOQ items yet" hint="Import or add the BOQ first — the budget is costed against those lines." />;
  }

  // Costed category by category, compared line by line (PRD OQ-7).
  const groups = b.rows.reduce<Record<string, Row[]>>((m, r) => { (m[r.category] ??= []).push(r); return m; }, {});
  const catTotal = (rows: Row[]) => rows.reduce((s, r) => s + (r.budgetAmount ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-slate-600">
            BOQ &amp; Budget
            <span className={`badge ml-2 ${b.frozen ? 'bg-navy/10 text-navy' : 'bg-amber-100 text-amber-700'}`}>
              {b.frozen ? '🔒 Frozen' : 'Draft'}
            </span>
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {b.frozen
              ? <>Locked{b.frozenBy ? ` by ${b.frozenBy.name}` : ''}{b.frozenAt ? ` on ${new Date(b.frozenAt).toLocaleString('en-GB')}` : ''}. Every PO is measured against these numbers. Internal only — never shown on a vendor PO.</>
              : <>The internal costing the bid was built on. Freeze it once it is final — after that nobody can change it.</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!b.frozen && canFreeze && (
            <button className="btn-primary text-sm" disabled={freeze.isPending || b.totals.linesCosted === 0}
              title={b.totals.linesCosted === 0 ? 'Enter at least one rate first' : ''}
              onClick={() => { if (window.confirm(`Freeze this budget at ${inr(b.totals.total)}?\n\nNobody will be able to change it afterwards — it can only grow through a Change Order.`)) freeze.mutate(); }}>
              🔒 Freeze Budget
            </button>
          )}
          {b.frozen && isAdmin && (
            <button className="btn-outline text-sm" disabled={unfreeze.isPending}
              onClick={() => { const r = window.prompt('Unfreezing a frozen budget is logged. Why is this needed?'); if (r && r.trim().length >= 5) unfreeze.mutate(r.trim()); }}>
              Unfreeze (admin)
            </button>
          )}
        </div>
      </div>

      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}
      {!b.frozen && !canEdit && (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">You can view this budget but not edit it. Ask an admin for the “Can enter the BOQ budget” permission.</div>
      )}

      {/* Totals — the number that gets frozen is the one at the far right. */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Lines costed" value={`${b.totals.linesCosted} / ${b.totals.linesTotal}`} />
        <Stat label="Subtotal" value={inr(b.totals.subtotal)} />
        <div className="card p-3">
          <div className="text-[11px] uppercase tracking-wide text-slate-400">Contingency</div>
          <div className="mt-1 flex items-center gap-1.5">
            <input
              className="input h-8 w-16 text-sm" type="number" min={0} max={100} step={0.5}
              disabled={!editable}
              defaultValue={b.contingencyPct}
              onBlur={(e) => { const v = Number(e.target.value); if (v !== b.contingencyPct && v >= 0 && v <= 100) saveContingency.mutate(v); }}
            />
            <span className="text-sm text-slate-400">%</span>
            <span className="ml-auto text-sm font-medium text-slate-700">{inr(b.totals.contingency)}</span>
          </div>
        </div>
        <div className="card border-navy/20 bg-navy/5 p-3">
          <div className="text-[11px] uppercase tracking-wide text-navy/60">Budget Total {b.frozen && '(frozen)'}</div>
          <div className="mt-1 text-xl font-bold text-navy">{inr(b.totals.total)}</div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2">Sr</th>
                <th className="px-2">Description</th>
                <th className="px-2">Room / Zone</th>
                <th className="px-2">Unit</th>
                <th className="px-2 text-right">BOQ Qty</th>
                <th className="px-2 text-right">Budget Qty</th>
                <th className="px-2 text-right">Budget Rate</th>
                <th className="px-2 text-right">Budget Amount</th>
                <th className="px-2">Basis / Notes</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(groups).map(([cat, rows]) => (
                <>
                  <tr key={`h-${cat}`} className="border-y border-slate-200 bg-slate-50/70">
                    <td className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500" colSpan={7}>{cat}</td>
                    <td className="px-2 py-1.5 text-right text-xs font-bold text-slate-700">{inr(catTotal(rows))}</td>
                    <td />
                  </tr>
                  {rows.map((r) => (
                    <BudgetRow key={r.boqItemId} r={r} editable={editable} onSave={(v) => saveLine.mutate({ boqItemId: r.boqItemId, ...v })} />
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-700">{value}</div>
    </div>
  );
}

// One BOQ line. Qty defaults to the BOQ quantity server-side, so in practice the
// only thing that has to be typed is the RATE — 150 lines stay bearable.
function BudgetRow({ r, editable, onSave }: {
  r: Row; editable: boolean;
  onSave: (v: { budgetQty?: number | null; budgetRate?: number | null; notes?: string | null }) => void;
}) {
  const [qty, setQty] = useState<string>(r.budgetQty != null ? String(r.budgetQty) : '');
  const [rate, setRate] = useState<string>(r.budgetRate != null ? String(r.budgetRate) : '');
  const [notes, setNotes] = useState<string>(r.notes ?? '');

  // Show the amount the user is about to get, before the server round-trips.
  const liveQty = qty === '' ? r.plannedQty : Number(qty);
  const liveRate = rate === '' ? null : Number(rate);
  const liveAmount = liveRate == null || !isFinite(liveQty) ? null : Math.round(liveQty * liveRate * 100) / 100;

  const commitQty = () => { const v = qty === '' ? null : Number(qty); if (v !== r.budgetQty) onSave({ budgetQty: v }); };
  const commitRate = () => { const v = rate === '' ? null : Number(rate); if (v !== r.budgetRate) onSave({ budgetRate: v }); };
  const commitNotes = () => { const v = notes.trim() || null; if (v !== r.notes) onSave({ notes: v }); };

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50/60">
      <td className="px-3 py-1 text-xs text-slate-400">{r.srNo || '—'}</td>
      <td className="px-2 py-1 text-xs text-slate-700">{r.description}</td>
      <td className="px-2 text-xs text-slate-500">{r.roomZone || '—'}</td>
      <td className="px-2 text-xs text-slate-500">{r.unit || '—'}</td>
      <td className="px-2 text-right text-xs text-slate-400">{r.plannedQty}</td>
      <td className="px-2 py-0.5 text-right">
        {editable
          ? <input className="input h-7 w-20 text-right text-xs" type="number" placeholder={String(r.plannedQty)} value={qty} onChange={(e) => setQty(e.target.value)} onBlur={commitQty} />
          : <span className="text-xs">{r.budgetQty ?? r.plannedQty}</span>}
      </td>
      <td className="px-2 py-0.5 text-right">
        {editable
          ? <input className="input h-7 w-24 text-right text-xs" type="number" placeholder="rate" value={rate} onChange={(e) => setRate(e.target.value)} onBlur={commitRate} />
          : <span className="text-xs">{r.budgetRate != null ? inr(r.budgetRate) : '—'}</span>}
      </td>
      <td className="px-2 text-right text-xs font-medium text-slate-800">
        {liveAmount != null ? inr(liveAmount) : <span className="text-slate-300">—</span>}
      </td>
      <td className="px-2 py-0.5">
        {editable
          ? <input className="input h-7 w-full text-xs" placeholder="e.g. Bitzer quote Jun-26" value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={commitNotes} />
          : <span className="text-xs text-slate-400">{r.notes || '—'}</span>}
      </td>
    </tr>
  );
}
