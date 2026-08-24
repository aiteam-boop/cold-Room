import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../lib/api';
import { Spinner } from '../components/ui';

// ── Public, no-login site-engineer Goods-Receipt form (Amisha 63/64, Phase 2) ──
// Opened from the emailed link `/grn/:token`. The engineer records what actually
// arrived (vehicle, dates, e-way bill, received qty) and marks it completed.
// Mobile-first — this is usually filled on a phone at the delivery gate.
export default function PublicGrn() {
  const { token } = useParams<{ token: string }>();
  const [g, setG] = useState<any>(null);
  const [msg, setMsg] = useState('');

  const grQ = useQuery({
    queryKey: ['public-grn', token],
    queryFn: async () => (await api.get(`/public/grn/${token}`)).data.goodsReceipt,
    retry: false,
  });
  useEffect(() => { if (grQ.data) setG(structuredClone(grQ.data)); }, [grQ.data]);

  const body = () => ({
    vehicleNumber: g.vehicleNumber, vehicleSize: g.vehicleSize, remarks: g.remarks, siteSupervisor: g.siteSupervisor,
    dispatchDate: g.dispatchDate?.slice?.(0, 10) || null, deliveryDate: g.deliveryDate?.slice?.(0, 10) || null,
    ...(g.mode === 'CUSTOM'
      ? {
          packingListNo: g.packingListNo ? Number(g.packingListNo) : null,
          lineItems: g.lineItems.map((l: any) => ({ id: l.id, description: l.description ?? '', customValues: l.customValues || {}, receiptQty: Number(l.receiptQty) || 0, defectQty: Number(l.defectQty || 0), remarks: l.remarks })),
        }
      : { lineItems: g.lineItems.map((l: any) => ({ id: l.id, receiptQty: Number(l.receiptQty) || 0, defectQty: Number(l.defectQty || 0), remarks: l.remarks })) }),
  });

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/public/grn/${token}`, body())).data.goodsReceipt,
    onSuccess: (gr) => { setG(structuredClone(gr)); setMsg('Saved. You can come back to this link and continue.'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const submit = useMutation({
    mutationFn: async () => { await api.patch(`/public/grn/${token}`, body()); return (await api.post(`/public/grn/${token}/submit`)).data.goodsReceipt; },
    onSuccess: (gr) => { setG(structuredClone(gr)); setMsg(''); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadSigned = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return (await api.post(`/public/grn/${token}/signed`, fd)).data.signedDocs; },
    onSuccess: (docs) => { setG((p: any) => ({ ...p, signedDocs: docs })); setMsg('Signed packing list uploaded. Thank you!'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const confirmBilling = useMutation({
    mutationFn: async () => (await api.post(`/public/grn/${token}/confirm-billing`)).data.goodsReceipt,
    onSuccess: (gr) => { setG(structuredClone(gr)); setMsg('Confirmed — material received. Thank you!'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Per-item delivery photo (B5) — camera OR gallery (accept=image/* offers both).
  const uploadLinePhoto = useMutation({
    mutationFn: async ({ lineId, file }: { lineId: string; file: File }) => {
      const fd = new FormData(); fd.append('file', file);
      return { lineId, photoUrl: (await api.post(`/public/grn/${token}/lines/${lineId}/photo`, fd)).data.photoUrl as string };
    },
    onSuccess: ({ lineId, photoUrl }) => { setG((p: any) => ({ ...p, lineItems: p.lineItems.map((l: any) => (l.id === lineId ? { ...l, photoUrl } : l)) })); setMsg('Photo added.'); },
    onError: (e) => setMsg(errMsg(e)),
  });

  if (grQ.isLoading) return <div className="p-10"><Spinner label="Loading goods receipt…" /></div>;
  if (grQ.isError || !g) {
    return (
      <Shell>
        <div className="card p-8 text-center">
          <div className="text-2xl">🔒</div>
          <h1 className="mt-2 text-lg font-bold text-navy">Link not valid</h1>
          <p className="mt-1 text-sm text-slate-500">This goods-receipt link is invalid or has expired. Please ask the office to resend it.</p>
        </div>
      </Shell>
    );
  }

  const locked = g.status !== 'DRAFT';
  const isCustom = g.mode === 'CUSTOM';
  const pdfUrl = `/api/public/grn/${token}/pdf`;
  const cols: { key: string; label: string }[] = g.customColumns || [];
  const setLine = (i: number, patch: any) => { const li = [...g.lineItems]; li[i] = { ...li[i], ...patch }; setG({ ...g, lineItems: li }); };
  const setCell = (i: number, key: string, val: string) => { const li = [...g.lineItems]; li[i] = { ...li[i], customValues: { ...(li[i].customValues || {}), [key]: val } }; setG({ ...g, lineItems: li }); };
  const addRow = () => setG({ ...g, lineItems: [...g.lineItems, { description: '', customValues: {}, receiptQty: 0, defectQty: 0 }] });
  const delRow = (i: number) => setG({ ...g, lineItems: g.lineItems.filter((_: any, idx: number) => idx !== i) });
  // Per-item photo cell (B5) — thumbnail + camera/gallery button. Compulsory for a
  // received item: turns red until a photo is attached.
  const photoCell = (l: any) => (
    <td className="text-center align-middle">
      {l.photoUrl && <a href={l.photoUrl} target="_blank" rel="noreferrer"><img src={l.photoUrl} alt="item" className="mx-auto mb-1 h-9 w-9 rounded border object-cover" /></a>}
      {!locked && (l.id
        ? <label className={`inline-block cursor-pointer text-[11px] font-medium hover:underline ${l.photoUrl ? 'text-slate-500' : (Number(l.receiptQty) > 0 ? 'text-rose-600' : 'text-navy')}`}>
            {l.photoUrl ? 'Change' : '📷 Add'}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLinePhoto.mutate({ lineId: l.id, file: f }); (e.currentTarget as HTMLInputElement).value = ''; }} />
          </label>
        : <span className="text-[10px] text-slate-400">Save first</span>)}
    </td>
  );

  return (
    <Shell>
      {locked && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-4 text-center">
          <div className="text-sm font-medium text-emerald-800">✅ This goods receipt has been submitted. Thank you.</div>
          <a href={pdfUrl} target="_blank" rel="noreferrer" className="btn-primary mt-3 inline-block text-sm">📄 Download Packing List (PDF)</a>
          <p className="mt-2 text-xs text-emerald-700">Download, sign &amp; stamp it, then upload the signed PDF below.</p>
        </div>
      )}

      {locked && (
        <div className="card mb-4 p-5">
          <div className="mb-1 text-sm font-semibold text-slate-600">Signed Packing List</div>
          {g.billingConfirmedAt ? (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">✅ Billing has confirmed material received — this goods receipt is closed.</div>
          ) : (
            <>
              <p className="mb-3 text-xs text-slate-400">Get the packing list signed &amp; stamped, then upload the signed copy here. <b>PDF only.</b> You can upload more than one. Once uploaded, tap <b>Confirm Material Received</b> to close it.</p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="btn-outline inline-block cursor-pointer text-sm">
                  {uploadSigned.isPending ? 'Uploading…' : '⬆ Upload signed PDF'}
                  <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={uploadSigned.isPending} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSigned.mutate(f); e.currentTarget.value = ''; }} />
                </label>
                <button className="btn-primary text-sm" disabled={confirmBilling.isPending || !g.signedDocs?.length} title={!g.signedDocs?.length ? 'Upload a signed copy first' : ''} onClick={() => { if (confirm('Confirm material received? This closes the goods receipt and cannot be undone.')) confirmBilling.mutate(); }}>{confirmBilling.isPending ? 'Confirming…' : '✓ Confirm Material Received'}</button>
              </div>
            </>
          )}
          {g.signedDocs?.length ? (
            <ul className="mt-3 space-y-1">
              {g.signedDocs.map((d: any) => (
                <li key={d.id} className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs">
                  <a href={d.fileUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-navy hover:underline">📄 {d.fileName}</a>
                  <span className="ml-2 shrink-0 text-slate-400">{new Date(d.uploadedAt).toLocaleDateString('en-GB')}</span>
                </li>
              ))}
            </ul>
          ) : !g.billingConfirmedAt ? <p className="mt-2 text-xs text-slate-400">No signed copy uploaded yet.</p> : null}
        </div>
      )}

      <div className="card p-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold text-navy">{g.grnNumber}</h1>
            <div className="text-sm text-slate-500">{g.project?.name || g.project?.clientName || ''}</div>
          </div>
          {isCustom && <span className="badge bg-navy-50 text-navy">Packing List</span>}
        </div>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
          <Info label="Against" v={g.doc?.docNumber} />
          <Info label="Vendor" v={g.vendorName} />
          <Info label="Site" v={g.siteAddress || g.project?.siteLocation} />
        </div>
      </div>

      <div className="card mt-4 p-5">
        <div className="mb-3 text-sm font-semibold text-slate-600">Delivery Details</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vehicle Number"><input className="input" disabled={locked} value={g.vehicleNumber || ''} onChange={(e) => setG({ ...g, vehicleNumber: e.target.value })} placeholder="e.g. NL01AB4678" /></Field>
          <Field label="Vehicle Size"><input className="input" disabled={locked} value={g.vehicleSize || ''} onChange={(e) => setG({ ...g, vehicleSize: e.target.value })} placeholder="e.g. 40 FT" /></Field>
          <Field label="Date of Invoice / Dispatch"><input className="input" type="date" disabled={locked} value={g.dispatchDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, dispatchDate: e.target.value })} /></Field>
          <Field label="Date of Delivery"><input className="input" type="date" disabled={locked} value={g.deliveryDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, deliveryDate: e.target.value })} /></Field>
          {/* Whoever is receiving on site — their name prints on the packing list's "Site Supervisor:" line. */}
          <Field label="Site Supervisor (your name)"><input className="input" disabled={locked} value={g.siteSupervisor || ''} onChange={(e) => setG({ ...g, siteSupervisor: e.target.value })} placeholder="Name of the person receiving on site" /></Field>
        </div>
      </div>

      <div className="card mt-4 p-5">
        <div className="mb-1 text-sm font-semibold text-slate-600">{isCustom ? 'Packing List Items' : 'Received Items'}</div>
        <p className="mb-3 text-xs text-slate-400">Enter what actually arrived. {isCustom ? '' : 'Accepted = Receipt − Defect.'}</p>
        <div className="overflow-x-auto">
          {isCustom ? (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-400">
                <tr>
                  <th className="w-10 text-center">#</th>
                  <th className="text-left">Description</th>
                  {cols.map((c) => <th key={c.key} className="px-1 text-center">{c.label}</th>)}
                  <th className="w-20 text-center">Qty</th>
                  <th className="w-16 text-center" title="Photo of the delivered item (compulsory)">Photo *</th>
                  {!locked && <th className="w-8" />}
                </tr>
              </thead>
              <tbody>
                {g.lineItems.map((l: any, i: number) => (
                  <tr key={l.id || `n-${i}`} className="border-b border-slate-100">
                    <td className="text-center text-slate-400">{i + 1}</td>
                    <td><input className="input" disabled={locked} value={l.description || ''} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                    {cols.map((c) => <td key={c.key} className="px-1"><input className="input text-center" disabled={locked} value={l.customValues?.[c.key] ?? ''} onChange={(e) => setCell(i, c.key, e.target.value)} /></td>)}
                    <td><input className="input text-center" type="number" disabled={locked} value={l.receiptQty} onChange={(e) => setLine(i, { receiptQty: e.target.value })} /></td>
                    {photoCell(l)}
                    {!locked && <td className="text-center"><button className="text-rose-400 hover:text-rose-600" onClick={() => delRow(i)}>✕</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-400">
                <tr>
                  <th className="text-left">Description</th>
                  <th className="w-16 text-center">PO Qty</th>
                  <th className="w-20 text-center">Remaining</th>
                  <th className="w-20 text-center">Receipt</th>
                  <th className="w-16 text-center">Defect</th>
                  <th className="w-16 text-center">Accepted</th>
                  <th className="w-16 text-center" title="Photo of the delivered item (compulsory for received items)">Photo *</th>
                </tr>
              </thead>
              <tbody>
                {g.lineItems.map((l: any, i: number) => (
                  <tr key={l.id} className="border-b border-slate-100">
                    <td className="py-1 text-xs">{l.description}</td>
                    <td className="text-center">{l.poQty}</td>
                    <td className="text-center text-slate-500">{l.remainingToReceive}</td>
                    <td><input className="input text-center" type="number" disabled={locked} value={l.receiptQty} onChange={(e) => setLine(i, { receiptQty: e.target.value })} /></td>
                    <td><input className="input text-center" type="number" disabled={locked} value={l.defectQty} onChange={(e) => setLine(i, { defectQty: e.target.value })} /></td>
                    <td className="text-center font-medium">{Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0)}</td>
                    {photoCell(l)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {isCustom && !locked && <button className="mt-2 text-xs font-medium text-navy hover:underline" onClick={addRow}>+ Add row</button>}
      </div>

      <div className="card mt-4 p-5">
        <Field label="Remarks"><textarea className="input" rows={2} disabled={locked} value={g.remarks || ''} onChange={(e) => setG({ ...g, remarks: e.target.value })} placeholder="e.g. 2 cartons damaged in transit, noted on challan" /></Field>
      </div>

      {msg && <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}

      {!locked && (
        <div className="sticky bottom-0 mt-4 rounded-t-xl bg-white/80 py-3 backdrop-blur">
          <div className="flex gap-2">
            <button className="btn-outline flex-1" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save Progress'}</button>
            <button className="btn-primary flex-1" disabled={submit.isPending} onClick={() => { if (confirm('Mark this goods receipt as completed? Once submitted it is locked and cannot be edited.')) submit.mutate(); }}>{submit.isPending ? 'Submitting…' : '✓ Mark Completed'}</button>
          </div>
          <div className="mt-2 text-center"><a href={pdfUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-navy hover:underline">📄 Preview Packing List PDF (save first to see latest)</a></div>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div><span className="text-base font-extrabold text-navy">Crystal</span> <span className="text-xs text-slate-400">Goods Receipt</span></div>
        </div>
      </div>
      <div className="mx-auto max-w-3xl px-4 py-5">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>{children}</div>;
}
function Info({ label, v }: { label: string; v?: string | null }) {
  return <div><div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div><div className="font-medium text-slate-700">{v || '—'}</div></div>;
}
