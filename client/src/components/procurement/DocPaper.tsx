import { inr } from '../../lib/format';

const COMPANY = {
  name: 'QUATRE AGRO ENTERPRISES PVT LTD',
  address: '501, SYNERGY BUSINESS PARK, SAHAKAR WADI, OFF AAREY ROAD, ITT BHATTI HANUMAN TEKDI, GOREGAON EAST MUMBAI 400063',
  emailWeb: 'Email: ctc@crystalgroup.in | web: www.crystalgroup.in',
  signatory: 'Akash Agrawal', designation: 'CEO',
};
const PAY = [
  ['payAdvancePct', 'Advance', 'advance'], ['payBeforeDeliveryPct', 'Before Delivery', 'beforeDelivery'],
  ['payRunningPct', 'Running', 'running'], ['payPostDeliveryPct', 'Post Delivery', 'postDelivery'],
  ['payPostCompletionPct', 'Post Completion', 'postCompletion'], ['payRetentionPct', 'Retention', 'retention'],
] as const;

const B = 'border-slate-400';

// Struck-off clauses remain part of the document (Sprint PRD §8) — this only
// drives the footnote that explains the crossed-out text.
const struckCount = (d: any) => (d.termsSections || []).filter((s: any) => s.isStruckOff).length;

// Common units of measure for line items. The line's existing value is merged
// in at render time so custom / legacy units (e.g. "Ltr", "Nos.") are kept.
const UOM_OPTIONS = [
  'Nos.', 'Pcs', 'Set', 'Pair', 'Lot', 'Job',
  'Meter', 'RMT', 'Sq.M', 'Cu.M', 'Sq.Ft', 'Ft',
  'Kg', 'MT', 'Ton', 'Ltr', 'Roll', 'Bundle', 'Box', 'Bag',
  'Hour', 'Day', 'Month',
];

import { useEffect, useMemo, useRef, useState } from 'react';

// Uses the real Crystal logo from /crystal-logo.png; falls back to a styled
// peak mark + wordmark if the image file is not present.
function CrystalLogo() {
  const [broken, setBroken] = useState(false);
  if (!broken) return <img src="/api/branding/logo" alt="Crystal" className="max-h-14 w-auto object-contain" onError={() => setBroken(true)} />;
  return (
    <div className="text-center leading-none">
      <svg width="46" height="26" viewBox="0 0 100 56" className="mx-auto"><path d="M50 4 L96 50 L74 50 L50 26 L26 50 L4 50 Z" fill="#111827" /><path d="M50 18 L84 50 L66 50 L50 34 L34 50 L16 50 Z" fill="#374151" /></svg>
      <div className="mt-0.5 text-lg font-bold tracking-tight text-slate-800">Crystal</div>
      <div className="text-[7px] uppercase tracking-wide text-slate-400">Cold Chain Solution Company</div>
    </div>
  );
}

// Renders the CEO e-signature: real signature image if /akash-signature.png
// exists, otherwise the bundled Great Vibes handwriting font.
function SignatureMark() {
  const [broken, setBroken] = useState(false);
  if (!broken) return <img src="/api/branding/signature" alt="signature" className="h-12 w-auto object-contain" onError={() => setBroken(true)} />;
  return <div className="leading-none text-blue-900" style={{ fontFamily: 'SignatureFont, cursive', fontSize: '30px' }}>Akash Agrawal</div>;
}

// The vendor's "To," block on a PO/WO. Selecting a vendor fills EXACTLY these
// lines and nothing else — name, address, Tel/Fax, Website, GSTIN, CIN — so the
// letterhead reads the way the vendor's own header does. Contact person and
// phone are separate PO fields and deliberately stay OUT of this block.
// Shared with DocBuilder's vendor picker so both selects fill it identically.
export function vendorBlock(v: {
  name?: string | null; address?: string | null; tel?: string | null; fax?: string | null;
  website?: string | null; gstin?: string | null; cin?: string | null;
}): string {
  const clean = (s: string | null | undefined) => (s ?? '').trim();
  const telFax = [clean(v.tel) && `Tel : ${clean(v.tel)}`, clean(v.fax) && `Fax: ${clean(v.fax)}`].filter(Boolean).join(', ');
  return [
    clean(v.name),
    clean(v.address),
    telFax,
    clean(v.website) && `Website: ${clean(v.website)}`,
    clean(v.gstin) && `GSTN.NO: ${clean(v.gstin)}`,
    clean(v.cin) && `CIN: ${clean(v.cin)}`,
  ].filter(Boolean).join('\n');
}

// Shared label for the PO "To" vendor dropdown — name + KYC detail (status,
// items done, and which mandatory items are still missing). Plain text (an
// <option> can't be rich), used by both DocPaper and DocBuilder's picker.
const KYC_SHORT: Record<string, string> = {
  'GST Certificate': 'GST cert', 'PAN Card': 'PAN', 'Cancelled Cheque': 'Cheque',
  'Bank Account': 'Bank', 'Email ID': 'Email', 'GST Number': 'GSTIN',
};
export function vendorKycLabel(v: any): string {
  const status = v.kycStatus || 'Missing';
  const k = v.kyc;
  // Wide (non-collapsing) em-space gap so the vendor NAME is clearly separated
  // from the KYC info — a plain <option> can't be styled, so we space it out.
  const GAP = '  '; // small em-space cushion each side of the line
  const SEP = GAP + '—'.repeat(6) + GAP; // a drawn line: run of em-dashes between the name and KYC info
  if (!k) return `${v.name}${SEP}${status}`;
  const missing = (k.mandatoryMissing || []).map((m: string) => KYC_SHORT[m] || m).join(', ');
  return `${v.name}${SEP}${status} ${k.completed}/${k.total}${missing ? ` · missing ${missing}` : ''}`;
}

// Inline-editable, PDF-styled document with the company's bordered grid layout.
export default function DocPaper({ d, setD, editable, vendors, boqHeads = [], boqItems = [], onSelectVendor }: { d: any; setD: (x: any) => void; editable: boolean; vendors: any[]; boqHeads?: string[]; boqItems?: any[]; onSelectVendor?: (id: string) => void }) {
  const isWO = d.type === 'WO';
  const basic = d.lineItems.filter((l: any) => !l.isLeadTime).reduce((s: number, l: any) => s + (Number(l.qty) * Number(l.unitPrice) || 0), 0);
  // GST charged PER LINE at that line's own rate (l.gstPct, else doc default);
  // exempt lines bear none but still sit in Basic/Final.
  // GST keeps its true decimal value (shown to 2 dp); only the Final Amount is
  // rounded to a whole rupee for a clean total.
  const gst = d.gstEnabled ? d.lineItems.filter((l: any) => !l.isLeadTime && !l.gstExempt).reduce((s: number, l: any) => {
    const rate = l.gstPct != null ? Number(l.gstPct) : Number(d.gstPct);
    return s + (Number(l.qty) * Number(l.unitPrice) || 0) * (rate / 100);
  }, 0) : 0;
  const final = Math.round(basic + gst);
  const gstRateOptions = [...new Set([5, 12, 18, 28, Number(d.gstPct) > 0 ? Number(d.gstPct) : 18])].sort((a: number, b: number) => a - b);
  // Per-line GST: if taxable lines use more than one rate, this PO carries
  // "individual" GST — so the flat gstPct label (e.g. 18%) would be misleading.
  // We flag it and show the actual blended rate instead. Purely derived, no schema.
  const taxRateSet = new Set<number>(d.lineItems.filter((l: any) => !l.isLeadTime && !l.gstExempt).map((l: any) => (l.gstPct != null ? Number(l.gstPct) : Number(d.gstPct))));
  const mixedGst = !!d.gstEnabled && taxRateSet.size > 1;
  const uniformGstRate = taxRateSet.size === 1 ? [...taxRateSet][0] : null;
  const effGstPct = basic > 0 ? Math.round((gst / basic) * 1000) / 10 : Number(d.gstPct);
  const gstLabel = mixedGst ? `individual rates · ~${effGstPct}%` : `${uniformGstRate ?? d.gstPct}%`;
  // The base each payment-term % is taken from — final (incl. GST) or basic.
  const payBase = d.payGstInclusive ? final : basic;
  // GST-inclusive advance-on-basic split (advance carries no GST unless it's 100%);
  // the remaining milestones absorb the balance so the total stays `final`.
  const advPct = Number(d.payAdvancePct) || 0;
  const gstSplit = !!d.payGstInclusive && advPct > 0 && advPct < 100;
  const advanceAmount = gstSplit ? Math.round(basic * (advPct / 100)) : 0;
  const balance = gstSplit ? final - advanceAmount : 0;
  const nonAdvPctSum = 100 - advPct;
  const payTotal = PAY.reduce((s, p) => s + (Number(d[p[0]]) || 0), 0);

  const setLine = (i: number, patch: any) => setD({ ...d, lineItems: d.lineItems.map((l: any, idx: number) => (idx === i ? { ...l, ...patch } : l)) });
  const addLine = (lead = false) => setD({ ...d, lineItems: [...d.lineItems, { description: '', qty: 0, unitPrice: 0, totalPrice: 0, uom: isWO ? 'Nos.' : null, isLeadTime: lead, leadTimeText: lead ? '7 Days' : null }] });
  const delLine = (i: number) => setD({ ...d, lineItems: d.lineItems.filter((_: any, idx: number) => idx !== i) });
  // "Head then many items" (D2): assign one head to several lines at once. Touches
  // ONLY boqHead; `onlyEmpty` leaves lines that already have a head untouched.
  const [bulkHead, setBulkHead] = useState('');
  const applyHeadToLines = (head: string, onlyEmpty: boolean) => {
    if (!head) return;
    setD({ ...d, lineItems: d.lineItems.map((l: any) => (l.isLeadTime || (onlyEmpty && l.boqHead) ? l : { ...l, boqHead: head })) });
  };
  // Link a line to a BOQ item (same rule as the Form view): sets the link only —
  // the typed description is NOT overwritten. The head auto-fills from the item's
  // category when none is chosen, and the unit fills in.
  const selectBoqItem = (i: number, boqItemId: string) => {
    if (!boqItemId) { setLine(i, { boqItemId: null }); return; }
    const b = boqItems.find((x: any) => x.id === boqItemId);
    if (!b) return;
    setLine(i, { boqItemId, uom: b.unit ?? null, ...(!d.lineItems?.[i]?.boqHead && b.category ? { boqHead: b.category } : {}) });
  };
  const boqItemName = (l: any) => (l.boqItem?.description ?? boqItems.find((x: any) => x.id === l.boqItemId)?.description ?? '').split('\n')[0];
  // "Head then item" (D2): a line with a head lists only that head's items (+ the
  // linked one, kept visible). No head → all items.
  const itemsForLine = (l: any) => {
    let list = l.boqHead ? boqItems.filter((b: any) => b.category === l.boqHead) : boqItems;
    if (l.boqItemId && !list.some((b: any) => b.id === l.boqItemId)) {
      const cur = boqItems.find((b: any) => b.id === l.boqItemId);
      if (cur) list = [cur, ...list];
    }
    return list;
  };

  // User-added item columns (e.g. HSN Code, Make, Size). The definitions live on
  // the doc; each row's value lives in its own customValues map.
  const customCols: { key: string; label: string }[] = Array.isArray(d.customColumns) ? d.customColumns : [];
  const newColKey = () => 'c' + Math.random().toString(36).slice(2, 8);
  const addCol = () => setD({ ...d, customColumns: [...customCols, { key: newColKey(), label: 'New Column' }] });
  const setColLabel = (key: string, label: string) => setD({ ...d, customColumns: customCols.map((c) => (c.key === key ? { ...c, label } : c)) });
  const delCol = (key: string) => setD({ ...d, customColumns: customCols.filter((c) => c.key !== key), lineItems: d.lineItems.map((l: any) => { const cv = { ...(l.customValues || {}) }; delete cv[key]; return { ...l, customValues: cv }; }) });
  const setCell = (i: number, key: string, val: string) => setLine(i, { customValues: { ...(d.lineItems[i].customValues || {}), [key]: val } });
  // The "To," block is a single editable text. Selecting a vendor fills it;
  // vendorName is kept as the first line so lists/dashboard still show a name.
  // Prefer the parent's handler (it also gates on vendor KYC completeness); fall
  // back to a plain local fill when used standalone.
  const selectVendor = onSelectVendor ?? ((id: string) => {
    const v = vendors.find((x) => x.id === id);
    if (!v) { setD({ ...d, vendorId: id || null }); return; }
    setD({ ...d, vendorId: id, vendorName: v.name, vendorAddress: vendorBlock(v), vendorGstin: v.gstin, vendorContact: v.contactPerson, vendorPhone: v.phones });
  });
  const setVendorBlock = (x: string) => setD({ ...d, vendorAddress: x, vendorName: (x.split('\n')[0] || '').trim() });

  // Stable component identity (memoized by `editable`) so inputs don't remount
  // and lose focus on every keystroke.
  const T = useMemo(() => function TInput({ value, onChange, className = '', placeholder = '' }: any) {
    return <input className={`inp-inline ${className}`} disabled={!editable} value={value ?? ''} placeholder={editable ? placeholder : ''} onChange={(e) => onChange(e.target.value)} />;
  }, [editable]);
  const TA = useMemo(() => function TArea({ value, onChange, className = '', rows = 2, placeholder = 'type here…' }: any) {
    return <textarea className={`inp-inline resize-none ${className}`} disabled={!editable} rows={rows} value={value ?? ''} placeholder={editable ? placeholder : ''} onChange={(e) => onChange(e.target.value)} />;
  }, [editable]);
  // UOM combobox: click to open the full list (always re-openable), or type a
  // custom unit. Typing filters the list; a non-listed value is kept as-is.
  const U = useMemo(() => function UCombo({ value, onChange, className = '' }: any) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!open) return;
      const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
      document.addEventListener('mousedown', h);
      return () => document.removeEventListener('mousedown', h);
    }, [open]);
    const q = (value ?? '').toLowerCase();
    const filtered = UOM_OPTIONS.filter((u) => u.toLowerCase().includes(q));
    const list = filtered.length ? filtered : UOM_OPTIONS;
    return (
      <div ref={ref} className="relative">
        <input className={`inp-inline ${className}`} disabled={!editable} value={value ?? ''} placeholder={editable ? 'UOM' : ''}
          onChange={(e) => onChange(e.target.value)} onFocus={() => setOpen(true)} onClick={() => setOpen(true)} />
        {open && editable && (
          <div className="absolute left-0 top-full z-50 mt-0.5 max-h-40 w-full min-w-[68px] overflow-auto rounded border border-slate-300 bg-white text-left shadow-lg">
            {list.map((u) => (
              <div key={u} className="cursor-pointer px-2 py-1 hover:bg-sky-100"
                onMouseDown={(e) => { e.preventDefault(); onChange(u); setOpen(false); }}>{u}</div>
            ))}
          </div>
        )}
      </div>
    );
  }, [editable]);

  const cols = 6 + customCols.length; // Sr, Description, [custom…], UOM, Qty, Unit Price, Total

  return (
    <div className="doc-sheet rounded-lg p-6 text-[11px] leading-snug text-slate-800">
      {/* Header row: company (left) + logo (right) */}
      <div className={`flex border ${B}`}>
        <div className={`flex-1 border-r ${B} p-2`}>
          <div className="text-base font-bold text-slate-900">{COMPANY.name}</div>
          <div className="mt-0.5 text-[9px] font-medium text-slate-600">{COMPANY.address}</div>
          <div className="text-[9px] font-semibold text-blue-700">{COMPANY.emailWeb}</div>
        </div>
        <div className="grid w-36 place-items-center p-2"><CrystalLogo /></div>
      </div>

      {/* Title bar */}
      <div className={`border-x border-b ${B} bg-slate-100 py-0.5 text-center text-[12px] font-bold text-slate-800`}>{isWO ? 'Work Order' : 'Purchase Order'}</div>

      {/* To (vendor) + Date/No/Quotation cells */}
      <div className={`flex border-x ${B}`}>
        <div className={`flex-1 border-r ${B} p-2`}>
          <div className="font-bold">To,</div>
          {editable && (
            <select className={`mb-1 mt-1 w-full rounded border ${B} px-1 py-0.5 text-[10px] text-slate-500`} value={d.vendorId || ''} onChange={(e) => selectVendor(e.target.value)}>
              <option value="">— choose vendor / type manually —</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{vendorKycLabel(v)}</option>)}
            </select>
          )}
          <TA value={d.vendorAddress} onChange={setVendorBlock} rows={6} className="font-medium" placeholder="Vendor name&#10;Address&#10;Tel / Fax&#10;Website&#10;GSTN.NO&#10;CIN" />
        </div>
        <div className="flex w-56 shrink-0 flex-col">
          <div className={`flex flex-1 items-center justify-center overflow-hidden border-b ${B} px-2 py-1 text-center`}>Date : {new Date(d.docDate).toLocaleDateString('en-GB')}</div>
          <div className={`flex flex-1 items-center justify-center gap-1 overflow-hidden border-b ${B} px-2 py-1 text-center font-semibold`}>
            <span className="shrink-0">{isWO ? 'WO' : 'PO'} No.:</span>
            <T value={d.docNumber} onChange={(x: string) => setD({ ...d, docNumber: x })} className="min-w-0 flex-1 text-center font-semibold" placeholder="—" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden px-2 pb-3 pt-1 text-center">
            <div className="text-[10px] leading-tight">Against Quotation:</div>
            <T value={d.againstQuotation} onChange={(x: string) => setD({ ...d, againstQuotation: x })} className="mb-1 w-full break-all text-center text-[10px] font-semibold" placeholder="—" />
            {/* Mirrors the PDF, which prints the delivery commitment here. It is
                edited on the Form tab, not on the document itself. */}
            {d.promisedDeliveryDate && (
              <div className="text-[10px] font-semibold leading-tight">
                Delivery Date: {new Date(d.promisedDeliveryDate).toLocaleDateString('en-GB')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Invoice To | Ship To */}
      <div className={`flex border-x border-t ${B}`}>
        <div className={`flex-1 border-r ${B} p-2`}>
          <div className="font-bold">Invoice To:</div>
          <TA value={d.invoiceTo} onChange={(x: string) => setD({ ...d, invoiceTo: x })} rows={6} className="text-[10px]" />
        </div>
        <div className="flex-1 p-2">
          <div className="font-bold">{isWO ? 'Site Address:' : 'Ship To:'}</div>
          <TA value={isWO ? d.siteAddress : d.shipTo} onChange={(x: string) => setD(isWO ? { ...d, siteAddress: x } : { ...d, shipTo: x })} rows={6} className="text-[10px]" />
        </div>
      </div>

      {/* Head then many items (D2) — internal helper bar, never on the PDF. */}
      {editable && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded bg-amber-50/70 px-2 py-1.5 text-[10px] print:hidden">
          <span className="font-medium text-amber-700">🔒 Set head for many:</span>
          <select className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[10px]" value={bulkHead} onChange={(e) => setBulkHead(e.target.value)}>
            <option value="">— choose a head —</option>
            {boqHeads.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
          <button className="rounded border border-slate-300 bg-white px-1.5 py-0.5 disabled:opacity-40" disabled={!bulkHead} onClick={() => applyHeadToLines(bulkHead, true)} title="Fill only the lines that have no head yet">Apply to empty</button>
          <button className="rounded border border-slate-300 bg-white px-1.5 py-0.5 disabled:opacity-40" disabled={!bulkHead} onClick={() => applyHeadToLines(bulkHead, false)} title="Overwrite the head on every line">Apply to all</button>
          <span className="text-slate-400">(internal — not on PDF)</span>
        </div>
      )}
      {/* Line items table (fully bordered) */}
      <table className={`w-full table-fixed border-collapse border ${B} text-[10.5px]`}>
        <thead>
          <tr className="bg-sky-700 text-white">
            <th className={`w-8 border ${B} p-1`}>Sr No.</th>
            <th className={`border ${B} p-1 text-left`}>Description</th>
            {customCols.map((c) => (
              <th key={c.key} className={`w-20 border ${B} p-1`}>
                {editable ? (
                  <span className="flex items-center justify-center gap-0.5">
                    <input className="w-full bg-transparent text-center text-white placeholder-sky-200 outline-none" value={c.label} onChange={(e) => setColLabel(c.key, e.target.value)} placeholder="Column" />
                    <button title="Remove column" className="text-sky-200 hover:text-red-300" onClick={() => delCol(c.key)}>✕</button>
                  </span>
                ) : c.label}
              </th>
            ))}
            <th className={`w-12 border ${B} p-1`}>UOM</th>
            <th className={`w-12 border ${B} p-1`}>Qty</th>
            <th className={`w-20 border ${B} p-1`}>Unit Price</th>
            <th className={`w-24 border ${B} p-1`}>Total Price</th>
            {editable && <th className="w-5"></th>}
          </tr>
        </thead>
        <tbody>
          {d.lineItems.map((l: any, i: number) => l.isLeadTime ? (
            <tr key={i}>
              <td className={`border ${B} text-center text-purple-500`}>⏱</td>
              <td className={`border ${B} p-1 text-purple-700`} colSpan={cols - 1}><span className="inline-flex items-center gap-1">Lead Time: <T value={l.leadTimeText} onChange={(x: string) => setLine(i, { leadTimeText: x })} className="w-28" /></span></td>
              {editable && <td><button className="text-slate-300 hover:text-red-500" onClick={() => delLine(i)}>✕</button></td>}
            </tr>
          ) : (
            <tr key={i} className="align-top">
              <td className={`border ${B} p-1 text-center`}>{i + 1}</td>
              <td className={`border ${B} p-1`}>
                <TA value={l.description} onChange={(x: string) => setLine(i, { description: x })} rows={Math.min((l.description || '').split('\n').length + 1, 10)} placeholder="Description / specification" />
                {/* BOQ Item + head — INTERNAL: shown here for convenience but NEVER
                    printed on the vendor PO PDF (the PDF is generated server-side without them). */}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-amber-50/60 px-1 py-0.5 text-[10px] text-slate-500 print:hidden">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="whitespace-nowrap font-medium text-amber-700">BOQ Item</span>
                    {editable ? (
                      <select className="min-w-0 rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px]" value={l.boqItemId || ''} onChange={(e) => selectBoqItem(i, e.target.value)}>
                        <option value="">Other (no specific BOQ item)</option>
                        {itemsForLine(l).map((b: any) => <option key={b.id} value={b.id}>{b.srNo ? `${b.srNo}. ` : ''}{(b.description || '').slice(0, 50)}</option>)}
                      </select>
                    ) : (
                      <span className="text-slate-600">{boqItemName(l) || 'Other'}</span>
                    )}
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="whitespace-nowrap font-medium text-amber-700">🔒 Head *</span>
                    {editable ? (
                      <select className={`min-w-0 rounded border bg-white px-1 py-0.5 text-[10px] ${!l.boqHead ? 'border-amber-400' : 'border-slate-200'}`} value={l.boqHead || ''} onChange={(e) => setLine(i, { boqHead: e.target.value || null })}>
                        <option value="">— select head —</option>
                        {boqHeads.map((h) => <option key={h} value={h}>{h}</option>)}
                        {l.boqHead && !boqHeads.includes(l.boqHead) && <option value={l.boqHead}>{l.boqHead}</option>}
                      </select>
                    ) : (
                      <span className={l.boqHead ? 'text-slate-600' : 'text-amber-600'}>{l.boqHead || 'not set'}</span>
                    )}
                  </span>
                  <span className="whitespace-nowrap text-slate-400">(internal — not on PDF)</span>
                </div>
              </td>
              {customCols.map((c) => (
                <td key={c.key} className={`border ${B} p-1`}><T value={l.customValues?.[c.key] ?? ''} onChange={(x: string) => setCell(i, c.key, x)} className="text-center" /></td>
              ))}
              <td className={`border ${B} p-1`}><U value={l.uom} onChange={(x: string) => setLine(i, { uom: x })} className="text-center" /></td>
              <td className={`border ${B} p-1`}><T value={l.qty} onChange={(x: string) => setLine(i, { qty: x })} className="text-right" /></td>
              <td className={`border ${B} p-1`}><T value={l.unitPrice} onChange={(x: string) => setLine(i, { unitPrice: x })} className="text-right" /></td>
              <td className={`border ${B} p-1 text-right font-medium`}>
                {(Number(l.qty) * Number(l.unitPrice) || 0).toLocaleString('en-IN')}
                {/* Per-line GST rate. "No GST" = exempt (type why); else this line's rate. */}
                {d.gstEnabled && (editable
                  ? <div className="mt-0.5 flex flex-col items-end gap-0.5">
                      <select className={`rounded border ${B} px-1 py-0.5 text-[8px] font-normal`} value={l.gstExempt ? 'none' : String(l.gstPct != null ? l.gstPct : d.gstPct)} onChange={(e) => { const v = e.target.value; if (v === 'none') setLine(i, { gstExempt: true, gstPct: null }); else setLine(i, { gstExempt: false, gstPct: Number(v), gstExemptRemark: null }); }}>
                        <option value="none">No GST</option>
                        {gstRateOptions.map((r: number) => <option key={r} value={r}>GST {r}%</option>)}
                      </select>
                      {l.gstExempt && <input className={`w-28 rounded border ${B} px-1 py-0.5 text-[8px] font-normal`} placeholder="why? e.g. refundable" value={l.gstExemptRemark || ''} onChange={(e) => setLine(i, { gstExemptRemark: e.target.value })} />}
                    </div>
                  : l.gstExempt ? <div className="text-[8px] font-normal text-slate-400">No GST{l.gstExemptRemark ? ` — ${l.gstExemptRemark}` : ''}</div>
                    : <div className="text-[8px] font-normal text-slate-400">GST {l.gstPct != null ? l.gstPct : d.gstPct}%</div>)}
              </td>
              {editable && <td><button className="text-slate-300 hover:text-red-500" onClick={() => delLine(i)}>✕</button></td>}
            </tr>
          ))}
          {/* Totals rows inside the table (right-aligned like the format) */}
          <tr>
            <td className="border-0" colSpan={cols - 2}></td>
            <td className={`border ${B} bg-slate-50 p-1 text-right font-bold`}>Basic Amount</td>
            <td className={`border ${B} p-1 text-right font-bold`}>{basic.toLocaleString('en-IN')}</td>
            {editable && <td></td>}
          </tr>
          <tr>
            <td className="border-0" colSpan={cols - 2}></td>
            <td className={`border ${B} bg-slate-50 p-1 text-right`}>
              {isWO && <input type="checkbox" className="mr-1" disabled={!editable} checked={d.gstEnabled} onChange={(e) => setD({ ...d, gstEnabled: e.target.checked })} />}
              GST {d.gstEnabled && <select className={`rounded border ${B} text-[9px]`} disabled={!editable} value={d.gstPct} onChange={(e) => setD({ ...d, gstPct: Number(e.target.value) })}>{[0, 5, 12, 18, 28].map((g) => <option key={g} value={g}>{g}%</option>)}</select>}
            </td>
            <td className={`border ${B} p-1 text-right`}>{d.gstEnabled ? gst.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</td>
            {editable && <td></td>}
          </tr>
          <tr>
            <td className="border-0" colSpan={cols - 2}></td>
            <td className={`border ${B} bg-slate-50 p-1 text-right text-[12px] font-bold text-navy`}>Final Amount</td>
            <td className={`border ${B} p-1 text-right text-[12px] font-bold text-navy`}>{final.toLocaleString('en-IN')}</td>
            {editable && <td></td>}
          </tr>
        </tbody>
      </table>
      {editable && <div className="mt-1 flex gap-3 text-[10px]"><button className="text-navy hover:underline" onClick={() => addLine(false)}>+ Add row</button><button className="text-emerald-600 hover:underline" onClick={addCol}>+ Add column</button>{isWO && <button className="text-purple-600 hover:underline" onClick={() => addLine(true)}>+ Lead Time row</button>}</div>}
      <div className="text-right text-[9px] italic text-slate-400">TDS deductible as per Income Tax laws.</div>

      {/* Payment terms (6-field) */}
      <div className={`mt-4 border ${B} p-2`}>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] font-bold text-navy">PAYMENT TERMS (6-field — must total 100%)</div>
          <span className={`badge ${Math.abs(payTotal - 100) < 0.01 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{payTotal}%</span>
        </div>
        {/* Which amount the % is taken from — final (incl. GST) or basic. The
            milestones (Payment Pipeline) follow the same choice. */}
        <div className="mb-2 flex flex-wrap items-center gap-3 rounded bg-slate-50 px-2 py-1 text-[10px]">
          <span className="font-semibold text-slate-600">Payment amount includes:</span>
          <label className="flex items-center gap-1"><input type="radio" disabled={!editable} checked={!!d.payGstInclusive} onChange={() => setD({ ...d, payGstInclusive: true })} />GST ({d.gstEnabled ? `${gstLabel} ` : ''}inclusive) — {inr(final)}</label>
          <label className="flex items-center gap-1"><input type="radio" disabled={!editable} checked={!d.payGstInclusive} onChange={() => setD({ ...d, payGstInclusive: false })} />Basic only — {inr(basic)}</label>
        </div>
        {/* Flag when the PO carries per-line (individual) GST — the flat rate no longer applies. */}
        {mixedGst && (
          <div className="mb-2 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
            ⓘ Individual GST rates on this PO ({[...taxRateSet].sort((a, b) => a - b).map((r) => `${r}%`).join(', ')}) — total GST {inr(gst)} (~{effGstPct}% overall, not a flat {d.gstPct}%).
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          {PAY.map(([k, label, mk]) => {
            const pct = Number(d[k]) || 0;
            // GST-inclusive: advance on BASIC (GST due on delivery, not advance),
            // remaining milestones absorb the balance so the total stays the full
            // GST-inclusive amount. Advance 100% / Basic-only follow payBase.
            const amt = gstSplit && k === 'payAdvancePct' ? advanceAmount
              : gstSplit && nonAdvPctSum > 0 ? Math.round(balance * (pct / nonAdvPctSum))
              : Math.round(payBase * (pct / 100));
            return (
              <div key={k} className={`border ${B} bg-slate-50 p-2 text-[10px]`}>
                <div className="font-semibold text-slate-600">{label}</div>
                <div className="flex items-center gap-1"><T value={d[k]} onChange={(x: string) => setD({ ...d, [k]: x })} className="w-12 text-right" />%<span className="ml-auto font-medium text-slate-500">{inr(amt)}</span></div>
                <T value={d.payTriggers?.[mk]?.note} onChange={(x: string) => setD({ ...d, payTriggers: { ...d.payTriggers, [mk]: { ...d.payTriggers?.[mk], note: x } } })} className="mt-1 text-[9px]" placeholder="trigger condition" />
              </div>
            );
          })}
        </div>
      </div>

      {/* Terms & Conditions — struck-off clauses stay in the document, greyed and
          crossed out, with a footnote. Only custom clauses can be deleted; locked
          (legal/compliance) clauses can neither be edited nor struck off. */}
      <div className="mt-4 text-center text-[12px] font-bold text-slate-800">TERMS &amp; CONDITIONS</div>
      <div className={`mt-1 border ${B} p-3`}>
        <div className="space-y-2">
          {(d.termsSections || []).map((s: any, i: number) => {
            const struck = !!s.isStruckOff;
            const patch = (p: any) => { const t = [...d.termsSections]; t[i] = { ...t[i], ...p }; setD({ ...d, termsSections: t }); };
            return (
              <div key={i} className={struck ? 'opacity-60' : ''}>
                <div className="flex items-center gap-1">
                  {/* Any clause heading is editable EXCEPT locked legal/compliance
                      ones, which must survive untouched. */}
                  {s.isLocked ? (
                    <span className={`flex-1 text-[11px] font-bold ${struck ? 'text-slate-500 line-through' : 'text-slate-800'}`}>{s.title}</span>
                  ) : (
                    <T value={s.title} onChange={(x: string) => patch({ title: x })} className={`flex-1 text-[11px] font-bold ${struck ? 'text-slate-500 line-through' : 'text-slate-800'}`} />
                  )}
                  {s.isLocked && <span className="shrink-0 text-[9px] text-slate-400" title="Legal / compliance clause — cannot be edited or struck off">🔒</span>}
                  {editable && !s.isLocked && (
                    <button className={`shrink-0 text-[9px] ${struck ? 'text-blue-600' : 'text-slate-400'} hover:underline`}
                      onClick={() => patch({ isStruckOff: !struck, struckOffAt: struck ? null : new Date().toISOString() })}>
                      {struck ? 'Undo Strike-off' : 'Strike off'}
                    </button>
                  )}
                  {/* Standard clauses are never deletable — strike them off instead. */}
                  {editable && s.isCustom && <button className="shrink-0 text-[10px] text-slate-300 hover:text-red-500" onClick={() => setD({ ...d, termsSections: d.termsSections.filter((_: any, idx: number) => idx !== i) })}>✕</button>}
                </div>
                <TA value={s.text} onChange={(x: string) => patch({ text: x })} rows={Math.min(Math.ceil((s.text || '').length / 95) + 1, 8)}
                  className={`text-[10px] ${struck ? 'text-slate-400 line-through' : 'text-slate-600'}`} />
              </div>
            );
          })}
          {struckCount(d) > 0 && (
            <div className="pt-1 text-[9px] italic text-slate-500">
              * {struckCount(d)} clause{struckCount(d) > 1 ? 's' : ''} struck off by mutual agreement — appears crossed out in the PDF, not removed.
            </div>
          )}
          {editable && <button className="text-[11px] text-navy hover:underline" onClick={() => setD({ ...d, termsSections: [...(d.termsSections || []), { title: 'New Section', text: '', isCustom: true, isLocked: false, isStruckOff: false, struckOffAt: null }] })}>+ Add section</button>}
        </div>
      </div>

      {/* Signature block */}
      <div className={`mt-4 flex border ${B} text-[11px]`}>
        <div className={`flex-1 border-r ${B} p-3`}>
          <div className="font-bold">{COMPANY.name}</div>
          {d.esignApplied ? <div className="mt-1 flex items-end gap-2"><SignatureMark /><span className="text-[9px] text-slate-400">(e-signed)</span></div> : <div className="h-9" />}
          <div className="mt-1">{COMPANY.signatory}</div>
          <div>{COMPANY.designation}</div>
        </div>
        <div className="flex-1 p-3">
          <div className="font-bold">{isWO ? 'For Vendor' : 'For Supplier'}</div>
          <div className="mt-2 text-slate-400">Name:</div>
          <div className="text-slate-400">Designation:</div>
          <div className="text-slate-400">Date:</div>
          <div className="text-slate-400">Sign and Stamp:</div>
        </div>
      </div>
    </div>
  );
}
