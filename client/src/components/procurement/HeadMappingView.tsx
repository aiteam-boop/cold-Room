import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';

// Procurement PRD §5 (D3) — re-map already-issued PO/WO line items to their
// internal BOQ head. The head never appears on the vendor PDF, so editing it here
// touches only the mapping (no re-approval). "Suggested" = the category of the
// BOQ item the line is linked to, offered as a one-click fill.
export default function HeadMappingView({ projectId }: { projectId: string; role?: string }) {
  const { canEdit } = useAuth();
  const canManage = canEdit('po') || canEdit('wo');
  const qc = useQueryClient();
  const [unmappedOnly, setUnmappedOnly] = useState(true);
  const [edits, setEdits] = useState<Record<string, string>>({}); // lineItemId -> head ('' = clear)
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const mapQ = useQuery({ queryKey: ['head-mapping', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/head-mapping`)).data.docs as any[] });
  const boqQ = useQuery({ queryKey: ['boq', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/boq`)).data });

  // Head options: project BOQ categories + any category seen on a line's suggestion, + Other.
  const heads: string[] = useMemo(() => {
    const set = new Set<string>();
    (boqQ.data?.categories ?? []).forEach((c: any) => { const n = typeof c === 'string' ? c : c?.category; if (n) set.add(n); });
    (mapQ.data ?? []).forEach((d) => d.lineItems.forEach((l: any) => { if (l.suggestedHead) set.add(l.suggestedHead); if (l.boqHead) set.add(l.boqHead); }));
    // Real heads only — no "Other" (the bypass belongs on the BOQ Item sub-item).
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [boqQ.data, mapQ.data]);

  // The value shown for a line = local edit if any, else its saved head.
  const headOf = (l: any) => (l.id in edits ? edits[l.id] : (l.boqHead ?? ''));
  const setHead = (id: string, v: string) => setEdits((p) => ({ ...p, [id]: v }));

  const docs = (mapQ.data ?? [])
    .map((d) => ({ ...d, lineItems: unmappedOnly ? d.lineItems.filter((l: any) => !headOf(l)) : d.lineItems }))
    .filter((d) => d.lineItems.length > 0);

  const dirty = Object.keys(edits).filter((id) => {
    const line = (mapQ.data ?? []).flatMap((d) => d.lineItems).find((l: any) => l.id === id);
    return line && (edits[id] || '') !== (line.boqHead ?? '');
  });

  const save = useMutation({
    mutationFn: async () => {
      const items = dirty.map((id) => ({ id, boqHead: edits[id] ? edits[id] : null }));
      return (await api.patch(`/projects/${projectId}/procurement/line-items/heads`, { items })).data;
    },
    onSuccess: (r) => { setMsg({ ok: true, t: `Saved — ${r.updated} line(s) updated.` }); setEdits({}); qc.invalidateQueries({ queryKey: ['head-mapping', projectId] }); },
    onError: (e) => setMsg({ ok: false, t: errMsg(e) }),
  });

  // One-click: fill every still-unmapped line that HAS a suggestion, across all docs.
  function applyAllSuggestions() {
    const next: Record<string, string> = { ...edits };
    (mapQ.data ?? []).forEach((d) => d.lineItems.forEach((l: any) => {
      if (!headOf(l) && l.suggestedHead) next[l.id] = l.suggestedHead;
    }));
    setEdits(next);
  }

  if (mapQ.isLoading) return <Spinner label="Loading line items…" />;
  const totalLines = (mapQ.data ?? []).reduce((s, d) => s + d.lineItems.length, 0);
  const unmapped = (mapQ.data ?? []).reduce((s, d) => s + d.lineItems.filter((l: any) => !(l.id in edits ? edits[l.id] : l.boqHead)).length, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm font-medium text-slate-600">BOQ Head Mapping</div>
        <span className="text-xs text-slate-400">{totalLines} lines · <span className={unmapped ? 'font-medium text-amber-600' : 'text-emerald-600'}>{unmapped} unmapped</span></span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={unmappedOnly} onChange={(e) => setUnmappedOnly(e.target.checked)} /> Unmapped only</label>
        {canManage && <button className="btn-outline text-xs" onClick={applyAllSuggestions} disabled={save.isPending}>✨ Apply all suggestions</button>}
        {canManage && <button className="btn-primary text-xs" onClick={() => save.mutate()} disabled={save.isPending || dirty.length === 0}>{save.isPending ? 'Saving…' : `Save${dirty.length ? ` (${dirty.length})` : ''}`}</button>}
      </div>
      <div className="text-[11px] text-slate-400">The head is internal — it never prints on the vendor PDF. Changing it here needs no re-approval.</div>
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{msg.t}</div>}

      {docs.length === 0 ? (
        <EmptyState title={unmappedOnly ? 'All line items have a head 🎉' : 'No PO/WO line items yet'} hint={unmappedOnly ? 'Nothing left to map.' : undefined} />
      ) : (
        <div className="space-y-3">
          {docs.map((d) => (
            <div key={d.id} className="overflow-hidden rounded-lg border border-slate-200">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-sm">
                <span className="font-medium text-navy">{d.docNumber}</span>
                <span className="badge bg-slate-100 text-slate-600">{d.type}</span>
                <span className="truncate text-slate-500">{d.vendorName || '—'}</span>
                <span className="ml-auto badge bg-slate-100 text-slate-500">{d.status?.replace(/_/g, ' ')}</span>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {d.lineItems.map((l: any) => {
                    const cur = headOf(l);
                    const changed = (l.id in edits) && (edits[l.id] || '') !== (l.boqHead ?? '');
                    return (
                      <tr key={l.id} className="border-b border-slate-50 align-top last:border-0">
                        <td className="px-3 py-2 text-xs text-slate-600">{(l.description || '').split('\n')[0] || '—'}</td>
                        <td className="w-64 px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <select className={`input text-xs ${!cur ? 'border-amber-400' : changed ? 'border-sky-400' : ''}`} disabled={!canManage} value={cur} onChange={(e) => setHead(l.id, e.target.value)}>
                              <option value="">— select head —</option>
                              {heads.map((h) => <option key={h} value={h}>{h}</option>)}
                              {cur && !heads.includes(cur) && <option value={cur}>{cur}</option>}
                            </select>
                            {!cur && l.suggestedHead && canManage && (
                              <button className="whitespace-nowrap rounded border border-slate-300 px-1.5 py-0.5 text-[10px] text-navy hover:bg-slate-50" title="Use the linked BOQ item's category" onClick={() => setHead(l.id, l.suggestedHead)}>use {l.suggestedHead}</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
