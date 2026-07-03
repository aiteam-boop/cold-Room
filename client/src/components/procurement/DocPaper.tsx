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

// Inline-editable, PDF-styled document with the company's bordered grid layout.
export default function DocPaper({ d, setD, editable, vendors }: { d: any; setD: (x: any) => void; editable: boolean; vendors: any[] }) {
  const isWO = d.type === 'WO';
  const basic = d.lineItems.filter((l: any) => !l.isLeadTime).reduce((s: number, l: any) => s + (Number(l.qty) * Number(l.unitPrice) || 0), 0);
  const gst = d.gstEnabled ? Math.round(basic * (Number(d.gstPct) / 100)) : 0;
  const final = basic + gst;
  const payTotal = PAY.reduce((s, p) => s + (Number(d[p[0]]) || 0), 0);

  const setLine = (i: number, patch: any) => setD({ ...d, lineItems: d.lineItems.map((l: any, idx: number) => (idx === i ? { ...l, ...patch } : l)) });
  const addLine = (lead = false) => setD({ ...d, lineItems: [...d.lineItems, { description: '', qty: 0, unitPrice: 0, totalPrice: 0, uom: isWO ? 'Nos.' : null, isLeadTime: lead, leadTimeText: lead ? '7 Days' : null }] });
  const delLine = (i: number) => setD({ ...d, lineItems: d.lineItems.filter((_: any, idx: number) => idx !== i) });
  // The "To," block is a single editable text. Selecting a vendor fills it;
  // vendorName is kept as the first line so lists/dashboard still show a name.
  const selectVendor = (id: string) => {
    const v = vendors.find((x) => x.id === id);
    if (!v) { setD({ ...d, vendorId: id || null }); return; }
    const telFax = [v.tel ? `Tel : ${v.tel}` : '', v.fax ? `Fax: ${v.fax}` : ''].filter(Boolean).join(', ');
    const block = [
      v.name,
      v.address,
      v.contactPerson || '',
      v.phones ? `Phone: ${v.phones}` : '',
      telFax,
      v.website ? `Website: ${v.website}` : '',
      v.gstin ? `GSTN.NO: ${v.gstin}` : '',
      v.cin ? `CIN: ${v.cin}` : '',
    ].filter(Boolean).join('\n');
    setD({ ...d, vendorId: id, vendorName: v.name, vendorAddress: block, vendorGstin: v.gstin, vendorContact: v.contactPerson, vendorPhone: v.phones });
  };
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

  const cols = 6; // Sr, Description, UOM, Qty, Unit Price, Total (UOM shown for PO + WO)

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
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.kycStatus})</option>)}
            </select>
          )}
          <TA value={d.vendorAddress} onChange={setVendorBlock} rows={6} className="font-medium" placeholder="Vendor name&#10;Address&#10;Tel / Fax&#10;GSTIN" />
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

      {/* Line items table (fully bordered) */}
      <table className={`w-full table-fixed border-collapse border ${B} text-[10.5px]`}>
        <thead>
          <tr className="bg-sky-700 text-white">
            <th className={`w-8 border ${B} p-1`}>Sr No.</th>
            <th className={`border ${B} p-1 text-left`}>Description</th>
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
              <td className={`border ${B} p-1`}><TA value={l.description} onChange={(x: string) => setLine(i, { description: x })} rows={Math.min((l.description || '').split('\n').length + 1, 10)} placeholder="Description / specification" /></td>
              <td className={`border ${B} p-1`}><U value={l.uom} onChange={(x: string) => setLine(i, { uom: x })} className="text-center" /></td>
              <td className={`border ${B} p-1`}><T value={l.qty} onChange={(x: string) => setLine(i, { qty: x })} className="text-right" /></td>
              <td className={`border ${B} p-1`}><T value={l.unitPrice} onChange={(x: string) => setLine(i, { unitPrice: x })} className="text-right" /></td>
              <td className={`border ${B} p-1 text-right font-medium`}>{(Number(l.qty) * Number(l.unitPrice) || 0).toLocaleString('en-IN')}</td>
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
            <td className={`border ${B} p-1 text-right`}>{d.gstEnabled ? gst.toLocaleString('en-IN') : '—'}</td>
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
      {editable && <div className="mt-1 flex gap-3 text-[10px]"><button className="text-navy hover:underline" onClick={() => addLine(false)}>+ Add row</button>{isWO && <button className="text-purple-600 hover:underline" onClick={() => addLine(true)}>+ Lead Time row</button>}</div>}
      <div className="text-right text-[9px] italic text-slate-400">TDS deductible as per Income Tax laws.</div>

      {/* Payment terms (6-field) */}
      <div className={`mt-4 border ${B} p-2`}>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] font-bold text-navy">PAYMENT TERMS (6-field — must total 100%)</div>
          <span className={`badge ${Math.abs(payTotal - 100) < 0.01 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{payTotal}%</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {PAY.map(([k, label, mk]) => (
            <div key={k} className={`border ${B} bg-slate-50 p-2 text-[10px]`}>
              <div className="font-semibold text-slate-600">{label}</div>
              <div className="flex items-center gap-1"><T value={d[k]} onChange={(x: string) => setD({ ...d, [k]: x })} className="w-12 text-right" />%<span className="ml-auto font-medium text-slate-500">{inr(Math.round(basic * (Number(d[k]) / 100)))}</span></div>
              <T value={d.payTriggers?.[mk]?.note} onChange={(x: string) => setD({ ...d, payTriggers: { ...d.payTriggers, [mk]: { ...d.payTriggers?.[mk], note: x } } })} className="mt-1 text-[9px]" placeholder="trigger condition" />
            </div>
          ))}
        </div>
      </div>

      {/* Terms & Conditions */}
      <div className="mt-4 text-center text-[12px] font-bold text-slate-800">TERMS &amp; CONDITIONS</div>
      <div className={`mt-1 border ${B} p-3`}>
        <div className="space-y-2">
          {(d.termsSections || []).map((s: any, i: number) => (
            <div key={i}>
              <div className="flex items-center gap-1">
                <T value={s.title} onChange={(x: string) => { const t = [...d.termsSections]; t[i] = { ...t[i], title: x }; setD({ ...d, termsSections: t }); }} className="text-[11px] font-bold text-slate-800" />
                {editable && <button className="text-[10px] text-slate-300 hover:text-red-500" onClick={() => setD({ ...d, termsSections: d.termsSections.filter((_: any, idx: number) => idx !== i) })}>✕</button>}
              </div>
              <TA value={s.text} onChange={(x: string) => { const t = [...d.termsSections]; t[i] = { ...t[i], text: x }; setD({ ...d, termsSections: t }); }} rows={Math.min(Math.ceil((s.text || '').length / 95) + 1, 8)} className="text-[10px] text-slate-600" />
            </div>
          ))}
          {editable && <button className="text-[11px] text-navy hover:underline" onClick={() => setD({ ...d, termsSections: [...(d.termsSections || []), { title: 'New Section', text: '' }] })}>+ Add section</button>}
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
