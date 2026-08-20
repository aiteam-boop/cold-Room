import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { EmptyState, Spinner } from '../components/ui';
import { fmtDate, inr } from '../lib/format';
import ProcurementPipeline from '../components/procurement/ProcurementPipeline';

interface Item {
  kind: 'PO' | 'WO' | 'GRN';
  docId: string; projectId: string; projectName?: string;
  number: string; vendorName?: string;
  basicAmount?: number | null; finalAmount?: number | null;
  submittedAt: string; myRole?: string | null; pendingWith?: string | null; pendingWithRole?: string | null; legacy?: boolean;
  invoiceNumber?: string | null; invoicePdfUrl?: string | null;
  // Per-term Proforma Invoices uploaded on the PO/WO — the approver can open them
  // straight from the queue.
  pis?: { term: string; piNumber: string | null; piUrl: string }[];
  // Post-approval amendments (oldest → newest). Non-empty means the document was
  // changed after a previous approval and resubmitted — show WHY it needs
  // re-approval, so the approver isn't deciding blind.
  amendments?: { remark: string; byName: string; at: string }[];
  // When the current approver would next be auto-reminded (ISO) — drives the countdown.
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
  kind: 'PO' | 'WO' | 'GRN';
  docId: string; projectId: string; projectName?: string;
  number: string; vendorName?: string; finalAmount?: number | null;
  approvedAt?: string | null; approvedBy?: string | null;
  pis?: { term: string; piNumber: string | null; piUrl: string }[];
}

// "My Approvals" — documents where the signed-in user is the current approver.
// Fully actionable here so approvers never need access to the project workspace.
export default function ApprovalsPage() {
  const qc = useQueryClient();
  const { hideFinancials, isAdmin } = useAuth();
  const money = (n: number | null | undefined) => (hideFinancials ? '—' : inr(n));

  const [tab, setTab] = useState<'pending' | 'approved'>('pending');
  // Which Approved rows have their phase pipeline expanded (lazy-loaded on open).
  const [openPipe, setOpenPipe] = useState<Set<string>>(new Set());
  const togglePipe = (key: string) => setOpenPipe((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  // Re-render every 30s so the "next reminder in …" countdowns tick down live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const { data, isLoading, error } = useQuery({
    queryKey: ['approvals-mine'],
    queryFn: async () => (await api.get('/approvals/mine')).data.items as Item[],
    refetchInterval: 30_000,
  });
  // Already-approved documents (read-only history) — loaded when that tab opens.
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

  // The document itself — the approver reviews it before deciding.
  const viewDoc = (item: Item) => {
    const seg = item.kind === 'GRN' ? 'grns' : 'docs';
    openAuthedFile(`/projects/${item.projectId}/procurement/${seg}/${item.docId}/pdf`);
  };

  if (isLoading) return <Spinner label="Loading approvals…" />;
  if (error) return <div className="card p-6 text-red-600">Could not load your approvals.</div>;
  const items = data ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-navy">My Approvals</h1>
        <p className="text-sm text-slate-500">
          {isAdmin ? 'Every document currently awaiting approval, across all projects.' : 'Documents awaiting your approval. Approve, or put on hold with a note, directly here.'}
        </p>
      </div>

      {/* Pending (actionable) vs Approved (read-only history). */}
      <div className="flex gap-2 border-b border-slate-200">
        <button onClick={() => setTab('pending')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === 'pending' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Pending{items.length ? ` (${items.length})` : ''}</button>
        <button onClick={() => setTab('approved')} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === 'approved' ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'}`}>Approved{approvedQ.data ? ` (${approvedQ.data.length})` : ''}</button>
      </div>

      {tab === 'pending' && (items.length === 0 ? (
        <EmptyState title="Nothing pending" hint="You have no documents waiting for your approval right now." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
              <tr><th className="px-4 py-2">Document</th><th>Project</th><th>Vendor</th><th className="text-right">Amount</th><th>Submitted</th><th className="text-right">Action</th></tr>
            </thead>
            <tbody>
              {items.map((d) => {
                const amendments = d.amendments ?? [];
                const latest = amendments.length ? amendments[amendments.length - 1] : null;
                const earlier = amendments.slice(0, -1).reverse();
                return (
                  <Fragment key={`${d.kind}-${d.docId}`}>
                    <tr className={`hover:bg-slate-50 ${latest ? '' : 'border-b border-slate-100'}`}>
                      <td className="px-4 py-2">
                        <Link to={`/projects/${d.projectId}?open=${d.kind.toLowerCase()}:${d.docId}`} className="font-medium text-navy hover:underline" title="Open in its project">{d.number}</Link> <span className="badge bg-slate-100 text-slate-600">{d.kind}</span>
                        {latest && <span className="badge ml-1 bg-amber-100 text-amber-700">⚠ Resubmitted</span>}
                        {/* Who this document is currently waiting on (current pending approver). */}
                        {d.pendingWith && <div className="text-xs text-amber-600">⏳ Pending with: <span className="font-medium">{d.pendingWith}</span>{d.pendingWithRole ? ` · ${d.pendingWithRole}` : ''}</div>}
                        {!d.pendingWith && d.myRole && <div className="text-xs text-slate-400">as {d.myRole}</div>}
                        {d.legacy && <div className="text-xs text-slate-400">no chain — admin action</div>}
                        {/* Live countdown to the next auto-reminder for the pending approver. */}
                        {d.nextReminderAt && (
                          new Date(d.nextReminderAt).getTime() - now <= 0
                            ? <div className="text-xs font-medium text-red-500">⏰ Reminder due — sending soon</div>
                            : <div className="text-xs text-slate-400">⏰ Next reminder in {reminderCountdown(d.nextReminderAt, now)}</div>
                        )}
                        {d.invoicePdfUrl
                          ? <a href={d.invoicePdfUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-navy hover:underline">📄 View invoice{d.invoiceNumber ? ` (${d.invoiceNumber})` : ''}</a>
                          : d.kind === 'GRN' && <span className="text-xs text-slate-400">no invoice file</span>}
                      </td>
                      <td className="text-slate-600">{d.projectName}</td>
                      <td className="text-slate-600">{d.vendorName || '—'}</td>
                      <td className="text-right font-medium">{money(d.finalAmount)}</td>
                      <td className="text-slate-500">{fmtDate(d.submittedAt)}</td>
                      <td className="px-2 text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          {/* PI(s) uploaded on the PO — sit right beside View PO so the
                              approver can open them before deciding. */}
                          {d.pis?.map((p, i) => (
                            <a key={i} href={p.piUrl} target="_blank" rel="noreferrer" title={`Proforma Invoice — ${p.term}${p.piNumber ? ` · ${p.piNumber}` : ''}`} className="rounded-lg border border-navy/30 bg-navy/5 px-3 py-1 text-xs font-medium text-navy hover:bg-navy/10">📄 PI{d.pis!.length > 1 ? ` (${p.term})` : ''}</a>
                          ))}
                          <button className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={() => viewDoc(d)}>📄 View {d.kind}</button>
                          <button className="rounded-lg bg-navy px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={act.isPending} onClick={() => decide(d, 'approve')}>✓ Approve</button>
                          <button className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={act.isPending} onClick={() => decide(d, 'hold')}>⏸ On Hold</button>
                        </div>
                      </td>
                    </tr>
                    {/* Amended after approval → the approver must see WHY before deciding. */}
                    {latest && (
                      <tr className="border-b border-slate-100">
                        <td colSpan={6} className="bg-amber-50 px-4 py-2">
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Reason for the amendment</div>
                          <div className="text-sm text-amber-900">{latest.remark}</div>
                          <div className="text-[11px] text-amber-700">— {latest.byName}{latest.at ? ` · ${new Date(latest.at).toLocaleString('en-GB')}` : ''}</div>
                          {earlier.length > 0 && (
                            <div className="mt-1.5 border-t border-amber-200 pt-1.5">
                              <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">Earlier amendments ({earlier.length})</div>
                              {earlier.map((a, i) => (
                                <div key={i} className="text-[11px] text-amber-900">• {a.remark} <span className="text-amber-700">— {a.byName}{a.at ? ` · ${new Date(a.at).toLocaleString('en-GB')}` : ''}</span></div>
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

      {tab === 'approved' && (
        approvedQ.isLoading ? <Spinner label="Loading approved…" />
        : (approvedQ.data ?? []).length === 0 ? <EmptyState title="Nothing approved yet" hint="Approved PO/WO/GRN will appear here." />
        : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr><th className="px-4 py-2">Document</th><th>Project</th><th>Vendor</th><th className="text-right">Amount</th><th>Approved</th><th>Approved by</th><th className="text-right">Action</th></tr>
              </thead>
              <tbody>
                {(approvedQ.data ?? []).map((d) => {
                  const key = `${d.kind}-${d.docId}`;
                  const canPipe = d.kind === 'PO' || d.kind === 'WO'; // pipeline is for PO/WO docs
                  const open = openPipe.has(key);
                  return (
                  <Fragment key={key}>
                  <tr className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="px-4 py-2">
                      {canPipe && <button className="mr-1 text-slate-400 hover:text-navy" title={open ? 'Hide pipeline' : 'Show phases (Approval → Payment → GRN)'} onClick={() => togglePipe(key)}>{open ? '▾' : '▸'}</button>}
                      <Link to={`/projects/${d.projectId}?open=${d.kind.toLowerCase()}:${d.docId}`} className="font-medium text-navy hover:underline" title="Open in its project">{d.number}</Link> <span className="badge bg-slate-100 text-slate-600">{d.kind}</span>
                      <span className="badge ml-1 bg-green-100 text-green-700">Approved</span>
                    </td>
                    <td className="text-slate-600">{d.projectName}</td>
                    <td className="text-slate-600">{d.vendorName || '—'}</td>
                    <td className="text-right font-medium">{money(d.finalAmount)}</td>
                    <td className="text-slate-500">{d.approvedAt ? fmtDate(d.approvedAt) : '—'}</td>
                    <td className="text-slate-500">{d.approvedBy || '—'}</td>
                    <td className="px-2 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {/* PI(s) uploaded on the PO — beside View PO. */}
                        {d.pis?.map((p, i) => (
                          <a key={i} href={p.piUrl} target="_blank" rel="noreferrer" title={`Proforma Invoice — ${p.term}${p.piNumber ? ` · ${p.piNumber}` : ''}`} className="rounded-lg border border-navy/30 bg-navy/5 px-3 py-1 text-xs font-medium text-navy hover:bg-navy/10">📄 PI{d.pis!.length > 1 ? ` (${p.term})` : ''}</a>
                        ))}
                        <button className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium text-navy hover:bg-slate-50" onClick={() => openAuthedFile(`/projects/${d.projectId}/procurement/${d.kind === 'GRN' ? 'grns' : 'docs'}/${d.docId}/pdf`)}>📄 View {d.kind}</button>
                      </div>
                    </td>
                  </tr>
                  {canPipe && open && (
                    <tr className="border-b border-slate-100 bg-slate-50/50">
                      <td colSpan={7} className="px-4 py-3"><ProcurementPipeline projectId={d.projectId} docId={d.docId} /></td>
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
    </div>
  );
}
