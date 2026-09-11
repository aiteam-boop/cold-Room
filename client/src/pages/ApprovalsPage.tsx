import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Spinner, Modal } from '../components/ui';
import { FileViewerModal, type ViewFile } from '../components/FileViewer';
import { fmtDate, inr } from '../lib/format';
import ProcurementPipeline from '../components/procurement/ProcurementPipeline';

interface Item {
  kind: 'PO' | 'WO' | 'TO' | 'GRN';
  docId: string; projectId: string; projectName?: string;
  number: string; vendorName?: string;
  basicAmount?: number | null; finalAmount?: number | null;
  submittedAt: string; myRole?: string | null; pendingWith?: string | null; pendingWithRole?: string | null; legacy?: boolean;
  // Raised by the signed-in user (not an approver on it) â shown read-only, no action buttons.
  raisedByMe?: boolean;
  raisedBy?: string | null;   // name of whoever raised it (for see-all viewers)
  // Whether the signed-in user may act (approve/hold) on this item. False for a
  // "see-all" viewer looking at a document they are not the approver of â view-only.
  canAct?: boolean;
  // Approval-chain progress: how many steps are approved out of the total.
  approvedSteps?: number; totalSteps?: number;
  invoiceNumber?: string | null; invoicePdfUrl?: string | null;
  // Per-term Proforma Invoices uploaded on the PO/WO â the approver can open them
  // straight from the queue.
  pis?: { term: string; piNumber: string | null; piUrl: string }[];
  // Post-approval amendments (oldest â newest). Non-empty means the document was
  // changed after a previous approval and resubmitted â show WHY it needs
  // re-approval, so the approver isn't deciding blind.
  amendments?: { remark: string; byName: string; at: string }[];
  // When the current approver would next be auto-reminded (ISO) â drives the countdown.
  nextReminderAt?: string | null;
}

// "5h 23m" until the next auto-reminder; "due now" once it's overdue.
function reminderCountdown(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'due now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface ApprovedItem {
  kind: 'PO' | 'WO' | 'TO' | 'GRN';
  label?: string; // display label â 'PO' | 'WO' | 'TO' | 'Payment' | 'GRN'
  docId: string; projectId: string; projectName?: string;
  number: string; vendorName?: string; finalAmount?: number | null;
  approvedAt?: string | null; approvedBy?: string | null; raisedByMe?: boolean; raisedBy?: string | null;
  approvedSteps?: number; totalSteps?: number;
  pis?: { term: string; piNumber: string | null; piUrl: string }[];
  // Physical goods receipts raised against this PO/WO (for the GRN action + popup).
  goodsReceipts?: { id: string; grnNumber: string; status: string; receivedDate?: string | null }[];
  // Tax invoices on this PO/WO's payments â some uploaded, some not.
  invoices?: { id: string; number: string; milestone: string | null; invoiceNumber: string | null; invoiceUrl: string | null }[];
  // UTR(s) backfilled from the Accounts sheet (paid via the form) â shown inline.
  sheetPayments?: { utr: string; vrNo?: string; amount?: number | null }[];
}

// "My Approvals" â documents where the signed-in user is the current approver.
// Fully actionable here so approvers never need access to the project workspace.
export default function ApprovalsPage() {
  const qc = useQueryClient();
  const { hideFinancials, isAdmin } = useAuth();
  const money = (n: number | null | undefined) => (hideFinancials ? 'â' : inr(n));

  const [tab, setTab] = useState<'pending' | 'approved'>('pending');
  // Within the Approved tab: split PO/WO/GRN documents from Payments (PAY-###).
  const [approvedSub, setApprovedSub] = useState<'docs' | 'payments'>('docs');
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  // Which Approved rows have their phase pipeline expanded (lazy-loaded on open).
  const [openPipe, setOpenPipe] = useState<Set<string>>(new Set());
  const togglePipe = (key: string) => setOpenPipe((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  // When a PO/WO has several goods receipts, the "GRN" action opens this popup list.
  const [grnPopup, setGrnPopup] = useState<ApprovedItem | null>(null);
  // The "Invoice" action opens this popup listing each payment's tax invoice.
  const [invPopup, setInvPopup] = useState<ApprovedItem | null>(null);
  // Re-render every 30s so the "next reminder in â¦" countdowns tick down live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals-mine'],
    queryFn: async () => (await api.get('/approvals/mine')).data.items as Item[],
    refetchInterval: 30_000,
  });
  // Already-approved documents (read-only history) â loaded when that tab opens.
  const approvedQ = useQuery({
    queryKey: ['approvals-approved'],
    queryFn: async () => (await api.get('/approvals/approved')).data.items as ApprovedItem[],
    enabled: tab === 'approved',
  });

  const act = useMutation({
    mutationFn: async ({ item, verb, remarks }: { item: Item; verb: 'approve' | 'hold'; remarks?: string }) => {
      const seg = item.kind === 'GRN' ? 'grns' : 'docs';
      const body = verb === 'hold' ? { reason: remarks } : { remarks };
      return api.post(`/projects/${item.projectId}/procurement/${seg}/${item.docId}/${verb}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approvals-mine'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
    onError: (e) => alert(errMsg(e)),
  });

  // Nothing is rejected: an approver who spots a mistake puts the document ON HOLD
  // with a note, and the raiser corrects it and resubmits.
  const decide = (item: Item, verb: 'approve' | 'hold') => {
    const remarks = window.prompt(verb === 'hold' ? 'What needs to be corrected? (required)' : 'Remarks (optional)') ?? (verb === 'approve' ? '' : null);
    if (verb === 'hold' && !remarks?.trim()) return;
    act.mutate({ item, verb, remarks: remarks ?? undefined });
  };

  // Every PO/WO/GRN/PI/photo opens in this in-app viewer (no new tab).
  const [viewer, setViewer] = useState<{ items: ViewFile[]; title?: string; start?: number } | null>(null);
  const viewDocPdf = (item: { kind: string; projectId: string; docId: string; number?: string; label?: string }) => {
    const seg = item.kind === 'GRN' ? 'grns' : 'docs';
    setViewer({ items: [{ url: `/projects/${item.projectId}/procurement/${seg}/${item.docId}/pdf`, name: `${item.number || item.kind}.pdf`, authed: true }], title: `${item.label ?? item.kind} ${item.number || ''}` });
  };
  const viewGrn = (projectId: string, grId: string, grnNumber: string) => setViewer({ items: [{ url: `/projects/${projectId}/procurement/goods-receipts/${grId}/pdf`, name: `${grnNumber}.pdf`, authed: true }], title: grnNumber });
  const viewPis = (pis: { term: string; piNumber: string | null; piUrl: string }[], start = 0) => setViewer({ items: pis.map((p) => ({ url: p.piUrl, name: `PI ${p.piNumber || p.term}.pdf`, label: p.term })), title: 'Proforma Invoice', start });
  // Open one payment's tax invoice in the in-app viewer.
  const viewInvoice = (iv: { number: string; invoiceNumber: string | null; invoiceUrl: string | null }) => { if (!iv.invoiceUrl) return; setInvPopup(null); setViewer({ items: [{ url: iv.invoiceUrl, name: `Invoice ${iv.invoiceNumber || iv.number}.pdf`, authed: iv.invoiceUrl.startsWith('/api') }], title: `Invoice ${iv.number}` }); };
  // The document itself â the approver reviews it before deciding.
  const viewDoc = (item: Item) => viewDocPdf(item);

  if (isLoading) return <Spinner label="Loading approvalsâ¦" />;
  if (error) return <div className="card p-6 text-red-600">Could not load your approvals.</div>;
  const items = data ?? [];
  // Project options are derived from the loaded documents (pending + approved),
  // so the dropdown only lists projects that actually have documents here.
  const projectOptions = (() => {
    const m = new Map<string, string>();
    [...items, ...(approvedQ.data ?? [])].forEach((x: any) => { if (x.projectId) m.set(x.projectId, x.projectName || x.projectId); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  })();
  // Search (document number / vendor / project) + project filter â both tabs.
  const needle = search.toLowerCase().trim();
  const matches = (x: { number?: string; vendorName?: string | null; projectName?: string | null; projectId?: string }) =>
    (!needle || [x.number, x.vendorName, x.projectName].filter(Boolean).some((s) => String(s).toLowerCase().includes(needle)))
    && (!projectFilter || x.projectId === projectFilter);
  const pendingItems = items.filter(matches);
  const approvedItems = (approvedQ.data ?? []).filter(matches);
  // A "Payment" row is a PAY-### record (GRN kind, labelled Payment); everything else
  // (PO / WO / TO / GRN goods receipt) is a document.
  const isPaymentRow = (d: ApprovedItem) => d.label === 'Payment' || (d.kind === 'GRN' && String(d.number || '').startsWith('PAY'));
  const approvedDocs = approvedItems.filter((d) => !isPaymentRow(d));
  const approvedPayments = approvedItems.filter(isPaymentRow);
  const approvedList = approvedSub === 'payments' ? approvedPayments : approvedDocs;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-navy">My Approvals</h1>
        <p className="text-sm text-slate-500">
          {isAdmin ? 'Every document currently awaiting approval, across all projects.' : 'Documents awaiting your approval, plus the ones you raised (read-only). Approve or put on hold directly here.'}
        </p>
      </div>

      {/* Pending (actionable) vs Approved (read-only history). */}
      <div className="flex gap-2 border-b border-slate-200">
        <button onClick={() => setTab('pending')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === 'pending' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Pending{items.length ? ` (${items.length})` : ''}</button>
        <button onClick={() => setTab('approved')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === 'approved' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Approved{approvedQ.data ? ` (${approvedQ.data.length})` : ''}</button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input className="input w-full max-w-xs text-sm" placeholder="Search PO/WO, vendor, projectâ¦" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input w-56 text-sm" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">All projects ({projectOptions.length})</option>
          {projectOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {(needle || projectFilter) && <span className="whitespace-nowrap text-xs text-slate-400">{(tab === 'pending' ? pendingItems.length : approvedItems.length)} match{(tab === 'pending' ? pendingItems.length : approvedItems.length) === 1 ? '' : 'es'}</span>}
      </div>

      {tab === 'pending' && (pendingItems.length === 0 ? (
        <EmptyState title={needle || projectFilter ? 'No matches' : 'Nothing pending'} hint={needle || projectFilter ? 'No pending document matches your filter.' : 'You have no documents waiting for your approval right now.'} />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Submitted</th><th>Document</th><th>Project</th><th>Vendor</th><th className="text-right">Amount</th><th className="text-right">Action</th></tr>
            </thead>
            <tbody>
              {pendingItems.map((d) => {
                const amendments = d.amendments ?? [];
                const latest = amendments.length ? amendments[amendments.length - 1] : null;
                const earlier = amendments.slice(0, -1).reverse();
                return (
                  <Fragment key={`${d.kind}-${d.docId}`}>
                    <tr className={`hover:bg-slate-50 ${latest ? '' : 'border-b border-slate-100'}`}>
                      <td className="whitespace-nowrap px-4 py-2 align-top text-slate-500">{fmtDate(d.submittedAt)}</td>
                      <td className="py-2 pr-2">
                        <Link to={`/projects/${d.projectId}?open=${d.kind.toLowerCase()}:${d.docId}`} className="font-medium text-navy hover:underline" title="Open in its project">{d.number}</Link> <span className="badge bg-slate-100 text-slate-600">{d.kind}</span>
                        {latest && <span className="badge ml-1 bg-amber-100 text-amber-700">â  Resubmitted</span>}
                        {d.raisedByMe ? <span className="badge ml-1 bg-emerald-100 text-emerald-700">ð§¾ Raised by you</span> : d.raisedBy ? <span className="badge ml-1 bg-slate-100 text-slate-600">ð§¾ Raised by {d.raisedBy}</span> : null}
                        {/* Approval-chain progress: how many steps signed vs still pending. */}
                        {!!d.totalSteps && <span className="badge ml-1 bg-blue-100 text-blue-700">{d.approvedSteps ?? 0}/{d.totalSteps} done Â· {Math.max(d.totalSteps - (d.approvedSteps ?? 0), 0)} pending</span>}
                        {/* Who this document is currently waiting on (current pending approver). */}
                        {d.pendingWith && <div className="text-xs text-amber-600">â³ Pending with: <span className="font-medium">{d.pendingWith}</span>{d.pendingWithRole ? ` Â· ${d.pendingWithRole}` : ''}</div>}
                        {!d.pendingWith && d.myRole && <div className="text-xs text-slate-400">as {d.myRole}</div>}
                        {d.legacy && <div className="text-xs text-slate-400">no chain â admin action</div>}
                        {/* Live countdown to the next auto-reminder for the pending approver. */}
                        {d.nextReminderAt && (
                          new Date(d.nextReminderAt).getTime() - now <= 0
                            ? <div className="text-xs font-medium text-red-500">â° Reminder due â sending soon</div>
                            : <div className="text-xs text-slate-400">â° Next reminder in {reminderCountdown(d.nextReminderAt, now)}</div>
                        )}
                        {d.invoicePdfUrl
                          ? <a href={d.invoicePdfUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-navy hover:underline">ð View invoice{d.invoiceNumber ? ` (${d.invoiceNumber})` : ''}</a>
                          : d.kind === 'GRN' && <span className="text-xs text-slate-400">no invoice file</span>}
                      </td>
                      <td className="font-medium text-slate-800">{d.projectName}</td>
                      <td className="font-medium text-slate-800">{d.vendorName || "—"}</td>
                      <td className="text-right font-medium">{money(d.finalAmount)}</td>
                      <td className="px-2 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {/* PI(s) uploaded on the PO â sit right beside View PO so the
                              approver can open them before deciding. */}
                          {(d.pis?.length ?? 0) > 0 && (
                            <button onClick={() => viewPis(d.pis!, 0)} title="Proforma Invoice" className="rounded-lg border border-navy/30 bg-navy/5 px-3 py-1 text-xs font-medium text-navy hover:bg-navy/10">ð PI{d.pis!.length > 1 ? ` (${d.pis!.length})` : ''}</button>
                          )}
                          <button className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={() => viewDoc(d)}>ð View {d.kind}</button>
                          {/* Read-only when it's my own raised doc, or a see-all viewer looking
                              at a doc they're not the approver of. Otherwise Approve / On-Hold. */}
                          {(d.raisedByMe || d.canAct === false) ? (
                            <span className="self-center text-xs text-slate-400">{d.raisedByMe ? 'â³ Awaiting approval' : 'ð View only'}</span>
                          ) : (<>
                            <button className="rounded-lg bg-navy px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={act.isPending} onClick={() => decide(d, 'approve')}>â Approve</button>
                            <button className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={act.isPending} onClick={() => decide(d, 'hold')}>â¸ On Hold</button>
                          </>)}
                        </div>
                      </td>
                    </tr>
                    {/* Amended after approval â the approver must see WHY before deciding. */}
                    {latest && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={6} className="bg-amber-50 px-4 py-2">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Reason for the amendment</div>
                          <div className="text-sm text-amber-900">{latest.remark}</div>
                          <div className="text-[11px] text-amber-700">â {latest.byName}{latest.at ? ` Â· ${new Date(latest.at).toLocaleString('en-GB')}` : ''}</div>
                          {earlier.length > 0 && (
                            <div className="mt-1.5 border-t border-amber-200 pt-1.5">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Earlier amendments ({earlier.length})</div>
                              {earlier.map((a, i) => (
                                <div key={i} className="text-[11px] text-amber-900">â¢ {a.remark} <span className="text-amber-700">â {a.byName}{a.at ? ` Â· ${new Date(a.at).toLocaleString('en-GB')}` : ''}</span></div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      {/* Approved sub-tabs: documents (PO/WO/GRN) vs Payments (PAY-###). */}
      {tab === 'approved' && !approvedQ.isLoading && (
        <div className="flex flex-wrap gap-2 text-sm">
          <button type="button" onClick={() => setApprovedSub('docs')} className={`rounded-md px-3 py-1.5 font-medium ${approvedSub === 'docs' ? 'bg-navy text-white' : 'text-slate-500 hover:bg-slate-100'}`}>PO / WO / GRN ({approvedDocs.length})</button>
          <button type="button" onClick={() => setApprovedSub('payments')} className={`rounded-md px-3 py-1.5 font-medium ${approvedSub === 'payments' ? 'bg-navy text-white' : 'text-slate-500 hover:bg-slate-100'}`}>Payments ({approvedPayments.length})</button>
        </div>
      )}

      {tab === 'approved' && (
        approvedQ.isLoading ? <Spinner label="Loading approvedâ¦" />
        : approvedList.length === 0 ? <EmptyState title={needle || projectFilter ? 'No matches' : (approvedSub === 'payments' ? 'No approved payments' : 'Nothing approved yet')} hint={needle || projectFilter ? 'No approved document matches your filter.' : (approvedSub === 'payments' ? 'Approved payments will appear here.' : 'Approved PO/WO/GRN will appear here.')} />
        : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr><th className="w-8 pl-4 py-2"></th><th className="py-2">Approved</th><th>Document</th><th>Project</th><th>Vendor</th><th className="text-right pr-6">Amount</th><th className="pl-2">Status</th><th>Goods Receipt</th><th className="text-right">Action</th></tr>
              </thead>
              <tbody>
                {approvedList.map((d) => {
                  const key = `${d.kind}-${d.docId}`;
                  const canPipe = d.kind === 'PO' || d.kind === 'WO'; // pipeline is for PO/WO docs
                  const open = openPipe.has(key);
                  return (
                  <Fragment key={key}>
                  <tr className={`border-b border-slate-100 hover:bg-slate-50 ${canPipe ? 'cursor-pointer' : ''}`} onClick={() => { if (canPipe) togglePipe(key); }}>
                    <td className="w-8 pl-4 py-2 align-top">{canPipe && <button className="text-slate-400 hover:text-navy" title={open ? 'Hide pipeline' : 'Show phases (Approval â Payment â GRN)'} onClick={(e) => { e.stopPropagation(); togglePipe(key); }}>{open ? 'â¾' : 'â¸'}</button>}</td>
                    <td className="whitespace-nowrap py-2 pr-4 align-top text-slate-500">{d.approvedAt ? fmtDate(d.approvedAt) : 'â'}</td>
                    <td className="py-2 pr-2">
                      <Link to={`/projects/${d.projectId}?open=${d.kind.toLowerCase()}:${d.docId}`} onClick={(e) => e.stopPropagation()} className="font-medium text-navy hover:underline" title="Open in its project">{d.number}</Link> <span className="badge bg-slate-100 text-slate-600">{d.label ?? d.kind}</span>
                      {d.raisedByMe ? <span className="badge ml-1 bg-emerald-100 text-emerald-700">ð§¾ Raised by you</span> : d.raisedBy ? <span className="badge ml-1 bg-slate-100 text-slate-600">ð§¾ Raised by {d.raisedBy}</span> : null}
                      {(d.sheetPayments?.length ?? 0) > 0 && (
                        <span className="ml-1 inline-block max-w-[230px] truncate align-middle rounded bg-green-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-green-700" title={d.sheetPayments!.map((s) => `${s.utr}${s.vrNo ? ` (${s.vrNo})` : ''}`).join('\n')}>ð  UTR: {d.sheetPayments!.map((s) => s.utr).join(', ')}</span>
                      )}
                    </td>
                    <td className="font-medium text-slate-800">{d.projectName}</td>
                    <td className="font-medium text-slate-800">{d.vendorName || "—"}</td>
                    <td className="text-right font-medium pr-6">{money(d.finalAmount)}</td>
                    {/* Status â approval-chain progress (e.g. "Approved Â· 2/2"). */}
                    <td className="pl-2">
                      <span className="badge bg-green-100 text-green-700">Approved{d.totalSteps ? ` Â· ${d.approvedSteps ?? d.totalSteps}/${d.totalSteps}` : ''}</span>
                      {d.approvedBy && <div className="mt-0.5 text-[11px] text-slate-400">by {d.approvedBy}</div>}
                    </td>
                    {/* Goods receipts against this PO/WO â one opens directly, several open a popup. */}
                    <td className="text-slate-500">
                      {(d.goodsReceipts?.length ?? 0) === 0 ? <span className="text-slate-300">â</span>
                        : d.goodsReceipts!.length === 1
                          ? <button className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={(e) => { e.stopPropagation(); viewGrn(d.projectId, d.goodsReceipts![0].id, d.goodsReceipts![0].grnNumber); }}>ð¦ {d.goodsReceipts![0].grnNumber}</button>
                          : <button className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={(e) => { e.stopPropagation(); setGrnPopup(d); }}>ð¦ {d.goodsReceipts!.length} GRNs</button>}
                    </td>
                    <td className="px-2 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {/* PI(s) uploaded on the PO â beside View PO. */}
                        {(d.pis?.length ?? 0) > 0 && (
                          <button onClick={(e) => { e.stopPropagation(); viewPis(d.pis!, 0); }} title="Proforma Invoice" className="rounded-lg border border-navy/30 bg-navy/5 px-3 py-1 text-xs font-medium text-navy hover:bg-navy/10">ð PI{d.pis!.length > 1 ? ` (${d.pis!.length})` : ''}</button>
                        )}
                        {/* Tax invoice(s) on this PO/WO's payments â "x/y" uploaded of payments.
                            One opens directly; several (or any missing) open a popup list. */}
                        {(() => {
                          const invs = d.invoices ?? [];
                          if (invs.length === 0) return null;
                          const uploaded = invs.filter((iv) => iv.invoiceUrl);
                          return (
                            <button className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100" title="Payment tax invoices" onClick={(e) => { e.stopPropagation(); if (invs.length === 1 && uploaded.length === 1) viewInvoice(invs[0]); else setInvPopup(d); }}>ð§¾ Invoice {uploaded.length}/{invs.length}</button>
                          );
                        })()}
                        <button className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={(e) => { e.stopPropagation(); viewDocPdf(d); }}>ð View {d.label ?? d.kind}</button>
                      </div>
                    </td>
                  </tr>
                  {canPipe && open && (
                    <tr className="border-b border-slate-100 bg-slate-50/50">
                      <td colSpan={9} className="px-4 py-3"><ProcurementPipeline projectId={d.projectId} docId={d.docId} /></td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Popup listing all goods receipts for a PO/WO (when there are several). */}
      {grnPopup && (
        <Modal title={`Goods Receipts â ${grnPopup.number}`} onClose={() => setGrnPopup(null)}>
          <div className="space-y-2">
            {(grnPopup.goodsReceipts ?? []).map((g) => (
              <div key={g.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium text-navy">{g.grnNumber}</span>
                  <span className={`badge ml-2 ${g.status === 'RECEIVED' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{g.status === 'RECEIVED' ? 'Received' : 'Draft'}</span>
                  {g.receivedDate && <span className="ml-2 text-xs text-slate-400">{fmtDate(g.receivedDate)}</span>}
                </span>
                <button className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={() => viewGrn(grnPopup.projectId, g.id, g.grnNumber)}>ð View</button>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* Popup listing each payment's tax invoice â uploaded ones open, missing
          ones show "Not uploaded" so it's clear which are still pending. */}
      {invPopup && (
        <Modal title={`Invoices â ${invPopup.number}`} onClose={() => setInvPopup(null)}>
          <div className="space-y-2">
            {(invPopup.invoices ?? []).map((iv) => (
              <div key={iv.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium text-navy">{iv.number}</span>
                  {iv.milestone && <span className="ml-2 text-xs text-slate-500">{iv.milestone}</span>}
                  {iv.invoiceNumber && <span className="ml-2 text-xs text-slate-400">Inv: {iv.invoiceNumber}</span>}
                </span>
                {iv.invoiceUrl
                  ? <button className="shrink-0 rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={() => viewInvoice(iv)}>ð View</button>
                  : <span className="shrink-0 badge bg-amber-100 text-amber-700">Not uploaded</span>}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {viewer && <FileViewerModal items={viewer.items} startIndex={viewer.start ?? 0} title={viewer.title} onClose={() => setViewer(null)} />}
    </div>
  );
}
