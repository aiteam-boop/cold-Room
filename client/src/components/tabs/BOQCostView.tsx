import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, downloadFile, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, KPI, Spinner } from '../ui';
import { fmtNum, inr } from '../../lib/format';

// The BOQ Cost sheet (Sprint PRD §6): the same BOQ rows as the Progress view,
// with the financial columns layered on. Read-only — the money comes from
// approved POs, never from data entry here.
//
// Deviation from the PRD's column table, at the client's request: Planned Qty
// and Installed Qty are KEPT in this view rather than hidden, so the cost sheet
// can be read against physical progress without switching tabs.

const PAY_PILL: Record<string, string> = {
  Paid: 'bg-green-100 text-green-700',
  Partial: 'bg-blue-100 text-blue-700',
  Advance: 'bg-amber-100 text-amber-700',
  Pending: 'bg-slate-100 text-slate-600',
};

const RECEIPT_PILL: Record<string, string> = {
  Received: 'bg-green-100 text-green-700',
  'Partially Received': 'bg-blue-100 text-blue-700',
  'Awaiting GRN': 'bg-amber-100 text-amber-700',
  'Not Received': 'bg-slate-100 text-slate-600',
};

interface CostGRN {
  grnId: string; grnNumber: string; grnDate: string; status: string;
  invoiceNumber: string | null; invoiceValue: number | null; invoicePdfUrl: string | null; grnPdfUrl: string;
}
interface CostPO {
  poLineId: string; docId: string; docNumber: string; docType: string; vendorName: string | null;
  qtyOrdered: number; unitPrice: number | null; totalCost: number | null;
  advancePaid: number | null; balancePending: number | null; paymentStatus: string;
  qtyReceived: number; receiptStatus: string; grns: CostGRN[];
  deliveryStatus: string; deliveryDelayDays: number | null;
}
interface CostItem {
  id: string; srNo: string | null; description: string; category: string | null; roomZone: string | null;
  unit: string | null; makeModel: string | null; plannedQty: number; installedQty: number;
  linkedPOIds: string[]; totalOrderedQty: number;
  totalOrderedCost: number | null; totalAdvancePaid: number | null; totalBalancePending: number | null;
  paymentStatus: string; totalReceivedQty: number; receiptStatus: string; pos: CostPO[];
}
interface CostSheet {
  items: CostItem[];
  unlinked: (CostPO & { description: string; uom: string | null; docStatus: string })[];
  summary: { itemsWithPO: number; itemsWithoutPO: number; unlinkedPOLines: number; grandTotalCost: number | null; grandAdvancePaid: number | null; grandBalancePending: number | null };
}

export default function BOQCostView({ projectId }: { projectId: string }) {
  const { hideFinancials } = useAuth();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [onlyWithPO, setOnlyWithPO] = useState(false);

  // Server strips every ₹ for hideFinancials users; this renders a dash rather
  // than a misleading ₹0 and prevents a flash of real values.
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));

  const { data, isLoading } = useQuery({
    queryKey: ['boq-cost', projectId],
    queryFn: async () => (await api.get(`/projects/${projectId}/boq/cost`)).data as CostSheet,
  });

  const rows = useMemo(
    () => (data?.items ?? []).filter((i) => !onlyWithPO || i.pos.length > 0),
    [data, onlyWithPO]
  );

  if (isLoading || !data) return <Spinner label="Loading cost sheet…" />;
  if (data.items.length === 0) return <EmptyState title="No BOQ items yet" hint="Import the BOQ first — the cost sheet is a financial lens over the same rows." />;

  const { summary, unlinked } = data;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KPI label="Total Ordered Cost" value={money(summary.grandTotalCost)} />
        <KPI label="Advance Paid" value={money(summary.grandAdvancePaid)} accent="#d97706" />
        <KPI label="Balance Pending" value={money(summary.grandBalancePending)} accent="#dc2626" />
        <KPI label="Items with a PO" value={`${summary.itemsWithPO} / ${data.items.length}`} sub={summary.itemsWithoutPO ? `${summary.itemsWithoutPO} not yet ordered` : undefined} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={onlyWithPO} onChange={(e) => setOnlyWithPO(e.target.checked)} />
          Only items with a linked PO
        </label>
        {!hideFinancials && (
          <button className="btn-outline text-sm" onClick={() => downloadFile(`/projects/${projectId}/boq/cost/export`, 'BOQ-Cost.xlsx')}>
            ⬇ Export Excel
          </button>
        )}
      </div>

      {hideFinancials && (
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">
          Pricing is hidden for your role. Quantity columns are shown in full.
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1400px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="px-2 py-2">Sr.No</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-2">Room/Zone</th>
                <th className="px-2">Make &amp; Model</th>
                <th className="px-2">Unit</th>
                <th className="px-2 text-right">Planned</th>
                <th className="px-2 text-right">Installed</th>
                <th className="px-2">PO Number(s)</th>
                <th className="px-2">Vendor</th>
                <th className="px-2 text-right">Qty Ordered</th>
                <th className="px-2 text-right">Unit Price</th>
                <th className="px-2 text-right">Total Cost</th>
                <th className="px-2 text-right">Advance Paid</th>
                <th className="px-2 text-right">Balance</th>
                <th className="px-2">Payment</th>
                <th className="px-2 text-right">Received</th>
                <th className="px-2">GRN &amp; Invoice</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                // A single-PO item reads inline; multi-PO items get sub-rows so
                // "copper piping ordered in 2 batches" is legible.
                const multi = it.pos.length > 1;
                const only = it.pos[0];
                const open = !!expanded[it.id];
                const vendors = [...new Set(it.pos.map((p) => p.vendorName).filter(Boolean))];
                return (
                  <FragmentRow key={it.id}>
                    <tr className={`border-b border-slate-100 align-top ${multi ? 'cursor-pointer hover:bg-slate-50' : ''}`} onClick={() => multi && setExpanded((c) => ({ ...c, [it.id]: !c[it.id] }))}>
                      <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-500">{it.srNo || '—'}</td>
                      <td className="px-3 py-2 text-slate-700">
                        {multi && <span className="mr-1 inline-block w-3 text-slate-400">{open ? '▼' : '▶'}</span>}
                        {it.description}
                      </td>
                      <td className="px-2 text-xs text-slate-500">{it.roomZone || '—'}</td>
                      <td className="px-2 text-xs text-slate-500">{it.makeModel || '—'}</td>
                      <td className="px-2 text-xs text-slate-500">{it.unit || '—'}</td>
                      <td className="px-2 text-right">{fmtNum(it.plannedQty)}</td>
                      <td className="px-2 text-right text-navy">{fmtNum(it.installedQty)}</td>

                      {it.pos.length === 0 ? (
                        <td className="px-2 text-xs italic text-slate-400" colSpan={9}>No PO raised yet</td>
                      ) : (
                        <>
                          <td className="px-2 text-xs font-medium text-navy">{multi ? `${it.pos.length} POs` : only.docNumber}</td>
                          <td className="px-2 text-xs text-slate-500">{vendors.length > 1 ? `${vendors.length} vendors` : vendors[0] || '—'}</td>
                          <td className="px-2 text-right">{fmtNum(it.totalOrderedQty)}</td>
                          <td className="px-2 text-right">{multi ? <span className="text-xs text-slate-400">varies</span> : money(only.unitPrice)}</td>
                          <td className="px-2 text-right font-medium">{money(it.totalOrderedCost)}</td>
                          <td className="px-2 text-right">{money(it.totalAdvancePaid)}</td>
                          <td className="px-2 text-right">{money(it.totalBalancePending)}</td>
                          <td className="px-2"><span className={`badge ${PAY_PILL[it.paymentStatus]}`}>{it.paymentStatus}</span></td>
                          <td className="px-2 text-right">
                            <div>{fmtNum(it.totalReceivedQty)}</div>
                            <span className={`badge mt-0.5 ${RECEIPT_PILL[it.receiptStatus]}`}>{it.receiptStatus}</span>
                          </td>
                          <td className="px-2"><GrnCell pos={it.pos} money={money} /></td>
                        </>
                      )}
                    </tr>

                    {multi && open && it.pos.map((p) => (
                      <tr key={p.poLineId} className="border-b border-slate-50 bg-slate-50/60 text-xs">
                        <td />
                        <td className="px-3 py-1.5 pl-8 text-slate-500">↳ {p.docNumber} <span className="badge bg-slate-200 text-slate-600">{p.docType}</span></td>
                        <td colSpan={5} />
                        <td className="px-2 font-medium text-navy">{p.docNumber}</td>
                        <td className="px-2 text-slate-500">{p.vendorName || '—'}</td>
                        <td className="px-2 text-right">{fmtNum(p.qtyOrdered)}</td>
                        <td className="px-2 text-right">{money(p.unitPrice)}</td>
                        <td className="px-2 text-right">{money(p.totalCost)}</td>
                        <td className="px-2 text-right">{money(p.advancePaid)}</td>
                        <td className="px-2 text-right">{money(p.balancePending)}</td>
                        <td className="px-2"><span className={`badge ${PAY_PILL[p.paymentStatus]}`}>{p.paymentStatus}</span></td>
                        <td className="px-2 text-right">
                          <div>{fmtNum(p.qtyReceived)}</div>
                          <span className={`badge mt-0.5 ${RECEIPT_PILL[p.receiptStatus]}`}>{p.receiptStatus}</span>
                        </td>
                        <td className="px-2"><GrnCell pos={[p]} money={money} /></td>
                      </tr>
                    ))}
                  </FragmentRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* PO lines that were never linked back to a BOQ item (PRD §6.3). */}
      {unlinked.length > 0 && (
        <div className="card p-4">
          <div className="mb-1 text-sm font-semibold text-amber-700">Unlinked PO lines ({unlinked.length})</div>
          <p className="mb-3 text-xs text-slate-500">These PO lines are not linked to a BOQ item, so their cost is missing from the sheet above. Open the PO and pick a BOQ item on each line.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-400"><tr><th className="py-1">PO</th><th>Status</th><th>Vendor</th><th>Description</th><th className="text-right">Qty</th><th className="text-right">Unit Price</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {unlinked.map((u) => (
                  <tr key={u.poLineId} className="border-t border-slate-100">
                    <td className="py-1.5 font-medium text-navy">{u.docNumber}</td>
                    <td><span className="badge bg-slate-100 text-slate-600">{u.docStatus}</span></td>
                    <td className="text-xs text-slate-500">{u.vendorName || '—'}</td>
                    <td className="max-w-[22rem] truncate text-xs text-slate-600">{u.description || '—'}</td>
                    <td className="text-right">{fmtNum(u.qtyOrdered)}</td>
                    <td className="text-right">{money(u.unitPrice)}</td>
                    <td className="text-right">{money(u.totalCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// <tbody> children must be <tr>; a plain fragment lets an item emit its main row
// plus its PO sub-rows without an illegal wrapper element.
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

// "GRN yahin pe aana chahiye agar approve hua hai aur saath-saath mein agar uske
// related koi invoice upload hua hai to uska invoice dikhna chahiye yahin par hi."
//
// A GRN belongs to the PO, not to one PO line, so an item covered by two POs
// shows both sets. Only APPROVED GRNs are rendered as receipts; a draft or
// pending one is shown greyed, because material is not received until it is.
function GrnCell({ pos, money }: { pos: CostPO[]; money: (n: number | null | undefined) => string }) {
  // GRN PDFs are generated behind the API (bearer token required); uploaded
  // invoices are static files under /uploads.
  const openFile = (url: string) =>
    url.startsWith('/api/') ? openAuthedFile(url.replace(/^\/api/, '')) : window.open(url, '_blank');

  const grns = pos.flatMap((p) => p.grns);
  const seen = new Set<string>();
  const unique = grns.filter((g) => (seen.has(g.grnId) ? false : (seen.add(g.grnId), true)));
  if (unique.length === 0) return <span className="text-xs italic text-slate-400">No GRN</span>;

  return (
    <div className="space-y-1">
      {unique.map((g) => {
        const approved = g.status === 'APPROVED';
        return (
          <div key={g.grnId} className="text-xs leading-tight">
            <button
              className={`font-medium ${approved ? 'text-navy hover:underline' : 'text-slate-400'}`}
              title={approved ? 'Open the GRN PDF' : `GRN is ${g.status.toLowerCase()} — not a receipt yet`}
              onClick={() => approved && openFile(g.grnPdfUrl)}
            >
              {g.grnNumber}
            </button>
            {!approved && <span className="ml-1 badge bg-slate-100 text-slate-500">{g.status}</span>}
            {g.invoiceNumber && (
              <div className="text-slate-500">
                {g.invoicePdfUrl ? (
                  <button className="text-slate-600 hover:underline" onClick={() => openFile(g.invoicePdfUrl!)}>
                    🧾 {g.invoiceNumber}
                  </button>
                ) : (
                  <span>🧾 {g.invoiceNumber}</span>
                )}
                {g.invoiceValue != null && <span className="ml-1 text-slate-400">{money(g.invoiceValue)}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
