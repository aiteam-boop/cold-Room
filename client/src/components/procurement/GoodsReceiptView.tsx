import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, openAuthedFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { EmptyState, Spinner } from '../ui';
import { FileViewerModal, type ViewFile } from '../FileViewer';
import { docStatusPill, fmtDate, titleize } from '../../lib/format';

// The physical goods-receipt register: material/spares/machines arriving on site
// against an approved PO/WO. Deliberately simple — delivery details + what was
// actually received per line. No payment here; that lives on the Payment page.
export default function GoodsReceiptView({ projectId, focusId }: { projectId: string; role: string; focusId?: string }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const canRaise = canEdit('grn');
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [raising, setRaising] = useState(false);

  const grsQ = useQuery({ queryKey: ['goods-receipts', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/goods-receipts`)).data.goodsReceipts as any[] });
  const posQ = useQuery({ queryKey: ['gr-available-docs', projectId], queryFn: async () => (await api.get(`/projects/${projectId}/procurement/goods-receipts/available-docs`)).data.docs as any[] });

  const raise = useMutation({
    mutationFn: (v: { docId: string; mode: 'DIRECT' | 'CUSTOM' }) => api.post(`/projects/${projectId}/procurement/goods-receipts`, v),
    onSuccess: (r) => { setRaising(false); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); setOpenId(r.data.goodsReceipt.id); },
    onError: (e) => alert(errMsg(e)),
  });
  const delGr = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/procurement/goods-receipts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }),
    onError: (e) => alert(errMsg(e)),
  });

  if (openId) return <GoodsReceiptForm projectId={projectId} grId={openId} onClose={() => { setOpenId(null); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); }} />;
  if (grsQ.isLoading) return <Spinner label="Loading goods receipts…" />;
  const grs = grsQ.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-600">Goods Receipts ({grs.length})</h3>
        {canRaise && <button className="btn-primary text-sm" onClick={() => setRaising(true)}>+ Raise GRN</button>}
      </div>

      {raising && (
        <div className="card p-4">
          <div className="mb-1 text-sm font-medium text-slate-600">Raise a goods receipt against an approved PO/WO</div>
          <p className="mb-2 text-xs text-slate-400"><strong>Direct</strong> mirrors the PO items (received qty per PO line). <strong>Custom packing list</strong> lets you build your own rows/columns (panel sizes etc. the PO doesn't carry).</p>
          {posQ.data?.length ? (
            <div className="space-y-2">
              {posQ.data.map((d: any) => (
                <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-2 text-sm">
                  <span>
                    <span className="font-medium text-navy">{d.docNumber}</span>
                    <span className="badge ml-1 bg-slate-100 text-slate-600">{d.type}</span>
                    <span className="text-slate-500"> · {d.vendorName || '—'}</span>
                    {d.grnCount > 0 && <span className="text-xs text-slate-400"> · {d.grnCount} receipt{d.grnCount > 1 ? 's' : ''} already raised</span>}
                  </span>
                  <span className="flex gap-2">
                    <button className="btn-outline text-xs" disabled={raise.isPending} onClick={() => raise.mutate({ docId: d.id, mode: 'DIRECT' })}>Direct GRN</button>
                    <button className="btn-primary text-xs" disabled={raise.isPending} onClick={() => raise.mutate({ docId: d.id, mode: 'CUSTOM' })}>Custom Packing List</button>
                  </span>
                </div>
              ))}
            </div>
          ) : <div className="text-sm text-slate-400">No approved POs/WOs to receive against.</div>}
          <button className="btn-outline mt-2 text-xs" onClick={() => setRaising(false)}>Cancel</button>
        </div>
      )}

      {grs.length === 0 ? (
        <EmptyState title="No goods receipts yet" hint="When material, spares or machines arrive on site, raise a GRN against the relevant PO/WO to record the delivery and what was received." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-400"><tr><th className="px-4 py-2">GRN No.</th><th>Against</th><th>Vendor</th><th>Received by</th><th>Date</th><th className="pl-2">Status</th><th></th></tr></thead>
            <tbody>
              {grs.map((g) => (
                <tr key={g.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-medium text-navy">{g.grnNumber}</td>
                  <td className="text-slate-600">{g.doc?.docNumber}</td>
                  <td className="text-slate-600">{g.vendorName}</td>
                  <td className="text-slate-500">
                    {g.createdBy ? <span title={g.createdBy.name} className="text-xs">{g.createdBy.email}</span> : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="text-slate-500">{fmtDate(g.receivedDate)}</td>
                  <td className="pl-2">{g.billingConfirmedAt ? <span className="badge bg-green-100 text-green-700" title="Signed copy uploaded & billing confirmed — closed">✓ Done</span> : <span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>}</td>
                  <td className="px-2 text-right">
                    {canRaise && g.status === 'DRAFT' && <button className="mr-3 text-xs font-medium text-rose-500 hover:underline" onClick={() => confirm(`Delete draft ${g.grnNumber}? This can't be undone.`) && delGr.mutate(g.id)}>Delete</button>}
                    <button className="text-xs font-medium text-navy hover:underline" onClick={() => setOpenId(g.id)}>Open →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GoodsReceiptForm({ projectId, grId, onClose }: { projectId: string; grId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { canEdit } = useAuth();
  const [g, setG] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const grQ = useQuery({
    queryKey: ['goods-receipt', grId],
    queryFn: async () => {
      const res = (await api.get(`/projects/${projectId}/procurement/goods-receipts/${grId}`)).data;
      setG(structuredClone(res.goodsReceipt));
      return res as { goodsReceipt: any };
    },
  });

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/projects/${projectId}/procurement/goods-receipts/${grId}`, {
      vehicleNumber: g.vehicleNumber, vehicleSize: g.vehicleSize, remarks: g.remarks, siteSupervisor: g.siteSupervisor,
      // Packing-list / delivery fields (Amisha 63/64).
      dispatchDate: g.dispatchDate?.slice?.(0, 10) || null, deliveryDate: g.deliveryDate?.slice?.(0, 10) || null,
      ...(g.mode === 'CUSTOM'
        ? {
            customColumns: g.customColumns || [],
            packingListNo: g.packingListNo ? Number(g.packingListNo) : null,
            lineItems: g.lineItems.map((l: any) => ({ id: l.id, description: l.description ?? '', customValues: l.customValues || {}, receiptQty: Number(l.receiptQty) || 0, defectQty: Number(l.defectQty || 0), remarks: l.remarks })),
          }
        : { lineItems: g.lineItems.map((l: any) => ({ id: l.id, receiptQty: Number(l.receiptQty), defectQty: Number(l.defectQty || 0), remarks: l.remarks })) }),
    })).data.goodsReceipt,
    onSuccess: (gr) => { setG(structuredClone(gr)); setMsg('Saved.'); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const receive = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/receive`, {})).data.goodsReceipt,
    onSuccess: () => { setMsg('Marked received.'); grQ.refetch(); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/photo`, fd); },
    onSuccess: () => { setMsg('Photo uploaded.'); grQ.refetch(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Per-item delivery photo (B5) — office can view / add / replace it too.
  const uploadLinePhoto = useMutation({
    mutationFn: async ({ lineId, file }: { lineId: string; file: File }) => {
      const fd = new FormData(); fd.append('file', file);
      return { lineId, photoUrl: (await api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/lines/${lineId}/photo`, fd)).data.photoUrl as string };
    },
    onSuccess: ({ lineId, photoUrl }) => { setG((p: any) => ({ ...p, lineItems: p.lineItems.map((l: any) => (l.id === lineId ? { ...l, photoUrl } : l)) })); setMsg('Item photo added.'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Open all this GR's item photos in the in-app viewer, starting at the clicked one.
  const [photoViewer, setPhotoViewer] = useState<{ items: ViewFile[]; start: number } | null>(null);
  const openLinePhotos = (clickedUrl: string) => {
    const photos: ViewFile[] = (g?.lineItems ?? []).filter((l: any) => l.photoUrl).map((l: any) => ({ url: l.photoUrl, name: `${((l.description || 'item').split('\n')[0])}.jpg`, label: (l.description || '').split('\n')[0]?.slice(0, 16) }));
    setPhotoViewer({ items: photos, start: Math.max(photos.findIndex((p) => p.url === clickedUrl), 0) });
  };
  // Assign to a site engineer → generates a no-login link + emails it.
  const [copied, setCopied] = useState('');
  // Custom packing lists get a Document/Form toggle, just like PO/WO.
  const [view, setView] = useState<'document' | 'form'>('document');
  const assign = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/assign`, { siteEngineerEmail: g.siteEngineerEmail })).data as { link: string; siteEngineerEmail: string; emailed: boolean },
    onSuccess: (r) => { setMsg(r.emailed ? `Link sent to ${r.siteEngineerEmail}.` : `Link generated for ${r.siteEngineerEmail} — email not configured, copy it below.`); grQ.refetch(); },
    onError: (e) => setMsg(errMsg(e)),
  });
  // Phase 4 — signed packing-list upload (PDF only, multiple) + billing confirm.
  const uploadSigned = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('file', file); return (await api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/signed`, fd)).data.signedDocs; },
    onSuccess: (docs) => { setG((p: any) => ({ ...p, signedDocs: docs })); setMsg('Signed packing list uploaded.'); },
    onError: (e) => setMsg(errMsg(e)),
  });
  const confirmBilling = useMutation({
    mutationFn: async () => (await api.post(`/projects/${projectId}/procurement/goods-receipts/${grId}/confirm-billing`, {})).data.goodsReceipt,
    onSuccess: (gr) => { setG(structuredClone(gr)); setMsg('Material received — confirmed by billing. GRN closed.'); qc.invalidateQueries({ queryKey: ['goods-receipts', projectId] }); },
    onError: (e) => setMsg(errMsg(e)),
  });

  if (grQ.isLoading || !g) return <Spinner label="Loading goods receipt…" />;
  const editable = g.status === 'DRAFT' && canEdit('grn');
  const canGrn = canEdit('grn');
  const shareLink = g.linkToken ? `${window.location.origin}/grn/${g.linkToken}` : null;
  const isCustom = g.mode === 'CUSTOM';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button className="btn-outline text-sm" onClick={onClose}>← Back</button>
          <h2 className="text-lg font-bold text-navy">{g.grnNumber}</h2>
          {g.billingConfirmedAt
            ? <span className="badge bg-green-100 text-green-700" title="Signed copy uploaded & billing confirmed — closed">✓ Done</span>
            : <span className={`badge ${docStatusPill(g.status)}`}>{titleize(g.status)}</span>}
          {isCustom && <span className="badge bg-navy-50 text-navy">Packing List</span>}
        </div>
        <div className="flex items-center gap-2">
          {/* Document / Form toggle for the custom packing list — like PO/WO. */}
          {isCustom && (
            <div className="flex overflow-hidden rounded-lg border border-slate-300 text-xs font-medium">
              {(['document', 'form'] as const).map((v) => (
                <button key={v} className={`px-3 py-1.5 ${view === v ? 'bg-navy text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`} onClick={() => setView(v)}>{v === 'document' ? 'Document' : 'Form'}</button>
              ))}
            </div>
          )}
          <button className="btn-outline text-sm" onClick={() => openAuthedFile(`/projects/${projectId}/procurement/goods-receipts/${grId}/pdf`)}>📄 Packing List PDF</button>
          {editable && <button className="btn-primary text-sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>}
          {editable && <button className="btn-outline text-sm" disabled={receive.isPending} onClick={() => { if (confirm('Mark this goods receipt as RECEIVED? It will be locked as a record.')) { save.mutate(); receive.mutate(); } }}>✓ Mark Received</button>}
        </div>
      </div>
      {msg && <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{msg}</div>}

      {g.status === 'RECEIVED' && (
        <div className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-700">This goods receipt is confirmed and locked.</div>
      )}

      {isCustom && view === 'document' ? (
        <PackingListPaper g={g} setG={setG} editable={editable} />
      ) : (
        <>
          <div className="card p-4">
            <div className="mb-3 text-sm font-semibold text-slate-600">Against</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <F label="PO / WO Number"><input className="input bg-slate-50 text-slate-600" value={g.doc?.docNumber ?? '—'} disabled readOnly /></F>
              <F label="Vendor"><input className="input bg-slate-50 text-slate-600" value={g.vendorName ?? '—'} disabled readOnly /></F>
              <F label="Site Address"><input className="input bg-slate-50 text-slate-600" value={g.siteAddress ?? '—'} disabled readOnly /></F>
            </div>
          </div>

          <div className="card p-4">
            <div className="mb-3 text-sm font-semibold text-slate-600">Delivery Details</div>
            <div className="grid gap-3 sm:grid-cols-3">
              <G label="Vehicle Number" v={g.vehicleNumber} on={(x) => setG({ ...g, vehicleNumber: x })} ed={editable} />
              <G label="Vehicle Size" v={g.vehicleSize} on={(x) => setG({ ...g, vehicleSize: x })} ed={editable} />
              <F label="Date of Invoice / Dispatch"><input className="input" type="date" disabled={!editable} value={g.dispatchDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, dispatchDate: e.target.value })} /></F>
              <F label="Date of Delivery"><input className="input" type="date" disabled={!editable} value={g.deliveryDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, deliveryDate: e.target.value })} /></F>
              {/* Printed on the packing list's "Site Supervisor:" line. Blank falls back to who raised the GRN. */}
              <G label="Site Supervisor" v={g.siteSupervisor} on={(x) => setG({ ...g, siteSupervisor: x })} ed={editable} />
            </div>
          </div>

          {isCustom
            ? <CustomPackingList g={g} setG={setG} editable={editable} />
            : (
            <div className="card p-4">
              <div className="mb-1 text-sm font-semibold text-slate-600">Received Line Items</div>
              <p className="mb-3 text-xs text-slate-400">Enter what actually arrived. Accepted = Receipt − Defect. Prices and payment are handled on the Payment page.</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase text-slate-400">
                    <tr>
                      <th className="text-left">Description</th>
                      <th className="w-20 text-center">PO Qty</th>
                      <th className="w-24 text-center">Prev Recd</th>
                      <th className="w-24 text-center">Remaining</th>
                      <th className="w-24 text-center">Receipt</th>
                      <th className="w-20 text-center" title="Arrived but damaged">Defect</th>
                      <th className="w-20 text-center">Accepted</th>
                      <th className="w-20 text-center" title="Ordered but never arrived (PO Qty − Prev − Receipt)">Short</th>
                      <th className="w-16 text-center" title="Per-item delivery photo">Photo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.lineItems.map((l: any, i: number) => {
                      const short = Math.max((Number(l.poQty) || 0) - (Number(l.previouslyReceivedQty) || 0) - (Number(l.receiptQty) || 0), 0);
                      return (
                      <tr key={l.id} className="border-b border-slate-100">
                        <td className="py-1 text-xs">{l.description}</td>
                        <td className="text-center">{l.poQty}</td>
                        <td className="text-center">{l.previouslyReceivedQty}</td>
                        <td className="text-center text-slate-500">{l.remainingToReceive ?? Math.max(l.poQty - l.previouslyReceivedQty, 0)}</td>
                        <td><input className="input text-center" type="number" disabled={!editable} value={l.receiptQty} onChange={(e) => { const li = [...g.lineItems]; li[i] = { ...li[i], receiptQty: e.target.value }; setG({ ...g, lineItems: li }); }} /></td>
                        <td><input className="input text-center" type="number" disabled={!editable} value={l.defectQty} onChange={(e) => { const li = [...g.lineItems]; li[i] = { ...li[i], defectQty: e.target.value }; setG({ ...g, lineItems: li }); }} /></td>
                        <td className="text-center font-medium">{Math.max((Number(l.receiptQty) || 0) - (Number(l.defectQty) || 0), 0)}</td>
                        <td className={`text-center font-medium ${short > 0 ? 'text-rose-600' : 'text-slate-400'}`}>{short}</td>
                        <td className="text-center align-middle">
                          {l.photoUrl && <button type="button" onClick={() => openLinePhotos(l.photoUrl)} title="View photo"><img src={l.photoUrl} alt="item" className="mx-auto mb-1 h-9 w-9 rounded border object-cover" /></button>}
                          {editable && l.id && (
                            <label className={`inline-block cursor-pointer text-[11px] font-medium hover:underline ${l.photoUrl ? 'text-slate-500' : 'text-navy'}`}>
                              {l.photoUrl ? 'Change' : '📷 Add'}
                              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLinePhoto.mutate({ lineId: l.id, file: f }); (e.currentTarget as HTMLInputElement).value = ''; }} />
                            </label>
                          )}
                        </td>
                      </tr>
                    );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      <div className="card p-4">
        <div className="mb-1 text-sm font-semibold text-slate-600">Assign to Site Engineer</div>
        <p className="mb-3 text-xs text-slate-400">Send a no-login link to the site engineer to fill this GRN when the truck arrives — or copy the link and share it manually.</p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1"><G label="Site Engineer Email" v={g.siteEngineerEmail} on={(x) => setG({ ...g, siteEngineerEmail: x })} ed={editable} /></div>
          {editable && <button className="btn-primary text-sm" disabled={assign.isPending || !g.siteEngineerEmail} onClick={() => assign.mutate()}>📧 {g.linkToken ? 'Resend Link' : 'Send Link'}</button>}
        </div>
        {shareLink && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-slate-500" title={shareLink}>{shareLink}</span>
            <button className="btn-outline text-xs" onClick={() => { navigator.clipboard?.writeText(shareLink); setCopied('✓ Copied'); setTimeout(() => setCopied(''), 1500); }}>{copied || '📋 Copy link'}</button>
          </div>
        )}
      </div>

      {g.status === 'RECEIVED' && (
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-600">Signed Packing List & Billing</div>
            {g.billingConfirmedAt
              ? <span className="badge bg-emerald-50 text-emerald-700">✓ Material received (billing confirmed)</span>
              : <span className="badge bg-amber-50 text-amber-700">Signed copy pending</span>}
          </div>
          <p className="mb-3 mt-1 text-xs text-slate-400">Site engineer prints the packing list, gets it signed &amp; stamped, and uploads the signed PDF. Once a signed copy is in, billing confirms “material received” to close the GRN. <b>PDF only.</b></p>

          {g.signedDocs?.length ? (
            <ul className="space-y-1">
              {g.signedDocs.map((d: any) => (
                <li key={d.id} className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs">
                  <a href={d.fileUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-navy hover:underline">📄 {d.fileName}</a>
                  <span className="ml-2 shrink-0 text-slate-400">{fmtDate(d.uploadedAt)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-slate-400">No signed copy uploaded yet.</p>}

          {canGrn && !g.billingConfirmedAt && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="btn-outline inline-block cursor-pointer text-sm">
                {uploadSigned.isPending ? 'Uploading…' : '⬆ Upload signed PDF'}
                <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={uploadSigned.isPending} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSigned.mutate(f); e.currentTarget.value = ''; }} />
              </label>
              <button className="btn-primary text-sm" disabled={confirmBilling.isPending || !g.signedDocs?.length} title={!g.signedDocs?.length ? 'Upload a signed copy first' : ''} onClick={() => { if (confirm('Confirm that the material is received (signed packing list in hand)? This closes the GRN.')) confirmBilling.mutate(); }}>✓ Confirm Material Received</button>
            </div>
          )}
          {g.billingConfirmedAt && <div className="mt-2 text-xs text-emerald-700">Confirmed on {fmtDate(g.billingConfirmedAt)}.</div>}
        </div>
      )}

      <div className="card p-4">
        <div className="mb-3 text-sm font-semibold text-slate-600">Notes & Photo</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <F label="Remarks"><textarea className="input" rows={2} disabled={!editable} value={g.remarks || ''} onChange={(e) => setG({ ...g, remarks: e.target.value })} placeholder="e.g. 2 cartons damaged in transit, noted on challan" /></F>
          <F label="Material Photo">
            {g.photoUrl
              ? <button className="text-sm text-navy hover:underline" onClick={() => setPhotoViewer({ items: [{ url: g.photoUrl, name: 'GRN photo.jpg' }], start: 0 })}>🖼 View photo</button>
              : <span className="text-xs text-slate-400">Not uploaded</span>}
            {editable && <input className="input mt-1 text-xs" type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && uploadPhoto.mutate(e.target.files[0])} />}
          </F>
        </div>
      </div>
      {photoViewer && <FileViewerModal items={photoViewer.items} startIndex={photoViewer.start} title="Delivery photo" onClose={() => setPhotoViewer(null)} />}
    </div>
  );
}

// Document view of the custom packing list — the on-screen "Manifest cum Final
// Packing List" (Amisha's format), editable inline, mirrored by the Phase-3 PDF.
function PackingListPaper({ g, setG, editable }: { g: any; setG: (x: any) => void; editable: boolean }) {
  const cols: { key: string; label: string }[] = g.customColumns || [];
  const lines: any[] = g.lineItems || [];
  const p = g.project || {};
  const setLines = (li: any[]) => setG({ ...g, lineItems: li });
  const addCol = () => { const label = window.prompt('New column name (e.g. Panel Type, Width)'); if (!label?.trim()) return; const key = 'c' + Math.random().toString(36).slice(2, 8); setG({ ...g, customColumns: [...cols, { key, label: label.trim() }] }); };
  const removeCol = (key: string) => setG({ ...g, customColumns: cols.filter((c) => c.key !== key), lineItems: lines.map((l) => { const cv = { ...(l.customValues || {}) }; delete cv[key]; return { ...l, customValues: cv }; }) });
  const renameCol = (key: string, label: string) => setG({ ...g, customColumns: cols.map((c) => (c.key === key ? { ...c, label } : c)) });
  const setLine = (i: number, patch: any) => { const li = [...lines]; li[i] = { ...li[i], ...patch }; setLines(li); };
  const setCell = (i: number, key: string, val: string) => { const li = [...lines]; li[i] = { ...li[i], customValues: { ...(li[i].customValues || {}), [key]: val } }; setLines(li); };
  const addRow = () => setLines([...lines, { description: '', customValues: {}, receiptQty: 0 }]);
  const delRow = (i: number) => setLines(lines.filter((_: any, idx: number) => idx !== i));
  const totalQty = lines.reduce((s: number, l: any) => s + (Number(l.receiptQty) || 0), 0);
  const cell = 'border border-slate-300 px-2 py-1 align-top';
  const lab = 'border border-slate-300 bg-navy-50 px-2 py-1 text-[10px] font-bold uppercase text-navy';
  const inp = 'w-full bg-transparent text-xs outline-none';

  return (
    <div className="card mx-auto max-w-4xl bg-white p-6 text-xs text-slate-800">
      <div className="mb-2 flex items-start justify-end">
        <div className="text-right"><div className="text-base font-extrabold text-navy">Crystal</div><div className="text-[9px] uppercase tracking-wide text-slate-400">Cold Chain Solution Company</div></div>
      </div>
      <div className="border border-slate-400">
        <div className="border-b border-slate-400 bg-navy-50 py-1.5 text-center text-sm font-bold text-navy">MANIFEST CUM FINAL PACKING LIST</div>
        <table className="w-full border-collapse">
          <tbody>
            <tr>
              <td className={lab} style={{ width: '17%' }}>Customer Name &amp; Address</td>
              <td className={cell} colSpan={2}>{p.clientName || '—'}{p.siteLocation ? ` — ${p.siteLocation}` : ''}</td>
              <td className={lab} style={{ width: '15%' }}>PO No.</td>
              <td className={cell}>{p.clientPoNumber || '—'}</td>
            </tr>
            <tr>
              <td className={lab}>Vehicle No.</td>
              <td className={cell}><input className={inp} disabled={!editable} value={g.vehicleNumber || ''} onChange={(e) => setG({ ...g, vehicleNumber: e.target.value })} /></td>
              <td className={lab}>Vehicle Size</td>
              <td className={cell} colSpan={2}><input className={inp} disabled={!editable} value={g.vehicleSize || ''} onChange={(e) => setG({ ...g, vehicleSize: e.target.value })} /></td>
            </tr>
            <tr>
              <td className={lab}>Date of Invoice / Dispatch</td>
              <td className={cell}><input className={inp} type="date" disabled={!editable} value={g.dispatchDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, dispatchDate: e.target.value })} /></td>
              <td className={lab}>Date of Delivery</td>
              <td className={cell} colSpan={2}><input className={inp} type="date" disabled={!editable} value={g.deliveryDate?.slice?.(0, 10) || ''} onChange={(e) => setG({ ...g, deliveryDate: e.target.value })} /></td>
            </tr>
            <tr>
              <td className={`${lab} text-center`} colSpan={3}>FINAL PACKING LIST</td>
              <td className={lab}>Packing List No.</td>
              <td className={cell}><input className={inp} type="number" disabled={!editable} value={g.packingListNo ?? ''} onChange={(e) => setG({ ...g, packingListNo: e.target.value })} /></td>
            </tr>
          </tbody>
        </table>

        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="border border-slate-300 bg-navy px-1 py-1 text-white" style={{ width: '7%' }}>S.No.</th>
              <th className="border border-slate-300 bg-navy px-1 py-1 text-left text-white">Description</th>
              {cols.map((c) => (
                <th key={c.key} className="border border-slate-300 bg-navy px-1 py-1 text-white">
                  <span className="inline-flex items-center gap-1">
                    {editable
                      ? <input className="w-16 bg-transparent text-center text-[10px] font-semibold text-white outline-none placeholder:text-white/60" value={c.label} onChange={(e) => renameCol(c.key, e.target.value)} />
                      : <span>{c.label}</span>}
                    {editable && <button className="text-white/70 hover:text-white" title="Remove column" onClick={() => removeCol(c.key)}>✕</button>}
                  </span>
                </th>
              ))}
              <th className="border border-slate-300 bg-navy px-1 py-1 text-white" style={{ width: '11%' }}>Qty (Nos)</th>
              {editable && <th className="border border-slate-300 bg-navy px-1 py-1 text-white" style={{ width: '4%' }}></th>}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td className={`${cell} text-center text-slate-400`} colSpan={cols.length + 3}>No rows — use “+ Add row” below.</td></tr>
            ) : lines.map((l, i) => (
              <tr key={l.id || `new-${i}`}>
                <td className={`${cell} text-center`}>{i + 1}</td>
                <td className={cell}><input className={inp} disabled={!editable} value={l.description || ''} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                {cols.map((c) => (<td key={c.key} className={`${cell} text-center`}><input className={`${inp} text-center`} disabled={!editable} value={l.customValues?.[c.key] ?? ''} onChange={(e) => setCell(i, c.key, e.target.value)} /></td>))}
                <td className={`${cell} text-center`}><input className={`${inp} text-center`} type="number" disabled={!editable} value={l.receiptQty} onChange={(e) => setLine(i, { receiptQty: e.target.value })} /></td>
                {editable && <td className={`${cell} text-center`}><button className="text-rose-400 hover:text-rose-600" title="Remove row" onClick={() => delRow(i)}>✕</button></td>}
              </tr>
            ))}
            <tr>
              <td className={cell} colSpan={cols.length + 2}></td>
              <td className={`${cell} text-center font-bold`}>{totalQty}</td>
              {editable && <td className={cell}></td>}
            </tr>
          </tbody>
        </table>
        <div className="border-t border-slate-400 px-2 py-1.5 text-right text-[10px] font-bold uppercase text-slate-500">Received By</div>
      </div>
      {editable && <div className="mt-2 flex gap-3 text-[11px]"><button className="text-navy hover:underline" onClick={addRow}>+ Add row</button><button className="text-emerald-600 hover:underline" onClick={addCol}>+ Add column</button></div>}
    </div>
  );
}

function F({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      {children}
    </div>
  );
}

function G({ label, v, on, ed }: { label: string; v: any; on: (x: string) => void; ed: boolean }) {
  return <F label={label}><input className="input" disabled={!ed} value={v || ''} onChange={(e) => on(e.target.value)} /></F>;
}

// Mode-2 custom packing-list builder — Amisha's own rows + configurable columns
// (Panel Type, Width, Length, Sqmtr, Bundle No. by default; add/rename/remove).
// The site engineer later fills the Receipt qty against these lines.
function CustomPackingList({ g, setG, editable }: { g: any; setG: (x: any) => void; editable: boolean }) {
  const cols: { key: string; label: string }[] = g.customColumns || [];
  const lines: any[] = g.lineItems || [];
  const setLines = (li: any[]) => setG({ ...g, lineItems: li });
  const addCol = () => {
    const label = window.prompt('New column name (e.g. Panel Type, Width, Sqmtr)');
    if (!label?.trim()) return;
    const key = 'c' + Math.random().toString(36).slice(2, 8);
    setG({ ...g, customColumns: [...cols, { key, label: label.trim() }] });
  };
  const removeCol = (key: string) => setG({ ...g, customColumns: cols.filter((c) => c.key !== key), lineItems: lines.map((l) => { const cv = { ...(l.customValues || {}) }; delete cv[key]; return { ...l, customValues: cv }; }) });
  const renameCol = (key: string, label: string) => setG({ ...g, customColumns: cols.map((c) => (c.key === key ? { ...c, label } : c)) });
  const setLine = (i: number, patch: any) => { const li = [...lines]; li[i] = { ...li[i], ...patch }; setLines(li); };
  const setCell = (i: number, key: string, val: string) => { const li = [...lines]; li[i] = { ...li[i], customValues: { ...(li[i].customValues || {}), [key]: val } }; setLines(li); };
  const addRow = () => setLines([...lines, { description: '', customValues: {}, receiptQty: 0, defectQty: 0 }]);
  const delRow = (i: number) => setLines(lines.filter((_, idx) => idx !== i));

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-600">Packing List Items <span className="badge ml-1 bg-navy-50 text-navy">Custom</span></div>
        {editable && <button className="btn-outline text-xs" onClick={addCol}>+ Add column</button>}
      </div>
      <p className="mb-3 text-xs text-slate-400">Build your own rows and columns for details the PO doesn’t carry (panel sizes etc.). The site engineer fills the received quantity against each line.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-slate-400">
            <tr>
              <th className="w-8 text-center">Sr</th>
              <th className="text-left">Description</th>
              {cols.map((c) => (
                <th key={c.key} className="text-left">
                  <span className="inline-flex items-center gap-1">
                    {editable
                      ? <input className="w-24 rounded border border-slate-300 px-1 py-0.5 text-[11px] font-semibold uppercase text-slate-600" value={c.label} onChange={(e) => renameCol(c.key, e.target.value)} />
                      : <span>{c.label}</span>}
                    {editable && <button className="text-rose-400 hover:text-rose-600" title="Remove column" onClick={() => removeCol(c.key)}>✕</button>}
                  </span>
                </th>
              ))}
              <th className="w-24 text-center">Receipt Qty</th>
              {editable && <th className="w-8"></th>}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr><td colSpan={cols.length + 4} className="py-3 text-center text-xs text-slate-400">No rows yet — click “+ Add row”.</td></tr>
            ) : lines.map((l, i) => (
              <tr key={l.id || `new-${i}`} className="border-b border-slate-100">
                <td className="text-center text-slate-400">{i + 1}</td>
                <td><input className="input" disabled={!editable} value={l.description || ''} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Item / size description" /></td>
                {cols.map((c) => (
                  <td key={c.key}><input className="input" disabled={!editable} value={l.customValues?.[c.key] ?? ''} onChange={(e) => setCell(i, c.key, e.target.value)} /></td>
                ))}
                <td><input className="input text-center" type="number" disabled={!editable} value={l.receiptQty} onChange={(e) => setLine(i, { receiptQty: e.target.value })} /></td>
                {editable && <td className="text-center"><button className="text-slate-300 hover:text-red-500" title="Remove row" onClick={() => delRow(i)}>✕</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && <button className="btn-outline mt-2 text-xs" onClick={addRow}>+ Add row</button>}
    </div>
  );
}
