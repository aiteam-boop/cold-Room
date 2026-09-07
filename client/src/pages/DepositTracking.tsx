import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Spinner } from '../components/ui';
import { inr } from '../lib/format';

// Global Deposit Tracking — every PO/WO line marked "💰 Deposit" across all projects,
// with its recovery: required (from the line), received back, pending, ref + status.
interface Deposit {
  lineId: string; docId: string; docNumber: string; type: string;
  projectId: string; projectName: string | null; vendorName: string | null;
  description: string; note: string | null; qty: number; unitPrice: number;
  amountRequired: number; amountReceived: number; pending: number;
  refDetails: string | null; status: string; date: string;
}

const STATUSES = ['HELD', 'REFUNDED', 'ADJUSTED'] as const;
const STATUS_PILL: Record<string, string> = { HELD: 'bg-amber-100 text-amber-700', REFUNDED: 'bg-green-100 text-green-700', ADJUSTED: 'bg-blue-100 text-blue-700' };

export default function DepositTracking() {
  const qc = useQueryClient();
  const { canEdit, hideFinancials } = useAuth();
  const editable = canEdit('po');
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

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
  const rows = all.filter((d) =>
    (!needle || [d.projectName, d.vendorName, d.description, d.docNumber].some((s) => (s || '').toLowerCase().includes(needle)))
    && (!statusFilter || d.status === statusFilter));

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

      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-full max-w-xs text-sm" placeholder="Search project, vendor, PO/WO, item…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input w-40 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-xs text-slate-400">{rows.length} deposit(s)</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No deposits yet" hint='Open a PO/WO, and on any line click "💰 Mark as Deposit" — it will appear here.' />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-3 py-2">Project</th><th>Vendor</th><th>Item</th><th>PO/WO</th><th className="text-right">Required</th><th className="text-right">Received</th><th className="text-right">Pending</th><th>Payment / Receipt</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((d) => <DepositRow key={d.lineId} d={d} editable={editable} money={money} onSave={(b) => save.mutate({ docId: d.docId, description: d.description, ...b })} saving={save.isPending} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DepositRow({ d, editable, money, onSave, saving }: {
  d: Deposit; editable: boolean; money: (n: number | null | undefined) => string;
  onSave: (b: { amountReceived?: number; refDetails?: string | null; status?: string }) => void; saving: boolean;
}) {
  const [received, setReceived] = useState(String(d.amountReceived || ''));
  const [ref, setRef] = useState(d.refDetails || '');
  return (
    <tr className="border-b border-slate-100 align-top hover:bg-slate-50">
      <td className="px-3 py-2 text-slate-600">{d.projectName || '—'}</td>
      <td className="text-slate-600">{d.vendorName || '—'}</td>
      <td className="max-w-[220px]"><div className="font-medium text-slate-700">{d.description}</div>{d.note && <div className="text-[11px] text-slate-400">💰 {d.note}</div>}</td>
      <td className="whitespace-nowrap text-slate-500">{d.docNumber} <span className="text-[10px] text-slate-400">{d.type}</span></td>
      <td className="text-right font-medium">{money(d.amountRequired)}</td>
      <td className="text-right">
        {editable
          ? <input className="input h-8 w-24 text-right text-xs" type="number" value={received} onChange={(e) => setReceived(e.target.value)} onBlur={() => { if (String(d.amountReceived || '') !== received) onSave({ amountReceived: Number(received) || 0 }); }} />
          : money(d.amountReceived)}
      </td>
      <td className={`text-right font-medium ${d.pending > 0 ? 'text-amber-700' : 'text-green-700'}`}>{money(d.pending)}</td>
      <td className="min-w-[160px]">
        {editable
          ? <input className="input h-8 text-xs" placeholder="UTR / receipt no. / note" value={ref} onChange={(e) => setRef(e.target.value)} onBlur={() => { if ((d.refDetails || '') !== ref) onSave({ refDetails: ref || null }); }} />
          : (d.refDetails || '—')}
      </td>
      <td>
        {editable
          ? <select className="input h-8 text-xs" value={d.status} onChange={(e) => onSave({ status: e.target.value })} disabled={saving}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          : <span className={`badge ${STATUS_PILL[d.status] || 'bg-slate-100'}`}>{d.status}</span>}
      </td>
    </tr>
  );
}
