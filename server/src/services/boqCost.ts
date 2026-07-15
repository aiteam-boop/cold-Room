// BOQ Cost Sheet — the financial lens over the same BOQ rows the progress view
// shows. (Sprint PRD §6.)
//
// Nothing here is stored. `linkedPOIds`, `totalOrderedQty`, `totalOrderedCost`,
// `totalAdvancePaid` and `totalBalancePending` are derived on every read from
// ProcurementLineItem.boqItemId, so the sheet can never drift out of step with
// the POs it summarizes.
//
// Only APPROVED POs contribute cost (PRD §6.3: "On PO approval: system
// auto-updates the BOQ item's cost record"). Lines on any non-approved doc, and
// lines with no BOQ link at all, surface in `unlinked` so Amisha can fix them.

import { prisma } from '../lib/prisma';
import { loadProjectProgress } from './projectProgress';
import { deliveryInfo, type DeliveryStatus } from './delivery';

/** Advance / Partial / Paid / Pending — the PRD's four payment states. */
export type PaymentStatus = 'Paid' | 'Partial' | 'Advance' | 'Pending';

/** Material receipt against a PO. Derived from its GRNs. */
export type ReceiptStatus = 'Received' | 'Partially Received' | 'Awaiting GRN' | 'Not Received';

/** A paid milestone, for the "Paid" breakdown on the BOQ row. */
export interface PaidMilestone { name: string; fieldKey: string; inrAmount: number }

/** One GRN + its invoice, as shown inline on the BOQ row (transcript R8). */
export interface CostGRNRow {
  grnId: string;
  grnNumber: string;
  grnDate: string;
  status: string;
  invoiceNumber: string | null;
  invoiceValue: number | null;
  invoicePdfUrl: string | null;
  // Proforma Invoice — drives the payment, arrives before the tax invoice (§3/§6).
  piNumber: string | null;
  piValue: number | null;
  piPdfUrl: string | null;
  grnPdfUrl: string;
}

export interface CostPORow {
  poLineId: string;
  docId: string;
  docNumber: string;
  docType: string;
  vendorName: string | null;
  qtyOrdered: number;
  unitPrice: number;
  totalCost: number;
  advancePaid: number;
  amountPaid: number;
  /** Every PAID milestone (Advance, Before Delivery, Running…) with its amount. */
  paidMilestones: PaidMilestone[];
  balancePending: number;
  paymentStatus: PaymentStatus;
  // ── Material + invoice trail (transcript R8: "GRN yahin pe aana chahiye agar
  // approve hua hai aur saath-saath uska invoice dikhna chahiye yahin par hi") ──
  receiptStatus: ReceiptStatus;
  qtyReceived: number;
  grns: CostGRNRow[];
  /** Delivery verdict of the parent PO, so a late line is visible on the BOQ. */
  deliveryStatus: DeliveryStatus;
  deliveryDelayDays: number | null;
}

export interface CostItemRow {
  id: string;
  srNo: string | null;
  description: string;
  category: string | null;
  roomZone: string | null;
  unit: string | null;
  makeModel: string | null;
  plannedQty: number;
  installedQty: number;
  // Derived rollups across every linked PO.
  linkedPOIds: string[];
  totalOrderedQty: number;
  totalOrderedCost: number;
  totalAdvancePaid: number;
  /** Total paid across ALL milestones (advance + before-delivery + running…). */
  totalPaid: number;
  /** Aggregated paid-milestone breakdown, so "why is the balance X" is visible. */
  paidMilestones: PaidMilestone[];
  totalBalancePending: number;
  paymentStatus: PaymentStatus;
  /** Rollup of the receipt state across every linked PO. */
  receiptStatus: ReceiptStatus;
  totalReceivedQty: number;
  pos: CostPORow[];

  // ── Budget vs actual (BOQ & Budget PRD v1 §5) ──
  // What we SAID this line would cost, and how the POs actually landed against it.
  // `budgetVariance` is negative when we bought below budget — that is the goal.
  budgetAmount: number | null;
  budgetRate: number | null;
  /** effectivePoAmount − budgetAmount. Null until the line is both costed and ordered. */
  budgetVariance: number | null;
  /** Variance as a % of budget. Null on the same terms. */
  budgetVariancePct: number | null;

  // ── Finance overlay (PRD v2 §5) — editable, layered over the derived numbers ──
  // `effective*` prefer the manual override when present, else the derived value.
  orderedQtyOverride: number | null;
  poAmountOverride: number | null;
  rateOverride: number | null;
  plannedDeliveryDate: string | null;
  actualDeliveryDate: string | null;
  deliveryDelayDays: number | null;   // actual − planned, when both are set
  invoicingDone: boolean;
  annotationRemarks: string | null;
  effectiveOrderedQty: number;        // override ?? totalOrderedQty
  effectivePoAmount: number;          // override ?? totalOrderedCost
  effectiveRate: number | null;       // override ?? weighted PO unit price
  qtyRateAmount: number | null;       // effectiveOrderedQty × effectiveRate — the billable figure
  // A PO the finance user picked for this row directly (PRD v2 §5), even when no
  // PO line is linked. Resolved to its number + vendor for display.
  selectedDocId: string | null;
  selectedPoNumber: string | null;
  selectedVendorName: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Received vs ordered, with "Awaiting GRN" for a GRN raised but not yet approved. */
export function receiptStatus(ordered: number, accepted: number, hasUnapprovedGrn: boolean): ReceiptStatus {
  if (accepted <= 0) return hasUnapprovedGrn ? 'Awaiting GRN' : 'Not Received';
  if (ordered > 0 && r2(accepted) >= r2(ordered)) return 'Received';
  return 'Partially Received';
}

export function paymentStatus(total: number, paid: number, advance: number): PaymentStatus {
  if (total <= 0) return 'Pending';
  if (r2(paid) >= r2(total)) return 'Paid';
  if (paid <= 0) return 'Pending';
  // Everything paid so far came from the advance milestone → still "Advance".
  return r2(paid) === r2(advance) ? 'Advance' : 'Partial';
}

const dayDiff = (a: Date, b: Date) => Math.round((Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()) - Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())) / 86_400_000);

export async function buildCostSheet(projectId: string) {
  const [items, prog, lines, grns, annotations, allPos, budgetLines] = await Promise.all([
    prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    loadProjectProgress(projectId),
    prisma.procurementLineItem.findMany({
      where: { isLeadTime: false, doc: { projectId, status: { not: 'REJECTED' } } },
      include: {
        doc: {
          select: {
            id: true, docNumber: true, type: true, status: true, vendorName: true, basicAmount: true,
            promisedDeliveryDate: true, requiredByDate: true,
            milestones: { select: { fieldKey: true, name: true, status: true, inrAmount: true } },
            grns: { select: { grnDate: true, status: true } },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    }),
    // Every GRN in the project, with the PO line each of its rows fulfils. This
    // is the join that puts "GRN + invoice" on the BOQ row (transcript R8).
    prisma.gRN.findMany({
      where: { projectId, status: { not: 'REJECTED' } },
      select: {
        id: true, grnNumber: true, grnDate: true, status: true, docId: true, projectId: true,
        invoiceNumber: true, invoiceValue: true, invoicePdfUrl: true,
        piNumber: true, piValue: true, piPdfUrl: true,
        lineItems: { select: { lineItemId: true, acceptedQty: true } },
      },
      orderBy: { grnDate: 'asc' },
    }),
    prisma.bOQCostAnnotation.findMany({ where: { projectId } }),
    // PO/WO index so a directly-selected PO (annotation.docId) can surface its
    // number, vendor, amounts, payments and GRNs on the BOQ row even when no PO
    // line is linked to the BOQ item.
    prisma.procurementDoc.findMany({
      where: { projectId },
      select: { id: true, docNumber: true, vendorName: true, type: true, basicAmount: true, finalAmount: true, status: true, milestones: { select: { fieldKey: true, name: true, status: true, inrAmount: true } } },
    }),
    // The frozen budget — what each line was SAID to cost. Drives the variance.
    prisma.bOQBudgetLine.findMany({ where: { projectId }, select: { boqItemId: true, budgetAmount: true, budgetRate: true } }),
  ]);
  const annById = new Map(annotations.map((a) => [a.boqItemId, a]));
  const poById = new Map(allPos.map((d) => [d.id, d]));
  const budgetByItem = new Map(budgetLines.map((b) => [b.boqItemId, b]));

  // Accepted qty received per PO (across its APPROVED GRNs) — used to fill the
  // "Received" column for a manually-selected PO.
  const receivedByDoc = new Map<string, number>();
  for (const g of grns) {
    if (g.status !== 'APPROVED') continue;
    const acc = g.lineItems.reduce((s, l) => s + l.acceptedQty, 0);
    receivedByDoc.set(g.docId, (receivedByDoc.get(g.docId) ?? 0) + acc);
  }

  // Accepted qty per PO line, counting only APPROVED GRNs — a draft GRN is a
  // claim, not a receipt.
  const acceptedByLine = new Map<string, number>();
  const grnsByDoc = new Map<string, CostGRNRow[]>();
  const unapprovedLines = new Set<string>();
  for (const g of grns) {
    const row: CostGRNRow = {
      grnId: g.id,
      grnNumber: g.grnNumber,
      grnDate: g.grnDate.toISOString(),
      status: g.status,
      invoiceNumber: g.invoiceNumber,
      invoiceValue: g.invoiceValue,
      invoicePdfUrl: g.invoicePdfUrl,
      piNumber: g.piNumber,
      piValue: g.piValue,
      piPdfUrl: g.piPdfUrl,
      grnPdfUrl: `/api/projects/${g.projectId}/procurement/grns/${g.id}/pdf`,
    };
    const list = grnsByDoc.get(g.docId) ?? [];
    list.push(row);
    grnsByDoc.set(g.docId, list);

    for (const l of g.lineItems) {
      if (!l.lineItemId) continue;
      if (g.status === 'APPROVED') acceptedByLine.set(l.lineItemId, (acceptedByLine.get(l.lineItemId) ?? 0) + l.acceptedQty);
      else unapprovedLines.add(l.lineItemId);
    }
  }

  // Per-PO payment totals, computed once. A line's share of its PO's payments is
  // proportional to that line's share of the PO's basic amount — payments are
  // made against the document, not against individual lines.
  const payByDoc = new Map<string, { paid: number; advance: number }>();
  for (const l of lines) {
    if (payByDoc.has(l.doc.id)) continue;
    const paid = l.doc.milestones.filter((m) => m.status === 'PAID');
    payByDoc.set(l.doc.id, {
      paid: paid.reduce((s, m) => s + m.inrAmount, 0),
      advance: paid.filter((m) => m.fieldKey === 'advance').reduce((s, m) => s + m.inrAmount, 0),
    });
  }

  const approved = lines.filter((l) => l.doc.status === 'APPROVED');

  const toPORow = (l: (typeof lines)[number]): CostPORow => {
    const pay = payByDoc.get(l.doc.id) ?? { paid: 0, advance: 0 };
    const share = l.doc.basicAmount > 0 ? l.totalPrice / l.doc.basicAmount : 0;
    const advancePaid = r2(pay.advance * share);
    const amountPaid = r2(pay.paid * share);
    const qtyReceived = r2(acceptedByLine.get(l.id) ?? 0);
    const del = deliveryInfo(l.doc, l.doc.grns);
    return {
      poLineId: l.id,
      docId: l.doc.id,
      docNumber: l.doc.docNumber,
      docType: l.doc.type,
      vendorName: l.doc.vendorName,
      qtyOrdered: l.qty,
      unitPrice: l.unitPrice,
      totalCost: l.totalPrice,
      advancePaid,
      amountPaid,
      // Each paid milestone scaled by this line's share of the PO.
      paidMilestones: l.doc.milestones.filter((m) => m.status === 'PAID').map((m) => ({ name: m.name, fieldKey: m.fieldKey, inrAmount: r2(m.inrAmount * share) })),
      balancePending: r2(l.totalPrice - amountPaid),
      paymentStatus: paymentStatus(l.totalPrice, amountPaid, advancePaid),
      qtyReceived,
      receiptStatus: receiptStatus(l.qty, qtyReceived, unapprovedLines.has(l.id)),
      // The whole PO's GRNs — a GRN covers a delivery, not a single line, and the
      // invoice sits on the GRN header.
      grns: grnsByDoc.get(l.doc.id) ?? [],
      deliveryStatus: del.status,
      deliveryDelayDays: del.delayDays,
    };
  };

  // One BOQ item can be covered by MULTIPLE POs (e.g. copper piping in 2 batches).
  const posByItem = new Map<string, CostPORow[]>();
  for (const l of approved) {
    if (!l.boqItemId) continue;
    const list = posByItem.get(l.boqItemId) ?? [];
    list.push(toPORow(l));
    posByItem.set(l.boqItemId, list);
  }

  // A manually-selected PO (no linked line) becomes a synthetic PO row so its
  // payments + GRNs flow through the same rollup as a linked PO.
  function syntheticPORow(docId: string): CostPORow | null {
    const doc = poById.get(docId);
    if (!doc) return null;
    const paid = doc.milestones.filter((m) => m.status === 'PAID');
    const amountPaid = r2(paid.reduce((s, m) => s + m.inrAmount, 0));
    const advancePaid = r2(paid.filter((m) => m.fieldKey === 'advance').reduce((s, m) => s + m.inrAmount, 0));
    const total = doc.basicAmount || doc.finalAmount || 0;
    const qtyReceived = r2(receivedByDoc.get(docId) ?? 0);
    const hasUnapprovedGrn = (grnsByDoc.get(docId) ?? []).some((g) => g.status !== 'APPROVED');
    return {
      poLineId: `sel-${docId}`, docId, docNumber: doc.docNumber, docType: doc.type, vendorName: doc.vendorName,
      qtyOrdered: 0, unitPrice: 0, totalCost: total,
      advancePaid, amountPaid,
      paidMilestones: paid.map((m) => ({ name: m.name, fieldKey: m.fieldKey, inrAmount: m.inrAmount })),
      balancePending: r2(total - amountPaid),
      paymentStatus: paymentStatus(total, amountPaid, advancePaid),
      qtyReceived, receiptStatus: receiptStatus(0, qtyReceived, hasUnapprovedGrn),
      grns: grnsByDoc.get(docId) ?? [],
      deliveryStatus: 'UNKNOWN', deliveryDelayDays: null,
    };
  }

  const rows: CostItemRow[] = items.map((it) => {
    const ann = annById.get(it.id);
    let pos = posByItem.get(it.id) ?? [];
    // No linked PO line but a PO was picked on the row → attach it synthetically.
    if (pos.length === 0 && ann?.docId) {
      const syn = syntheticPORow(ann.docId);
      if (syn) pos = [syn];
    }
    const totalOrderedCost = r2(pos.reduce((s, p) => s + p.totalCost, 0));
    const totalAdvancePaid = r2(pos.reduce((s, p) => s + p.advancePaid, 0));
    const totalPaid = r2(pos.reduce((s, p) => s + p.amountPaid, 0));
    const totalOrderedQty = r2(pos.reduce((s, p) => s + p.qtyOrdered, 0));
    const totalReceivedQty = r2(pos.reduce((s, p) => s + p.qtyReceived, 0));

    // Aggregate the paid-milestone breakdown across every PO on the row, merged
    // by milestone (Advance, Before Delivery, Running…) so the "Paid" cell can
    // show why the balance is what it is.
    const paidAgg = new Map<string, PaidMilestone>();
    for (const p of pos) for (const m of p.paidMilestones) {
      const key = m.fieldKey || m.name;
      const prev = paidAgg.get(key);
      paidAgg.set(key, { name: m.name, fieldKey: m.fieldKey, inrAmount: r2((prev?.inrAmount ?? 0) + m.inrAmount) });
    }
    const paidMilestones = [...paidAgg.values()];

    // Finance overlay (PRD v2 §5). Effective = manual override ?? derived.
    const effectiveOrderedQty = ann?.orderedQtyOverride != null ? ann.orderedQtyOverride : totalOrderedQty;
    const effectivePoAmount = ann?.poAmountOverride != null ? ann.poAmountOverride : totalOrderedCost;
    // Rate: override, else the weighted PO unit price (cost ÷ qty).
    const derivedRate = totalOrderedQty > 0 ? r2(totalOrderedCost / totalOrderedQty) : null;
    const effectiveRate = ann?.rateOverride != null ? ann.rateOverride : derivedRate;
    const qtyRateAmount = effectiveRate != null ? r2(effectiveOrderedQty * effectiveRate) : null;
    const deliveryDelayDays = ann?.plannedDeliveryDate && ann?.actualDeliveryDate
      ? dayDiff(ann.actualDeliveryDate, ann.plannedDeliveryDate) : null;

    // Budget vs actual (PRD v1 §5). Only meaningful once the line is BOTH costed
    // and ordered — otherwise "−100% under budget" would read as a win.
    const bud = budgetByItem.get(it.id);
    const budgetAmount = bud?.budgetAmount ?? null;
    const hasOrder = effectivePoAmount > 0;
    const budgetVariance = budgetAmount != null && hasOrder ? r2(effectivePoAmount - budgetAmount) : null;
    const budgetVariancePct = budgetVariance != null && budgetAmount ? r2((budgetVariance / budgetAmount) * 100) : null;

    return {
      id: it.id,
      srNo: it.srNo,
      description: it.description,
      category: it.category,
      roomZone: it.roomZone,
      unit: it.unit,
      makeModel: it.makeModel,
      plannedQty: it.plannedQty,
      // Kept in the cost view alongside the financial columns, per the client's
      // instruction — the PRD's column table hides it, we do not.
      installedQty: prog.itemsById.get(it.id)?.installedQty ?? 0,
      linkedPOIds: [...new Set(pos.map((p) => p.docId))],
      totalOrderedQty,
      totalOrderedCost,
      totalAdvancePaid,
      totalPaid,
      paidMilestones,
      // Balance = the PO amount SHOWN (override ?? derived) − everything paid, so
      // Paid + Balance always equals the PO Amount column.
      totalBalancePending: r2(effectivePoAmount - totalPaid),
      paymentStatus: paymentStatus(effectivePoAmount, totalPaid, totalAdvancePaid),
      totalReceivedQty,
      receiptStatus: receiptStatus(totalOrderedQty, totalReceivedQty, pos.some((p) => p.receiptStatus === 'Awaiting GRN')),
      pos,
      // Budget vs actual
      budgetAmount,
      budgetRate: bud?.budgetRate ?? null,
      budgetVariance,
      budgetVariancePct,
      // Finance overlay
      orderedQtyOverride: ann?.orderedQtyOverride ?? null,
      poAmountOverride: ann?.poAmountOverride ?? null,
      rateOverride: ann?.rateOverride ?? null,
      plannedDeliveryDate: ann?.plannedDeliveryDate ? ann.plannedDeliveryDate.toISOString() : null,
      actualDeliveryDate: ann?.actualDeliveryDate ? ann.actualDeliveryDate.toISOString() : null,
      deliveryDelayDays,
      invoicingDone: ann?.invoicingDone ?? false,
      annotationRemarks: ann?.remarks ?? null,
      effectiveOrderedQty,
      effectivePoAmount,
      effectiveRate,
      qtyRateAmount,
      selectedDocId: ann?.docId ?? null,
      selectedPoNumber: ann?.docId ? (poById.get(ann.docId)?.docNumber ?? null) : null,
      selectedVendorName: ann?.docId ? (poById.get(ann.docId)?.vendorName ?? null) : null,
    };
  });

  // PO lines that carry a price but no BOQ link — the "Unlinked POs" prompt.
  const unlinked = lines
    .filter((l) => !l.boqItemId && (l.description.trim() || l.totalPrice > 0))
    .map((l) => ({ ...toPORow(l), description: l.description, uom: l.uom, docStatus: l.doc.status }));

  const grandTotalCost = r2(rows.reduce((s, r) => s + r.totalOrderedCost, 0));

  return {
    items: rows,
    unlinked,
    summary: {
      itemsWithPO: rows.filter((r) => r.pos.length > 0).length,
      itemsWithoutPO: rows.filter((r) => r.pos.length === 0).length,
      unlinkedPOLines: unlinked.length,
      grandTotalCost,
      grandAdvancePaid: r2(rows.reduce((s, r) => s + r.totalAdvancePaid, 0)),
      grandPaid: r2(rows.reduce((s, r) => s + r.totalPaid, 0)),
      grandBalancePending: r2(rows.reduce((s, r) => s + r.totalBalancePending, 0)),
    },
  };
}
