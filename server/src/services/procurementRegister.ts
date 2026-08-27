// The Reports section AA sir asked for (transcript P18/P19, DPR PRD §3.2 G11):
//
//   "Report section mein tumhare sab aa jayenge — ki uske against kya PO hua, kya
//    hua, phir uske baad payment hua, kya diya… Maal aa gaya ki nahi aa gaya,
//    payment de diya ki nahi, vendor koi paisa baaki hai kya, uske advance terms
//    kya hai? Vendor ke terms of payment kya hai?"
//
// The PO/WO screens stay a plain register ("ye khali pure register hai"). The
// drill-down — PO → GRN → Invoice → Payment, and what each vendor is still owed —
// lives here.
//
// Everything is derived on read. Nothing in this file is stored, so a rejected
// GRN or a recalled PO changes the report on the next request.

import { prisma } from '../lib/prisma';
import { deliveryInfo, onTimeDeliveryPct, onTimePaymentPct, paymentPunctuality, type DeliveryInfo, type PaymentPunctuality } from './delivery';

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface RegisterMilestone {
  id: string;
  name: string;
  fieldKey: string;
  percentage: number;
  inrAmount: number;
  status: string;
  expectedDate: Date | null;
  paymentDate: Date | null;
  utrNumber: string | null;
  punctuality: PaymentPunctuality;
  punctualityDelayDays: number | null;
  // Amount settled against this term via the Accounts sheet (mirror; the term's
  // own status stays PENDING/TRIGGERED) and the UTR(s) that paid it.
  sheetPaid: number;
  sheetUtrs: { utr: string; vrNo?: string | null }[];
}

export interface RegisterGRN {
  id: string;
  grnNumber: string;
  grnDate: Date;
  status: string;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  invoiceValue: number | null;
  invoicePdfUrl: string | null;
  acceptedQty: number;
  defectQty: number;
}

export interface RegisterRow {
  docId: string;
  docNumber: string;
  docType: string;
  status: string;
  docDate: Date;
  // Which project this document belongs to (used by the cross-project master register).
  projectId: string;
  projectName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  basicAmount: number;
  finalAmount: number;

  delivery: DeliveryInfo;

  grns: RegisterGRN[];
  invoicedValue: number;

  milestones: RegisterMilestone[];
  amountPaid: number;
  amountPending: number;
  /** Sum of milestones that are TRIGGERED but not yet PAID — money owed right now. */
  amountDueNow: number;
  overdueMilestones: number;
}

export interface ProcurementRegister {
  rows: RegisterRow[];
  summary: {
    docs: number;
    totalOrdered: number;
    totalInvoiced: number;
    totalPaid: number;
    totalPending: number;
    totalDueNow: number;
    onTimeDelivery: { pct: number | null; onTime: number; measured: number };
    onTimePayment: { pct: number | null; onTime: number; measured: number };
    /** POs that promised nothing — the on-time numbers can say nothing about these. */
    docsWithoutDeliveryDate: number;
  };
}

export async function buildProcurementRegister(projectId: string | string[], now = new Date()): Promise<ProcurementRegister> {
  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: Array.isArray(projectId) ? { in: projectId } : projectId, status: { not: 'REJECTED' } },
    orderBy: { docDate: 'desc' },
    include: {
      project: { select: { name: true } },
      milestones: { orderBy: { sortOrder: 'asc' } },
      grns: {
        orderBy: { grnDate: 'asc' },
        include: { lineItems: { select: { acceptedQty: true, defectQty: true } } },
      },
    },
  });

  const rows: RegisterRow[] = docs.map((d) => {
    const delivery = deliveryInfo(d, d.grns, now);

    const grns: RegisterGRN[] = d.grns.map((g) => ({
      id: g.id, grnNumber: g.grnNumber, grnDate: g.grnDate, status: g.status,
      invoiceNumber: g.invoiceNumber, invoiceDate: g.invoiceDate, invoiceValue: g.invoiceValue,
      invoicePdfUrl: g.invoicePdfUrl,
      acceptedQty: r2(g.lineItems.reduce((s, l) => s + l.acceptedQty, 0)),
      defectQty: r2(g.lineItems.reduce((s, l) => s + l.defectQty, 0)),
    }));

    // Only an APPROVED GRN's invoice is a liability.
    const invoicedValue = r2(grns.filter((g) => g.status === 'APPROVED').reduce((s, g) => s + (g.invoiceValue ?? 0), 0));

    // Greedily allocate this doc's Accounts-sheet payments across its terms that
    // aren't already fully paid in-app, in order — so a PENDING/TRIGGERED term
    // settled via the sheet shows as paid with its UTR in the expanded view.
    const sheetPool: { utr: string; vrNo?: string | null; left: number }[] = (() => {
      try { return (d.sheetPayments ? JSON.parse(d.sheetPayments) : []).map((s: any) => ({ utr: s.utr, vrNo: s.vrNo ?? null, left: Number(s.amount) || 0 })); } catch { return []; }
    })();

    const milestones: RegisterMilestone[] = d.milestones.map((m) => {
      const p = paymentPunctuality(m, now);
      const inAppPaidM = m.status === 'PAID' ? m.inrAmount : (m.status === 'PARTIALLY_PAID' ? (m.amountPaid || 0) : 0);
      let need = Math.max((m.inrAmount || 0) - inAppPaidM, 0);
      let sheetPaidM = 0;
      const sheetUtrs: { utr: string; vrNo?: string | null }[] = [];
      for (const s of sheetPool) {
        if (need <= 0.01) break;
        if (s.left <= 0.01) continue;
        const take = Math.min(s.left, need);
        sheetPaidM += take; need -= take; s.left -= take;
        sheetUtrs.push({ utr: s.utr, vrNo: s.vrNo });
      }
      return {
        id: m.id, name: m.name, fieldKey: m.fieldKey, percentage: m.percentage, inrAmount: m.inrAmount,
        status: m.status, expectedDate: m.expectedDate, paymentDate: m.paymentDate, utrNumber: m.utrNumber,
        punctuality: p.status, punctualityDelayDays: p.delayDays,
        sheetPaid: r2(sheetPaidM), sheetUtrs,
      };
    });

    // Paid = in-app milestone payments (full PAID + partial amountPaid) PLUS money
    // paid via the Accounts sheet (fetch-UTR), which is real cash out but leaves the
    // milestone PENDING. Ignoring the sheet made fully-paid POs read "Outstanding".
    const inAppPaid = d.milestones.reduce((s, m) => s + (m.status === 'PAID' ? m.inrAmount : (m.status === 'PARTIALLY_PAID' ? (m.amountPaid || 0) : 0)), 0);
    let sheetPaid = 0;
    try { for (const x of (d.sheetPayments ? JSON.parse(d.sheetPayments) : [])) sheetPaid += Number(x.amount) || 0; } catch { /* ignore */ }
    const amountPaid = r2(Math.min(inAppPaid + sheetPaid, d.finalAmount));
    const amountPending = r2(Math.max(d.finalAmount - amountPaid, 0));
    // "Due now" = triggered-but-unpaid, but never more than what is still outstanding
    // (a term paid via the sheet is no longer due).
    const triggeredTotal = d.milestones.filter((m) => m.status === 'TRIGGERED').reduce((s, m) => s + m.inrAmount, 0);
    const amountDueNow = r2(Math.max(0, Math.min(triggeredTotal, amountPending)));

    return {
      docId: d.id, docNumber: d.docNumber, docType: d.type, status: d.status, docDate: d.docDate,
      projectId: d.projectId, projectName: d.project?.name ?? null,
      vendorId: d.vendorId, vendorName: d.vendorName,
      basicAmount: d.basicAmount, finalAmount: d.finalAmount,
      delivery, grns, invoicedValue, milestones,
      amountPaid,
      amountPending,
      amountDueNow,
      overdueMilestones: milestones.filter((m) => m.punctuality === 'OVERDUE').length,
    };
  });

  // Only APPROVED docs count towards money totals — a draft PO is not a commitment.
  const live = rows.filter((r) => r.status === 'APPROVED');

  return {
    rows,
    summary: {
      docs: rows.length,
      totalOrdered: r2(live.reduce((s, r) => s + r.finalAmount, 0)),
      totalInvoiced: r2(live.reduce((s, r) => s + r.invoicedValue, 0)),
      totalPaid: r2(live.reduce((s, r) => s + r.amountPaid, 0)),
      totalPending: r2(live.reduce((s, r) => s + r.amountPending, 0)),
      totalDueNow: r2(live.reduce((s, r) => s + r.amountDueNow, 0)),
      onTimeDelivery: onTimeDeliveryPct(live.map((r) => r.delivery)),
      onTimePayment: onTimePaymentPct(live.flatMap((r) => r.milestones.map((m) => ({ status: m.punctuality })))),
      docsWithoutDeliveryDate: live.filter((r) => !r.delivery.promisedDeliveryDate).length,
    },
  };
}

// ── Vendor outstanding ───────────────────────────────────────────────────────
// "Vendor koi paisa baaki hai kya? Uske advance terms kya hai? Vendor ke terms of
//  payment kya hai? Usko advance dena hai, balance dena hai, kab dena hai?"

export interface VendorOutstandingRow {
  vendorId: string | null;
  vendorName: string;
  docCount: number;
  totalOrdered: number;
  totalPaid: number;
  totalOutstanding: number;
  dueNow: number;
  overdueMilestones: number;
  /** The payment terms actually used across this vendor's POs, as % splits. */
  paymentTerms: { advance: number; beforeDelivery: number; running: number; postDelivery: number; postCompletion: number; retention: number };
  onTimeDelivery: { pct: number | null; onTime: number; measured: number };
  nextDue: { docNumber: string; name: string; inrAmount: number; expectedDate: Date | null } | null;
}

export async function buildVendorOutstanding(projectId: string | string[], now = new Date()): Promise<VendorOutstandingRow[]> {
  const { rows } = await buildProcurementRegister(projectId, now);
  const live = rows.filter((r) => r.status === 'APPROVED');

  const docs = await prisma.procurementDoc.findMany({
    where: { projectId: Array.isArray(projectId) ? { in: projectId } : projectId, status: 'APPROVED' },
    select: {
      id: true, vendorId: true,
      payAdvancePct: true, payBeforeDeliveryPct: true, payRunningPct: true,
      payPostDeliveryPct: true, payPostCompletionPct: true, payRetentionPct: true,
    },
  });
  const termsByDoc = new Map(docs.map((d) => [d.id, d]));

  const byVendor = new Map<string, RegisterRow[]>();
  for (const r of live) {
    const key = r.vendorId ?? `name:${r.vendorName ?? 'Unknown vendor'}`;
    byVendor.set(key, [...(byVendor.get(key) ?? []), r]);
  }

  const out: VendorOutstandingRow[] = [];
  for (const [, group] of byVendor) {
    // Weight each term by the document's value: a vendor with a big 30%-advance PO
    // and a small 0%-advance PO is, in effect, on ~30% advance.
    const totalOrdered = r2(group.reduce((s, r) => s + r.finalAmount, 0));
    const wavg = (pick: (t: NonNullable<ReturnType<typeof termsByDoc.get>>) => number) => {
      if (totalOrdered <= 0) return 0;
      return r2(group.reduce((s, r) => {
        const t = termsByDoc.get(r.docId);
        return s + (t ? pick(t) * r.finalAmount : 0);
      }, 0) / totalOrdered);
    };

    // Soonest unpaid milestone that has an expected date.
    const upcoming = group
      .flatMap((r) => r.milestones.filter((m) => m.status !== 'PAID' && m.expectedDate).map((m) => ({ ...m, docNumber: r.docNumber })))
      .sort((a, b) => a.expectedDate!.getTime() - b.expectedDate!.getTime())[0];

    out.push({
      vendorId: group[0].vendorId,
      vendorName: group[0].vendorName ?? 'Unknown vendor',
      docCount: group.length,
      totalOrdered,
      totalPaid: r2(group.reduce((s, r) => s + r.amountPaid, 0)),
      totalOutstanding: r2(group.reduce((s, r) => s + r.amountPending, 0)),
      dueNow: r2(group.reduce((s, r) => s + r.amountDueNow, 0)),
      overdueMilestones: group.reduce((s, r) => s + r.overdueMilestones, 0),
      paymentTerms: {
        advance: wavg((t) => t.payAdvancePct),
        beforeDelivery: wavg((t) => t.payBeforeDeliveryPct),
        running: wavg((t) => t.payRunningPct),
        postDelivery: wavg((t) => t.payPostDeliveryPct),
        postCompletion: wavg((t) => t.payPostCompletionPct),
        retention: wavg((t) => t.payRetentionPct),
      },
      onTimeDelivery: onTimeDeliveryPct(group.map((r) => r.delivery)),
      nextDue: upcoming
        ? { docNumber: upcoming.docNumber, name: upcoming.name, inrAmount: upcoming.inrAmount, expectedDate: upcoming.expectedDate }
        : null,
    });
  }

  return out.sort((a, b) => b.totalOutstanding - a.totalOutstanding);
}
