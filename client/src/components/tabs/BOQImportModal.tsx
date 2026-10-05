import { useState, useRef, useLayoutEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { Modal } from '../ui';
import { fmtNum } from '../../lib/format';

interface Row {
  srNo?: string; description: string; category?: string; roomZone?: string;
  unit?: string; makeModel?: string; remarks?: string; plannedQty: number;
  isGroup?: boolean; isTotal?: boolean; totalQty?: number; flagged?: boolean;
}

// An editable cell that WRAPS and auto-grows to show its full text — so long
// Category / Description / Remarks sentences from the Excel are fully visible
// (and still editable) in the import preview, instead of being clipped to one
// clipped single line.
function TextCell({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow to fit content on mount and whenever the text changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`block w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-0.5 leading-snug align-top hover:border-slate-300 focus:border-navy focus:outline-none ${className ?? ''}`}
    />
  );
}

export default function BOQImportModal({ projectId, onClose, onImported }: { projectId: string; onClose: () => void; onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [replace, setReplace] = useState(true);
  const [err, setErr] = useState('');

  const parse = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append('file', file!);
      return (await api.post(`/projects/${projectId}/boq/parse`, fd)).data as { rows: Row[]; warnings: string[]; source: string };
    },
    onSuccess: (d) => { setRows(d.rows); setWarnings(d.warnings || []); setErr(''); },
    onError: (e) => setErr(errMsg(e)),
  });

  const importMut = useMutation({
    mutationFn: async () => api.post(`/projects/${projectId}/boq/import`, { items: rows, replace }),
    onSuccess: onImported,
    onError: (e) => setErr(errMsg(e)),
  });

  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs!.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    setRows((rs) => rs!.filter((_, idx) => idx !== i));
  }

  return (
    <Modal title="Upload & Import BOQ" onClose={onClose} wide>
      {!rows ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            Upload the BOQ as <strong>.xlsx</strong>, <strong>.csv</strong>, or <strong>.pdf</strong>. The system auto-extracts
            Sr.No, Description, Unit and Planned Quantity for your review before locking. (PDF parsing uses Claude AI when an
            API key is configured.)
          </p>
          <input className="input" type="file" accept=".xlsx,.xls,.csv,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn-outline" onClick={onClose}>Cancel</button>
            <button className="btn-primary" disabled={!file || parse.isPending} onClick={() => parse.mutate()}>{parse.isPending ? 'Parsing…' : 'Parse File'}</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {warnings.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
              {warnings.map((w, i) => <div key={i}>• {w}</div>)}
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-600">{rows.length} rows extracted — review & correct before importing.</div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace existing BOQ
            </label>
          </div>
          <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col style={{ width: '56px' }} />{/* Sr.No */}
                <col style={{ width: '140px' }} />{/* Category */}
                <col />{/* Description — takes the remaining width */}
                <col style={{ width: '150px' }} />{/* Make & Model */}
                <col style={{ width: '200px' }} />{/* Remarks */}
                <col style={{ width: '56px' }} />{/* Unit */}
                <col style={{ width: '76px' }} />{/* Planned */}
                <col style={{ width: '32px' }} />{/* remove */}
              </colgroup>
              <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase text-slate-400">
                <tr><th className="px-2 py-2">Sr.No</th><th className="px-1">Category</th><th className="px-1">Description</th><th className="px-1">Make &amp; Model</th><th className="px-1">Remarks</th><th className="px-1">Unit</th><th className="px-1 text-right" title="Planned Quantity">Planned Qty</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={`border-b border-slate-100 align-top ${r.isTotal ? 'border-y-2 border-slate-300 bg-slate-200 font-bold text-slate-800' : r.isGroup ? 'bg-slate-50 font-medium' : r.flagged ? 'bg-amber-50' : ''}`} title={r.isTotal ? 'Sub Total row — a roll-up of the lines above (not a planned quantity).' : r.flagged ? 'Quantity is ambiguous in the source (value in more than one column) — please verify.' : undefined}>
                    <td className="px-2 py-1"><input className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-slate-300 focus:border-navy focus:outline-none" value={r.srNo ?? ''} onChange={(e) => updateRow(i, { srNo: e.target.value })} /></td>
                    <td className="px-1 py-1"><TextCell value={r.category ?? ''} onChange={(v) => updateRow(i, { category: v })} /></td>
                    <td className="px-1 py-1"><TextCell value={r.description} onChange={(v) => updateRow(i, { description: v })} /></td>
                    <td className="px-1 py-1"><TextCell value={r.makeModel ?? ''} onChange={(v) => updateRow(i, { makeModel: v })} /></td>
                    <td className="px-1 py-1"><TextCell value={r.remarks ?? ''} onChange={(v) => updateRow(i, { remarks: v })} /></td>
                    <td className="px-1 py-1"><input className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-slate-300 focus:border-navy focus:outline-none" value={r.unit ?? ''} onChange={(e) => updateRow(i, { unit: e.target.value })} /></td>
                    <td className="px-1 py-1 text-right">
                      {r.isTotal
                        // A Sub Total / Total roll-up row: show its figure like the
                        // Excel (read-only, prefixed Σ), but it is NOT a planned qty
                        // and is not counted — so no editable input here.
                        ? <span className="block pr-1 font-bold text-slate-700" title="Sub Total (roll-up — not counted as a planned quantity)">Σ {r.totalQty != null ? fmtNum(r.totalQty) : '—'}</span>
                        : r.isGroup
                        // A section head / category row has NO quantity (same as the
                        // Excel — heads aren't priced lines). Show a dash, not an
                        // editable 0, so it's clearly "no qty".
                        ? <span className="block pr-1 text-slate-300" title="Section head — no quantity">—</span>
                        : <div className="flex items-start justify-end gap-1">{r.flagged && <span className="mt-0.5 text-amber-500" title="Ambiguous quantity — verify">⚠</span>}<input className={`w-full rounded border bg-transparent px-1 py-0.5 text-right focus:border-navy focus:outline-none ${r.flagged ? 'border-amber-300' : 'border-transparent hover:border-slate-300'}`} type="number" step="any" value={r.plannedQty} onChange={(e) => updateRow(i, { plannedQty: Number(e.target.value), flagged: false })} /></div>}
                    </td>
                    <td className="px-1 py-1 text-right"><button className="px-1 text-slate-300 hover:text-red-500" onClick={() => removeRow(i)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {err && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
          <div className="flex justify-between">
            <button className="btn-outline" onClick={() => { setRows(null); setFile(null); }}>← Back</button>
            <button className="btn-primary" disabled={importMut.isPending || rows.length === 0} onClick={() => importMut.mutate()}>{importMut.isPending ? 'Importing…' : `Import ${rows.length} Items`}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
