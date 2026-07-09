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

/** One GRN + its invoice, as shown inline on the BOQ row (transcript R8). */
export interface CostGRNRow {
  grnId: string;
  grnNumber: string;
  grnDate: string;
  status: string;
  invoiceNumber: string | null;
  invoiceValue: number | null;
  invoicePdfUrl: string | null;
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
  totalBalancePending: number;
  paymentStatus: PaymentStatus;
  /** Rollup of the receipt state across every linked PO. */
  receiptStatus: ReceiptStatus;
  totalReceivedQty: number;
  pos: CostPORow[];
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

export async function buildCostSheet(projectId: string) {
  const [items, prog, lines, grns] = await Promise.all([
    prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    loadProjectProgress(projectId),
    prisma.procurementLineItem.findMany({
      where: { isLeadTime: false, doc: { projectId, status: { not: 'REJECTED' } } },
      include: {
        doc: {
          select: {
            id: true, docNumber: true, type: true, status: true, vendorName: true, basicAmount: true,
            promisedDeliveryDate: true, requiredByDate: true,
            milestones: { select: { fieldKey: true, status: true, inrAmount: true } },
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
        lineItems: { select: { lineItemId: true, acceptedQty: true } },
      },
      orderBy: { grnDate: 'asc' },
    }),
  ]);

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

  const rows: CostItemRow[] = items.map((it) => {
    const pos = posByItem.get(it.id) ?? [];
    const totalOrderedCost = r2(pos.reduce((s, p) => s + p.totalCost, 0));
    const totalAdvancePaid = r2(pos.reduce((s, p) => s + p.advancePaid, 0));
    const totalPaid = r2(pos.reduce((s, p) => s + p.amountPaid, 0));
    const totalOrderedQty = r2(pos.reduce((s, p) => s + p.qtyOrdered, 0));
    const totalReceivedQty = r2(pos.reduce((s, p) => s + p.qtyReceived, 0));
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
      totalBalancePending: r2(totalOrderedCost - totalPaid),
      paymentStatus: paymentStatus(totalOrderedCost, totalPaid, totalAdvancePaid),
      totalReceivedQty,
      receiptStatus: receiptStatus(totalOrderedQty, totalReceivedQty, pos.some((p) => p.receiptStatus === 'Awaiting GRN')),
      pos,
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
      grandBalancePending: r2(rows.reduce((s, r) => s + r.totalBalancePending, 0)),
    },
  };
}
