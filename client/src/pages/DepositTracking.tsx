import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Spinner } from '../components/ui';
import { fmtDate, inr } from '../lib/format';

// Global Deposit Tracking — every PO/WO line marked "💰 Deposit" across all projects,
// with its recovery: required (from the line), received back, pending, ref + status.
interface Deposit {
  lineId: string; docId: string; docNumber: string; type: string;
  projectId: string; projectName: string | null; vendorName: string | null;
  description: string; note: string | null; qty: number; unitPrice: number;
  amountRequired: number; amountReceived: number; pending: number;
  refDetails: string | null; status: string; date: string;
}

// A deposit is "received" (done → History) once its recovery status leaves HELD.
const isReceived = (d: Deposit) => d.status !== 'HELD';
// Friendly label for a recovered deposit.
const STATUS_LABEL: Record<string, string> = { REFUNDED: 'Received', ADJUSTED: 'Adjusted', HELD: 'Pending' };
const STATUS_PILL: Record<string, string> = { HELD: 'bg-amber-100 text-amber-700', REFUNDED: 'bg-green-100 text-green-700', ADJUSTED: 'bg-blue-100 text-blue-700' };

export default function DepositTracking() {
  const qc = useQueryClient();
  const { canEdit, hideFinancials } = useAuth();
  const editable = canEdit('po');
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [search, setSearch] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['deposits'],
    queryFn: async () => (await api.get('/deposits')).data as { deposits: Deposit[]; totals: { required: number; received: number; pending: number } },
  });
  const save = useMutation({
    mutationFn: async (b: { docId: string; description: string; amountReceived?: number; refDetails?: string | null; status?: string }) => api.patch('/deposits/recovery', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deposits'] }),
  });

  if (isLoading) return <div className="p-10"><Spinner label="Loading deposits…" /></div>;
  if (error) return <div className="p-10 text-rose-600">Failed to load deposits.</div>;

  const all = data?.deposits ?? [];
  const needle = search.toLowerCase().trim();
  const matches = (d: Deposit) => !needle || [d.projectName, d.vendorName, d.description, d.docNumber].some((s) => (s || '').toLowerCase().includes(needle));
  const pending = all.filter((d) => !isReceived(d)).filter(matches);
  const history = all.filter(isReceived).filter(matches);
  const rows = tab === 'pending' ? pending : history;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-navy">Deposit Tracking</h1>
        <p className="text-sm text-slate-500">Refundable / adjustable deposits paid to vendors across all projects — what's required, received back, and pending recovery.</p>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:max-w-xl">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] text-slate-500">Total deposits</div><div className="text-lg font-bold text-navy">{money(data?.totals.required)}</div></div>
        <div className="rounded-lg border border-green-200 bg-green-50 p-3"><div className="text-[11px] text-slate-500">Recovered</div><div className="text-lg font-bold text-green-700">{money(data?.totals.received)}</div></div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><div className="text-[11px] text-slate-500">Pending recovery</div><div className="text-lg font-bold text-amber-700">{money(data?.totals.pending)}</div></div>
      </div>

      {/* Pending (awaiting recovery) vs Deposit History (received / adjusted). */}
      <div className="flex gap-2 border-b border-slate-200">
        <button onClick={() => setTab('pending')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === 'pending' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Pending{pending.length ? ` (${pending.length})` : ''}</button>
        <button onClick={() => setTab('history')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === 'history' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Deposit History{history.length ? ` (${history.length})` : ''}</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-full max-w-xs text-sm" placeholder="Search project, vendor, PO/WO, item…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="text-xs text-slate-400">{rows.length} deposit(s)</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={tab === 'pending' ? 'Nothing pending' : 'No deposit history yet'} hint={tab === 'pending' ? 'Deposits awaiting recovery appear here. Open a PO/WO and click "💰 Mark as Deposit" on any line.' : 'Received / adjusted deposits will appear here.'} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-center text-xs uppercase text-slate-400">
              {tab === 'pending' ? (
                <tr><th className="px-3 py-2">PO/WO</th><th>Project</th><th>Vendor</th><th>Item</th><th>Qty</th><th>Rate</th><th>Required</th><th>Payment / Receipt</th><th>Action</th></tr>
              ) : (
                <tr><th className="px-3 py-2">PO/WO</th><th>Project</th><th>Vendor</th><th>Item</th><th>Qty</th><th>Rate</th><th>Required</th><th>Received</th><th>Payment / Receipt</th><th>Status</th>{editable && <th></th>}</tr>
              )}
            </thead>
            <tbody>
              {rows.map((d) => tab === 'pending'
                ? <PendingRow key={d.lineId} d={d} editable={editable} money={money} onReceive={(b) => save.mutate({ docId: d.docId, description: d.description, ...b })} saving={save.isPending} />
                : <HistoryRow key={d.lineId} d={d} editable={editable} money={money} onReopen={() => save.mutate({ docId: d.docId, description: d.description, status: 'HELD', amountReceived: 0 })} saving={save.isPending} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Common first cells: PO/WO (first), Project, Vendor, Item (+ qty × rate), Qty, Rate, Required.
function LeadCells({ d, money }: { d: Deposit; money: (n: number | null | undefined) => string }) {
  return (
    <>
      <td className="whitespace-nowrap px-3 py-2 text-center font-medium text-navy">{d.docNumber} <span className="text-[10px] font-normal text-slate-400">{d.type}</span></td>
      <td className="text-center text-slate-600">{d.projectName || '—'}</td>
      <td className="text-center text-slate-600">{d.vendorName || '—'}</td>
      <td className="text-center"><div className="font-medium text-slate-700">{d.description}</div>{d.note && <div className="text-[11px] text-slate-400">💰 {d.note}</div>}</td>
      <td className="text-center text-slate-600">{d.qty}</td>
      <td className="text-center text-slate-600">{money(d.unitPrice)}</td>
      <td className="text-center font-medium">{money(d.amountRequired)}</td>
    </>
  );
}

// Pending: a receipt/UTR note + a "Receive" button. Receiving marks it recovered
// (status REFUNDED, received = required) and moves it to Deposit History.
function PendingRow({ d, editable, money, onReceive, saving }: {
  d: Deposit; editable: boolean; money: (n: number | null | undefined) => string;
  onReceive: (b: { amountReceived?: number; refDetails?: string | null; status?: string }) => void; saving: boolean;
}) {
  const [ref, setRef] = useState(d.refDetails || '');
  return (
    <tr className="border-b border-slate-100 align-top hover:bg-slate-50">
      <LeadCells d={d} money={money} />
      <td className="min-w-[160px] text-center">
        {editable
          ? <input className="input h-8 text-xs" placeholder="UTR / receipt no. / note" value={ref} onChange={(e) => setRef(e.target.value)} onBlur={() => { if ((d.refDetails || '') !== ref) onReceive({ refDetails: ref || null }); }} />
          : (d.refDetails || '—')}
      </td>
      <td className="px-2 text-center">
        <div className="flex items-center justify-center gap-2">
          {editable && <button className="rounded-lg bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50" disabled={saving} onClick={() => { if (confirm(`Mark this ₹${Math.round(d.amountRequired).toLocaleString('en-IN')} deposit as received? It moves to Deposit History.`)) onReceive({ amountReceived: d.amountRequired, status: 'REFUNDED', refDetails: ref || null }); }}>✓ Receive</button>}
          <span className="badge bg-amber-100 text-amber-700">Pending</span>
        </div>
      </td>
    </tr>
  );
}

// History: a recovered deposit — received amount, ref, status, date. Editable
// users can Reopen it (back to Pending) if it was marked received by mistake.
function HistoryRow({ d, editable, money, onReopen, saving }: {
  d: Deposit; editable: boolean; money: (n: number | null | undefined) => string;
  onReopen: () => void; saving: boolean;
}) {
  return (
    <tr className="border-b border-slate-100 align-top hover:bg-slate-50">
      <LeadCells d={d} money={money} />
      <td className="text-center font-medium text-green-700">{money(d.amountReceived)}</td>
      <td className="min-w-[140px] text-center text-slate-500">{d.refDetails || '—'}{d.date && <div className="text-[10px] text-slate-400">{fmtDate(d.date)}</div>}</td>
      <td className="text-center"><span className={`badge ${STATUS_PILL[d.status] || 'bg-slate-100'}`}>{STATUS_LABEL[d.status] || d.status}</span></td>
      {editable && <td className="px-2 text-center"><button className="text-xs font-medium text-slate-500 hover:text-navy hover:underline disabled:opacity-50" disabled={saving} onClick={() => { if (confirm('Reopen this deposit? It goes back to Pending.')) onReopen(); }}>↻ Reopen</button></td>}
    </tr>
  );
}
