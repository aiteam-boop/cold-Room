// ── Vendor quotation comparison & award (BOQ & Budget PRD v1 §4 + §6a) ─────────
// Opened per BOQ item from the BOQ Cost view. Collect 3+ quotes, compare them
// side by side (L1 = cheapest, marked automatically), and AWARD one — the cheapest
// is NOT automatically the winner, so a non-L1 award needs a reason, and awarding
// below 3 quotes is blocked unless an override reason is given.
//
// The "History" tab is the same data pivoted the other way (§6a): every price ever
// quoted for this item, across projects, so the buyer knows a fair price.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Spinner } from '../ui';
import { inr, fmtDate } from '../../lib/format';

interface Quote {
  id: string; vendorId: string | null; vendorName: string; price: number;
  deliveryDate: string | null; deliveryWeeks: number | null; leadTimeText: string | null; paymentTerms: string | null;
  qualityRemarks: string | null; modelNumber: string | null; quotationPdfUrl: string | null; tdsUrl: string | null;
  revision: number; status: string; rank: string;
}

// Common payment-term presets — dropdown AND typing (PRD §6.1).
const PAYMENT_PRESETS = ['100% Advance', '50% Advance, 50% on Delivery', '30% Advance, 70% on Delivery', '25% Advance, 75% on Delivery', '20% Advance, 80% on Delivery', 'Against Delivery', '30 Days Credit', '45 Days Credit'];
interface Data {
  item: { id: string; description: string; unit: string | null; plannedQty: number; budgetAmount: number | null; awardedQuotationId: string | null; awardReason: string | null; awardedAt: string | null };
  quotes: Quote[]; activeCount: number; minQuotes: number;
}

export default function QuotationModal({ projectId, boqItemId, onClose }: { projectId: string; boqItemId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const editable = canEdit('vendors');
  const [tab, setTab] = useState<'compare' | 'history'>('compare');
  const [msg, setMsg] = useState('');

  const q = useQuery({
    queryKey: ['quotes', projectId, boqItemId],
    queryFn: async () => (await api.get(`/projects/${projectId}/quotations/item/${boqItemId}`)).data as Data,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['quotes', projectId, boqItemId] });
    qc.invalidateQueries({ queryKey: ['boq-cost', projectId] });
  };

  const addQuote = useMutation({
    mutationFn: (body: any) => api.post(`/projects/${projectId}/quotations/item/${boqItemId}`, body),
    onSuccess: () => { setMsg(''); refresh(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/projects/${projectId}/quotations/${id}`), onSuccess: () => { setMsg(''); refresh(); }, onError: (e) => setMsg(errMsg(e)) });
  const uploadPdf = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/quotations/${id}/file`, fd); },
    onSuccess: () => refresh(), onError: (e) => setMsg(errMsg(e)),
  });
  const award = useMutation({
    mutationFn: (body: { quotationId: string; reason?: string; overrideReason?: string }) => api.post(`/projects/${projectId}/quotations/item/${boqItemId}/award`, body),
    onSuccess: () => { setMsg('Awarded.'); refresh(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const unaward = useMutation({ mutationFn: () => api.post(`/projects/${projectId}/quotations/item/${boqItemId}/unaward`), onSuccess: () => { setMsg(''); refresh(); }, onError: (e) => setMsg(errMsg(e)) });

  // Award flow, mirroring the server rules (block <3 → override reason; non-L1 → reason).
  const doAward = (quote: Quote, active: number, minQuotes: number) => {
    let overrideReason: string | undefined;
    if (active < minQuotes) {
      const r = window.prompt(`Only ${active} quote(s) — ${minQuotes} are expected before an award.\nGive a reason to override (e.g. single-source vendor):`);
      if (!r?.trim()) return;
      overrideReason = r.trim();
    }
    let reason: string | undefined;
    if (quote.rank !== 'L1') {
      const r = window.prompt('This is not the lowest (L1) quote. Why award it? (required)\ne.g. faster delivery, better payment terms, quality');
      if (!r?.trim()) return;
      reason = r.trim();
    } else {
      const r = window.prompt('Award to the lowest quote. Add a note (optional):') ?? '';
      reason = r.trim() || undefined;
    }
    award.mutate({ quotationId: quote.id, reason, overrideReason });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(5,35,121,0.34)] p-6" onClick={onClose}>
      <div className="w-full max-w-5xl rounded-lg bg-white shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-lg font-bold text-navy">Vendor Quotations</h3>
            <p className="text-sm text-slate-500">{q.data?.item.description}</p>
          </div>
          <button className="text-2xl leading-none text-slate-400 hover:text-slate-600" onClick={onClose}>×</button>
        </div>

        <div className="flex gap-1 border-b border-slate-200 px-5 pt-3 text-sm">
          <button className={`rounded-t-md px-3 py-1.5 font-medium ${tab === 'compare' ? 'bg-slate-100 text-navy' : 'text-slate-500'}`} onClick={() => setTab('compare')}>Compare &amp; Award</button>
          <button className={`rounded-t-md px-3 py-1.5 font-medium ${tab === 'history' ? 'bg-slate-100 text-navy' : 'text-slate-500'}`} onClick={() => setTab('history')}>Price History</button>
        </div>

        {q.isLoading ? <div className="p-6"><Spinner label="Loading…" /></div> : q.error ? <div className="p-6 text-red-600">{errMsg(q.error)}</div> : (
          <div className="p-5">
            {msg && <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}
            {tab === 'compare' ? (
              <CompareTab d={q.data!} editable={editable} onAdd={(b) => addQuote.mutate(b)} onDelete={(id) => del.mutate(id)}
                onUpload={(id, f) => uploadPdf.mutate({ id, file: f })} onAward={doAward} onUnaward={() => unaward.mutate()}
                busy={addQuote.isPending || award.isPending} />
            ) : (
              <HistoryTab projectId={projectId} boqItemId={boqItemId} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CompareTab({ d, editable, onAdd, onDelete, onUpload, onAward, onUnaward, busy }: {
  d: Data; editable: boolean;
  onAdd: (b: any) => void; onDelete: (id: string) => void; onUpload: (id: string, f: File) => void;
  onAward: (q: Quote, active: number, min: number) => void; onUnaward: () => void; busy: boolean;
}) {
  const active = d.quotes.filter((q) => q.status !== 'SUPERSEDED');
  const money = (n: number | null | undefined) => (n == null ? '—' : inr(n));

  return (
    <div className="space-y-4">
      {/* Budget context — what the award is being measured against. */}
      <div className="flex flex-wrap gap-4 rounded-lg bg-slate-50 px-3 py-2 text-sm">
        <span className="text-slate-500">Unit <b className="text-slate-700">{d.item.unit || '—'}</b></span>
        <span className="text-slate-500">BOQ Qty <b className="text-slate-700">{d.item.plannedQty}</b></span>
        <span className="text-slate-500">Frozen Budget <b className="text-slate-700">{money(d.item.budgetAmount)}</b></span>
        <span className={`ml-auto ${active.length >= d.minQuotes ? 'text-green-700' : 'text-amber-600'}`}>{active.length} / {d.minQuotes} quotes</span>
      </div>

      {active.length < d.minQuotes && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          ⚠ {d.minQuotes} quotations are expected before awarding. You can still award below that with an override reason (e.g. single-source).
        </div>
      )}

      {d.item.awardedQuotationId && (
        <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          <div>
            ✓ Awarded to <b>{active.find((q) => q.id === d.item.awardedQuotationId)?.vendorName}</b>
            {d.item.awardReason && <span className="text-green-700"> — {d.item.awardReason}</span>}
          </div>
          {editable && <button className="text-xs font-medium text-green-700 hover:underline" onClick={onUnaward}>Clear award</button>}
        </div>
      )}

      {/* Side-by-side comparison. L1 = cheapest (green), L2 next. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-400">
            <tr>
              <th className="py-1">Vendor</th>
              <th>Model No.</th>
              <th className="text-right">Quoted Price</th>
              <th>Delivery</th>
              <th>Payment Terms</th>
              <th>Quality / Remarks</th>
              <th>Files</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {active.length === 0 && <tr><td colSpan={7} className="py-3 text-xs italic text-slate-400">No quotations yet. Add at least {d.minQuotes} to compare.</td></tr>}
            {active.map((qt) => {
              const awarded = qt.id === d.item.awardedQuotationId;
              return (
                <tr key={qt.id} className={`border-t border-slate-100 ${awarded ? 'bg-green-50/50' : ''}`}>
                  <td className="py-1.5">
                    <span className="font-medium text-slate-700">{qt.vendorName}</span>
                    {qt.rank && <span className={`badge ml-1 ${qt.rank === 'L1' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{qt.rank}</span>}
                    {qt.revision > 1 && <span className="ml-1 text-[10px] text-slate-400">rev {qt.revision}</span>}
                  </td>
                  <td className="text-xs text-slate-500">{qt.modelNumber || '—'}</td>
                  <td className="text-right font-medium text-slate-800">{money(qt.price)}</td>
                  {/* Delivery in weeks (§6.2), falling back to a date / free text. */}
                  <td className="text-xs text-slate-500">{qt.deliveryWeeks != null ? `${qt.deliveryWeeks} wk` : qt.deliveryDate ? fmtDate(qt.deliveryDate) : qt.leadTimeText || '—'}</td>
                  <td className="text-xs text-slate-500">{qt.paymentTerms || '—'}</td>
                  <td className="max-w-[14rem] text-xs text-slate-500">{qt.qualityRemarks || '—'}</td>
                  <td className="whitespace-nowrap">
                    {qt.quotationPdfUrl
                      ? <a className="text-xs font-medium text-navy hover:underline" href={qt.quotationPdfUrl} target="_blank" rel="noreferrer" title="Quotation">📄 Quote</a>
                      : editable ? <label className="cursor-pointer text-xs text-slate-400 hover:text-navy" title="Attach quotation">＋Quote<input type="file" className="hidden" accept=".pdf,image/*" onChange={(e) => e.target.files?.[0] && onUpload(qt.id, e.target.files[0])} /></label> : '—'}
                    {qt.tdsUrl && <a className="ml-2 text-xs font-medium text-navy hover:underline" href={qt.tdsUrl} target="_blank" rel="noreferrer" title="Vendor TDS">📄 TDS</a>}
                  </td>
                  {editable && (
                    <td className="whitespace-nowrap text-right">
                      {!awarded && <button className="text-xs font-medium text-navy hover:underline disabled:opacity-40" disabled={busy} onClick={() => onAward(qt, active.length, d.minQuotes)}>Award</button>}
                      <button className="ml-2 text-xs text-slate-300 hover:text-red-500" title="Delete" onClick={() => onDelete(qt.id)}>✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editable && <AddQuoteForm onAdd={onAdd} />}
    </div>
  );
}

function AddQuoteForm({ onAdd }: { onAdd: (b: any) => void }) {
  const [f, setF] = useState({ vendorName: '', modelNumber: '', price: '', deliveryWeeks: '', paymentTerms: '', qualityRemarks: '' });
  const set = (p: any) => setF((s) => ({ ...s, ...p }));
  const submit = () => {
    if (!f.vendorName.trim() || !f.price) return;
    onAdd({
      vendorName: f.vendorName.trim(), modelNumber: f.modelNumber.trim() || null, price: Number(f.price),
      deliveryWeeks: f.deliveryWeeks === '' ? null : Number(f.deliveryWeeks),
      paymentTerms: f.paymentTerms || null, qualityRemarks: f.qualityRemarks || null,
    });
    setF({ vendorName: '', modelNumber: '', price: '', deliveryWeeks: '', paymentTerms: '', qualityRemarks: '' });
  };
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Add a quotation</div>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <input className="input h-8 text-xs" placeholder="Vendor name *" value={f.vendorName} onChange={(e) => set({ vendorName: e.target.value })} />
        {/* Each vendor quotes their OWN model number (§6). */}
        <input className="input h-8 text-xs" placeholder="Vendor model no." value={f.modelNumber} onChange={(e) => set({ modelNumber: e.target.value })} />
        <input className="input h-8 text-xs" type="number" placeholder="Price *" value={f.price} onChange={(e) => set({ price: e.target.value })} />
        {/* Delivery in WEEKS, not a date (§6.2). */}
        <input className="input h-8 text-xs" type="number" min={0} placeholder="Delivery (weeks)" value={f.deliveryWeeks} onChange={(e) => set({ deliveryWeeks: e.target.value })} />
        {/* Payment terms — dropdown preset AND free typing (§6.1). */}
        <input className="input h-8 text-xs" list="pay-presets" placeholder="Payment terms" value={f.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} />
        <datalist id="pay-presets">{PAYMENT_PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
        <input className="input h-8 text-xs" placeholder="Quality / remarks" value={f.qualityRemarks} onChange={(e) => set({ qualityRemarks: e.target.value })} />
      </div>
      <button className="btn-primary mt-2 text-xs" disabled={!f.vendorName.trim() || !f.price} onClick={submit}>+ Add quote</button>
    </div>
  );
}

// §6a — every price ever quoted for this item, across projects.
function HistoryTab({ projectId, boqItemId }: { projectId: string; boqItemId: string }) {
  const h = useQuery({
    queryKey: ['quote-history', projectId, boqItemId],
    queryFn: async () => (await api.get(`/projects/${projectId}/quotations/history`, { params: { boqItemId } })).data as {
      description: string; history: { id: string; vendorName: string; price: number; createdAt: string; paymentTerms: string | null; projectName: string | null; awarded: boolean }[];
    },
  });
  if (h.isLoading) return <Spinner label="Loading history…" />;
  const rows = h.data?.history ?? [];
  const money = (n: number) => inr(n);
  return (
    <div>
      <p className="mb-3 text-xs text-slate-400">Every price quoted for “{h.data?.description?.slice(0, 60)}”, across all projects — so you know a fair price before you ask.</p>
      {rows.length === 0 ? <div className="text-sm text-slate-400">No quotation history for this item yet.</div> : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">Vendor</th><th className="text-right">Price</th><th>Date</th><th>Project</th><th>Payment</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-1.5 text-slate-700">{r.vendorName}{r.awarded && <span className="badge ml-1 bg-green-100 text-green-700">awarded</span>}</td>
                <td className="text-right font-medium text-slate-800">{money(r.price)}</td>
                <td className="text-xs text-slate-500">{fmtDate(r.createdAt)}</td>
                <td className="text-xs text-slate-500">{r.projectName || '—'}</td>
                <td className="text-xs text-slate-500">{r.paymentTerms || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
