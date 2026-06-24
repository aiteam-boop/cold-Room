import { prisma } from '../lib/prisma';

// ── Company constants (from PO_Format_Final_PO_Doors.pdf) ───────────────────
export const COMPANY = {
  name: 'QUATRE AGRO ENTERPRISES PVT LTD',
  address: '501, SYNERGY BUSINESS PARK, SAHAKAR WADI, OFF AAREY ROAD, ITT BHATTI HANUMAN TEKDI, GOREGAON EAST MUMBAI 400063',
  email: 'ctc@crystalgroup.in',
  web: 'www.crystalgroup.in',
  // Standard billing ("Invoice To") block — editable per PRD but defaults here.
  invoiceTo: [
    'Quatre Agro Enterprises Pvt. Ltd.',
    '309, Virwani Industrial Estate, B Wing -3rd Floor',
    'Western Express Highway, Goregoan-East. Mumbai',
    '022-40352000, Fax No. 2012',
    'CIN-U01500MH2014PTC252008',
    'GSTIN/UIN: 27AAACQ3481E1ZJ',
    'State Name : Maharashtra, Code : 27',
  ].join('\n'),
  signatoryName: 'Akash Agrawal',
  signatoryDesignation: 'CEO',
};

// ── 6-field payment terms keys ──────────────────────────────────────────────
export const PAY_FIELDS = [
  { key: 'advance', name: 'Advance', pct: 'payAdvancePct' },
  { key: 'beforeDelivery', name: 'Before Delivery', pct: 'payBeforeDeliveryPct' },
  { key: 'running', name: 'Running', pct: 'payRunningPct' },
  { key: 'postDelivery', name: 'Post Delivery', pct: 'payPostDeliveryPct' },
  { key: 'postCompletion', name: 'Post Completion', pct: 'payPostCompletionPct' },
  { key: 'retention', name: 'Retention', pct: 'payRetentionPct' },
] as const;

// ── Document numbering (company-wide sequential) ────────────────────────────
// PO-IN###, WO-QAS-###, GRN-QAS-###. Continues from the highest existing.
async function nextSeq(kind: 'PO' | 'WO' | 'GRN'): Promise<string> {
  if (kind === 'GRN') {
    const all = await prisma.gRN.findMany({ select: { grnNumber: true } });
    const max = all.reduce((m, g) => Math.max(m, parseInt((g.grnNumber.match(/(\d+)$/) || [])[1] || '0', 10) || 0), 0);
    return `GRN-QAS-${String(Math.max(max, 0) + 1).padStart(3, '0')}`;
  }
  const docs = await prisma.procurementDoc.findMany({ where: { type: kind }, select: { docNumber: true } });
  const max = docs.reduce((m, d) => Math.max(m, parseInt((d.docNumber.match(/(\d+)$/) || [])[1] || '0', 10) || 0), 0);
  if (kind === 'PO') return `PO-IN${Math.max(max, 783) + 1}`;       // continue after sample PO-IN783
  return `WO-QAS-${String(Math.max(max, 1) + 1).padStart(3, '0')}`; // continue after sample WO-QAS-001
}
export const nextDocNumber = nextSeq;

// ── Totals ──────────────────────────────────────────────────────────────────
export function computeTotals(
  lines: { qty: number; unitPrice: number; totalPrice?: number; isLeadTime?: boolean }[],
  gstEnabled: boolean,
  gstPct: number,
  overrides?: { basicAmount?: number; gstAmount?: number; finalAmount?: number }
) {
  const basic = overrides?.basicAmount ??
    lines.filter((l) => !l.isLeadTime).reduce((s, l) => s + (l.totalPrice ?? l.qty * l.unitPrice), 0);
  const gst = !gstEnabled ? 0 : (overrides?.gstAmount ?? Math.round(basic * (gstPct / 100) * 100) / 100);
  const final = overrides?.finalAmount ?? Math.round((basic + gst) * 100) / 100;
  return { basicAmount: Math.round(basic * 100) / 100, gstAmount: gst, finalAmount: final };
}

// ── Payment milestone generation (one per non-zero field) ───────────────────
export interface PayTriggerMeta { [key: string]: { note?: string; inr?: number; expectedDate?: string } }
export function buildMilestones(doc: {
  basicAmount: number;
  payAdvancePct: number; payBeforeDeliveryPct: number; payRunningPct: number;
  payPostDeliveryPct: number; payPostCompletionPct: number; payRetentionPct: number;
  payTriggers?: string | null;
}) {
  const meta: PayTriggerMeta = doc.payTriggers ? safeJson(doc.payTriggers) : {};
  const pctByKey: Record<string, number> = {
    advance: doc.payAdvancePct, beforeDelivery: doc.payBeforeDeliveryPct, running: doc.payRunningPct,
    postDelivery: doc.payPostDeliveryPct, postCompletion: doc.payPostCompletionPct, retention: doc.payRetentionPct,
  };
  const out: { fieldKey: string; name: string; triggerCondition: string | null; percentage: number; inrAmount: number; expectedDate: Date | null; sortOrder: number }[] = [];
  let order = 0;
  for (const f of PAY_FIELDS) {
    const pct = pctByKey[f.key] || 0;
    const m = meta[f.key] || {};
    if (pct <= 0 && !m.inr) continue; // skip zero fields
    const inr = m.inr != null ? m.inr : Math.round(doc.basicAmount * (pct / 100) * 100) / 100;
    out.push({
      fieldKey: f.key, name: f.name, triggerCondition: m.note ?? null,
      percentage: pct, inrAmount: inr,
      expectedDate: m.expectedDate ? new Date(m.expectedDate) : null,
      sortOrder: order++,
    });
  }
  return out;
}

export function paymentTotalPct(d: { payAdvancePct: number; payBeforeDeliveryPct: number; payRunningPct: number; payPostDeliveryPct: number; payPostCompletionPct: number; payRetentionPct: number }) {
  return Math.round((d.payAdvancePct + d.payBeforeDeliveryPct + d.payRunningPct + d.payPostDeliveryPct + d.payPostCompletionPct + d.payRetentionPct) * 100) / 100;
}

function safeJson(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

// ── Default Terms & Conditions ──────────────────────────────────────────────
export function defaultPOTerms(): { title: string; text: string }[] {
  return [
    { title: 'Delivery Schedule', text: 'Material should be delivered on site in good condition within 3 weeks after PO and advance received by purchaser. Risk of loss / title to goods shall not shift to the Purchaser until the Goods have been delivered to and accepted at the Purchaser\'s applicable facility.' },
    { title: 'Drawing', text: 'Items will be taken into manufacturing after drawing approval by purchaser via email.' },
    { title: 'BOQ', text: 'Mentioned items should match the BOQ and approved unit data selection sheet without which it is subject to rejection without any pay.' },
    { title: 'Liquidated Damages Clause', text: 'In the event of failure to deliver materials as per the agreed delivery schedule, a penalty of 5% per week shall be applicable for each day of delay.' },
    { title: 'Product Pricing', text: 'The prices mentioned above are final and are not subject to any revision.' },
    { title: 'Quality Assurance', text: 'All materials supplied shall strictly conform to the specifications, drawings, and technical requirements mentioned in this Purchase Order. Any deviation, defect, or substandard material shall be liable for rejection at the Supplier\'s cost. Relevant test certificates, inspection reports, and quality certificates shall be submitted along with the material wherever applicable.' },
    { title: 'Packing & Transportation', text: 'Materials shall be adequately packed to prevent damage during loading, transit, unloading, and storage. Transit insurance will be taken by the supplier at its own cost. Any damage arising due to improper packing shall be the Supplier\'s responsibility and will not be accepted at site.' },
    { title: 'Invoice & Documentation', text: 'The following documents shall accompany each delivery: Tax Invoice; Delivery Challan with Packing List; Test / Quality Certificates (where applicable); E-Way Bill (where applicable). The Invoice must clearly mention the Purchase Order Number and Date.' },
    { title: 'Installation', text: 'Installation is in supplier scope and should be done on immediate basis once formally informed via email or call.' },
    { title: 'Payment Terms', text: '25% Advance of basic amount against acceptance of Purchase Order. Balance 75% payment of basic amount before dispatch against Tax Invoice and photographic/video evidence confirming readiness of materials for dispatch. TDS shall be deducted as applicable under prevailing Income Tax laws.' },
    { title: 'Taxes & Duties', text: 'GST shall be separately indicated in the invoice under specific HSN Code. The Supplier shall comply with all applicable tax laws, regulations, and statutory requirements.' },
    { title: 'Inspection', text: 'Purchaser reserves the right to inspect materials at the Supplier\'s works before dispatch. Dispatch shall be made only after mail approval.' },
    { title: 'Rejection & Replacement', text: 'Rejected materials shall be lifted by the Supplier within 7 days from notification. Replacement materials shall be supplied within the mutually agreed delivery period at no additional cost to the Purchaser.' },
    { title: 'Warranty', text: 'The product above will be under warranty for twelve months from the date of installation or fifteen months from the date of invoice, whichever is earlier.' },
    { title: 'Cancellation', text: 'Purchaser reserves the right to cancel the Purchase Order, partially or fully, due to delay, non-compliance with specifications, quality issues, or breach of any terms and conditions. Any advance will be immediately refunded to the seller for the non-obligation.' },
    { title: 'Bank Guarantee (BG)', text: 'Seller will issue a BG equivalent to the advance value for buyer to release advance amount. BG validity: 60 days from date of acceptance of final delivery at the site. The original BG will be returned immediately upon completion of successful delivery.' },
    { title: 'Force Majeure', text: 'Neither party shall be liable for failure or delay in performance arising from events beyond reasonable control, including natural disasters, strikes, lockouts, government restrictions, war, pandemic, or acts of God.' },
    { title: 'Jurisdiction', text: 'All disputes arising out of this Purchase Order shall be subject to the exclusive jurisdiction of courts located in Mumbai, Maharashtra.' },
  ];
}

export function defaultWOTerms(): { title: string; text: string }[] {
  return [
    { title: 'Work Execution — Panels', text: 'All work shall be executed strictly as per approved drawings, site instructions, and technical specifications. Ensure proper alignment, leveling, and sealing of panels for thermal efficiency and airtightness. Daily Target and Manpower Requirement as agreed. Any shortfall in daily executed quantity or shortage of manpower will invoke a penalty. All quantities are subject to change by +/- 10%; final payment based on actual site measurements.' },
    { title: 'Work Execution — Machines', text: 'Installation of refrigeration condensing and evaporator units; copper piping with proper supports; nitrogen pressure testing and vacuuming; refrigerant charging and commissioning; electrical interconnection; trial run and performance testing; system balancing; drain line piping up to nearest drain point.' },
    { title: 'Material Responsibility', text: 'All materials brought to site must be of approved make and specification. The contractor shall be solely responsible for the safety and security of their tools, equipment, and materials at the site. Substandard or damaged material will be rejected and replaced at the contractor\'s expense.' },
    { title: 'Safety & Site Compliance', text: 'Vendor must provide all necessary safety gear and submit medical documentation as required by the site. Installation must include all accessories and ensure an airtight envelope. All works must comply with local labor laws, health regulations, and environmental guidelines. Any accident due to contractor negligence is their sole responsibility.' },
    { title: 'Work Schedule and Delays', text: 'The contractor shall adhere to the work schedule. Any delays must be communicated in writing with justifiable reasons. Unapproved delays may result in penalties of 2% per day on WO value of delay.' },
    { title: 'Quality and Workmanship', text: 'Workmanship must be of the highest standard. Defects found after inspection must be rectified immediately. All installations subject to final testing, inspection, and commissioning by the client/consultant. All deployed manpower shall possess valid documents and certifications.' },
    { title: 'Warranty and Defects Liability', text: 'The contractor shall provide a minimum 1-year warranty from the date of commissioning covering installation workmanship and installation-related defects. Any malfunction or leakage due to improper installation during the warranty period shall be rectified at no additional cost.' },
    { title: 'Billing and Documentation', text: 'All invoices must be supported by work completion certificates and measurements verified by the site engineer/client. Final bill shall only be processed after satisfactory completion and submission of a work completion report.' },
    { title: 'Force Majeure', text: 'The contractor shall not be held liable for delays caused by circumstances beyond their control such as natural calamities, strikes, or government-imposed restrictions. Immediate notification must be provided.' },
    { title: 'Termination', text: 'The client reserves the right to terminate the contract if there is non-compliance, poor workmanship, or breach of terms without prior resolution.' },
    { title: 'Payment Terms', text: 'Milestone-based as agreed (e.g., advance once team reaches site, part payments per progress up to 80%, balance after completion and acceptance of the Completion Certificate). All quantities subject to +/- 10%; final payment based on actual site measurements.' },
    { title: 'TDS Deduction', text: 'TDS will be deducted as per applicable income tax laws at the time of payment. This deduction shall be considered final from the client\'s side; the contractor may claim the same in their income tax filings.' },
    { title: 'Invoices & Supporting Documents', text: 'All invoices must be submitted with supporting documents including Completion Certificate, site measurement sheet (if applicable), photographic proof of completed work (if required), and any statutory compliance documents.' },
    { title: 'Jurisdiction', text: 'All disputes arising out of this Work Order shall be subject to the exclusive jurisdiction of courts located in Mumbai, Maharashtra.' },
  ];
}
