// ── Public API v1 ─────────────────────────────────────────────────────────────
// Key-authenticated (requireApiKey runs in index mount, ahead of session auth).
// Two access layers: requireRealm() gates whole endpoints; applyScopes() strips
// fields the key's scopes don't cover (silently, listing them in _meta.withheld).
// Reads use {data, page}; the item/write envelope is {data}. Every object carries
// a deepLink that opens it in the dashboard.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireApiKey, requireRealm, requireScope } from '../middleware/apiKeyAuth';
import { deepLink } from '../lib/deepLink';
import { applyScopes } from '../lib/apiScopes';
import { apiList, apiItem, apiError, parseListParams } from '../lib/apiEnvelope';
import { audit } from '../lib/audit';

const router = Router();
router.use(requireApiKey);

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// Scope + paginate a list, then ship the standard envelope.
function sendList(req: Request, res: Response, rows: Record<string, unknown>[], total: number) {
  const { limit, offset } = parseListParams(req);
  const { data, withheld } = applyScopes(rows, req.apiKey!.scopes);
  return apiList(res, data as unknown[], { limit, offset, total }, withheld.length ? { withheld } : undefined);
}
function sendItem(req: Request, res: Response, row: Record<string, unknown>) {
  const { data, withheld } = applyScopes(row, req.apiKey!.scopes);
  return apiItem(res, data, withheld.length ? { withheld } : undefined);
}

// GET /api/v1/ping — confirm the key works; echo its grants.
router.get('/ping', asyncHandler(async (req: Request, res: Response) => {
  return apiItem(res, { ok: true, key: req.apiKey?.name, realms: req.apiKey?.realms, scopes: req.apiKey?.scopes, serverTime: new Date().toISOString() });
}));

// ── Projects realm ────────────────────────────────────────────────────────────
router.get('/projects', requireRealm('projects'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const [projects, total] = await Promise.all([
    prisma.project.findMany({ orderBy: { createdAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, name: true, clientName: true, siteLocation: true, status: true, startDate: true, targetCompletionDate: true } }),
    prisma.project.count(),
  ]);
  const rows = projects.map((p) => ({
    id: p.id, name: p.name, client: p.clientName, site: p.siteLocation, status: p.status,
    startDate: iso(p.startDate), targetDate: iso(p.targetCompletionDate), deepLink: deepLink('project', p.id, p.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id', requireRealm('projects'), asyncHandler(async (req, res) => {
  const p = await prisma.project.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, name: true, clientName: true, siteLocation: true, status: true, startDate: true, targetCompletionDate: true,
      _count: { select: { procurementDocs: true, grns: true, vendorPayments: true, ganttActivities: true, boqItems: true } },
    },
  });
  if (!p) return apiError(res, 404, 'not_found', 'Project not found.');
  const base = `/api/v1/projects/${p.id}`;
  return sendItem(req, res, {
    id: p.id, name: p.name, client: p.clientName, site: p.siteLocation, status: p.status,
    startDate: iso(p.startDate), targetDate: iso(p.targetCompletionDate),
    counts: { documents: p._count.procurementDocs, grns: p._count.grns, payments: p._count.vendorPayments, tasks: p._count.ganttActivities, boqItems: p._count.boqItems },
    deepLink: deepLink('project', p.id, p.id),
    links: {
      purchaseOrders: `${base}/purchase-orders`, workOrders: `${base}/work-orders`, grns: `${base}/grns`,
      payments: `${base}/payments`, tasks: `${base}/tasks`, boqItems: `${base}/boq-items`,
      team: `${base}/team`, zones: `${base}/zones`, milestones: `${base}/milestones`,
      drawings: `${base}/drawings`, changeOrders: `${base}/change-orders`,
      quotations: `${base}/quotations`, documents: `${base}/documents`, paymentMilestones: `${base}/payment-milestones`,
      progress: `${base}/progress`, dpr: `${base}/dpr`, budget: `${base}/budget`,
      approvals: `/api/v1/approvals?assignedTo=<userId|email|employeeCode>`,
    },
  });
}));

// ── Procurement realm ─────────────────────────────────────────────────────────
async function docsPage(req: Request, type: 'PO' | 'WO') {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id, type };
  const [docs, total] = await Promise.all([
    prisma.procurementDoc.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, docNumber: true, vendorName: true, status: true, docDate: true, basicAmount: true, finalAmount: true } }),
    prisma.procurementDoc.count({ where }),
  ]);
  const entity = type === 'PO' ? 'po' : 'wo';
  const rows = docs.map((d) => ({
    id: d.id, number: d.docNumber, vendor: d.vendorName, status: d.status, date: iso(d.docDate),
    basicAmount: d.basicAmount, finalAmount: d.finalAmount, deepLink: deepLink(entity, d.id, req.params.id),
  }));
  return { rows, total };
}
router.get('/projects/:id/purchase-orders', requireRealm('procurement'), asyncHandler(async (req, res) => {
  const { rows, total } = await docsPage(req, 'PO'); return sendList(req, res, rows, total);
}));
router.get('/projects/:id/work-orders', requireRealm('procurement'), asyncHandler(async (req, res) => {
  const { rows, total } = await docsPage(req, 'WO'); return sendList(req, res, rows, total);
}));

router.get('/projects/:id/grns', requireRealm('procurement'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [grns, total] = await Promise.all([
    prisma.gRN.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, grnNumber: true, vendorName: true, status: true, grnDate: true, invoiceNumber: true, invoiceValue: true, doc: { select: { docNumber: true } } } }),
    prisma.gRN.count({ where }),
  ]);
  const rows = grns.map((g) => ({
    id: g.id, number: g.grnNumber, against: g.doc?.docNumber, vendor: g.vendorName, status: g.status,
    date: iso(g.grnDate), invoiceNumber: g.invoiceNumber, invoiceValue: g.invoiceValue, deepLink: deepLink('grn', g.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/boq-items', requireRealm('procurement'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id, isGroup: false };
  const [items, total] = await Promise.all([
    prisma.bOQItem.findMany({ where, orderBy: [{ sortOrder: 'asc' }], skip: offset, take: limit,
      select: { id: true, srNo: true, description: true, category: true, unit: true, plannedQty: true, modelNumber: true } }),
    prisma.bOQItem.count({ where }),
  ]);
  const rows = items.map((i) => ({
    id: i.id, srNo: i.srNo, description: i.description, category: i.category, unit: i.unit, plannedQty: i.plannedQty, modelNumber: i.modelNumber,
    deepLink: deepLink('boq', i.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

// ── Finance realm (requires read:money to call at all) ────────────────────────
router.get('/projects/:id/payments', requireRealm('finance'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [pays, total] = await Promise.all([
    prisma.vendorPayment.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, paymentNumber: true, vendorName: true, poNumber: true, amountToPay: true, status: true, paidAt: true } }),
    prisma.vendorPayment.count({ where }),
  ]);
  const rows = pays.map((p) => ({
    id: p.id, number: p.paymentNumber, vendor: p.vendorName, po: p.poNumber, amount: p.amountToPay, status: p.status,
    paidAt: iso(p.paidAt), deepLink: deepLink('payment', p.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

// ── Timeline realm ────────────────────────────────────────────────────────────
// `responsibleUserId` is the real project user a task is assigned to (when it is
// — many Coldroom tasks are assigned to a role/vendor string instead, which stays
// in `responsible`). Surfacing the user id + email lets an integrator slot the
// assigned ones into a per-person "My Tasks" view; the rest are programme tasks.
type TaskRow = { id: string; activityName: string; status: string; percentComplete: number; plannedStartDate: Date; plannedEndDate: Date; actualStartDate: Date | null; actualEndDate: Date | null; responsibleName: string | null; responsibleUserId: string | null };
type Assignee = { name?: string | null; email: string | null; employeeCode: string | null };
const mapTask = (t: TaskRow, projectId: string, byId?: Map<string, Assignee>) => {
  const a = t.responsibleUserId ? byId?.get(t.responsibleUserId) : undefined;
  return {
    id: t.id, name: t.activityName, status: t.status, percentComplete: t.percentComplete,
    plannedStart: iso(t.plannedStartDate), plannedEnd: iso(t.plannedEndDate),
    actualStart: iso(t.actualStartDate), actualEnd: iso(t.actualEndDate),
    // The assigned person's name when owned by a real user; otherwise the
    // free-text role/vendor label (e.g. "Refrigeration contractor").
    responsible: a?.name ?? t.responsibleName,
    responsibleUserId: t.responsibleUserId ?? null,
    responsibleEmail: a?.email ?? null,
    responsibleEmployeeCode: a?.employeeCode ?? null,
    deepLink: deepLink('task', t.id, projectId),
  };
};
const TASK_SELECT = { id: true, activityName: true, status: true, percentComplete: true, plannedStartDate: true, plannedEndDate: true, actualStartDate: true, actualEndDate: true, responsibleName: true, responsibleUserId: true } as const;

router.get('/projects/:id/tasks', requireRealm('timeline'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  // Optional per-assignee filter: ?assignedTo=<userId | email>. Unmatched → empty
  // list (never an error). A free-text/role-assigned task has no responsibleUserId
  // and so never matches a person — which is correct.
  const where: { projectId: string; responsibleUserId?: string } = { projectId: req.params.id };
  // ?assignedTo matches a user by internal id, email, OR company employeeCode —
  // whichever the caller has. Unmatched → empty list (never an error).
  const assignedTo = (req.query.assignedTo as string | undefined)?.trim();
  if (assignedTo) {
    const u = await prisma.user.findFirst({ where: { OR: [{ id: assignedTo }, { email: assignedTo }, { employeeCode: assignedTo }] }, select: { id: true } });
    where.responsibleUserId = u?.id ?? '__no_such_user__';
  }
  const [tasks, total] = await Promise.all([
    prisma.ganttActivity.findMany({ where, orderBy: { plannedStartDate: 'asc' }, skip: offset, take: limit, select: TASK_SELECT }),
    prisma.ganttActivity.count({ where }),
  ]);
  // Resolve assignee email + employeeCode in one batch (ships only to read:people keys).
  const uids = [...new Set(tasks.map((t) => t.responsibleUserId).filter((v): v is string => !!v))];
  const users = uids.length ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, name: true, email: true, employeeCode: true } }) : [];
  const byId = new Map(users.map((u) => [u.id, { name: u.name, email: u.email, employeeCode: u.employeeCode }]));
  return sendList(req, res, tasks.map((t) => mapTask(t, req.params.id, byId)), total);
}));

// ── Approvals realm ───────────────────────────────────────────────────────────
// Unlike Gantt tasks (often owned by a role/vendor), an approval step ALWAYS
// belongs to one person — so this is the natural per-person "what's on my plate"
// feed. Each row's deepLink opens the underlying PO/WO/GRN/payment, where the
// approver can actually act.
const APPROVAL_ENTITY: Record<string, 'po' | 'wo' | 'grn' | 'payment'> = { PO: 'po', WO: 'wo', GRN: 'grn', PAYMENT: 'payment' };

router.get('/approvals', requireRealm('approvals'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  // ?assignedTo=<userId | email | employeeCode>, ?status=PENDING (default) | any | APPROVED | ON_HOLD
  const where: { approverId?: string; status?: string } = {};
  const assignedTo = (req.query.assignedTo as string | undefined)?.trim();
  if (assignedTo) {
    const u = await prisma.user.findFirst({ where: { OR: [{ id: assignedTo }, { email: assignedTo }, { employeeCode: assignedTo }] }, select: { id: true } });
    where.approverId = u?.id ?? '__no_such_user__';
  }
  const status = ((req.query.status as string | undefined) || 'PENDING').toUpperCase();
  if (status !== 'ANY') where.status = status;

  const [steps, total] = await Promise.all([
    prisma.approvalStep.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
    prisma.approvalStep.count({ where }),
  ]);

  // Resolve approver identity + the parent doc (number/amount) in batches.
  const uids = [...new Set(steps.map((s) => s.approverId).filter(Boolean))];
  const users = uids.length ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, email: true, employeeCode: true } }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const docIds = (t: string) => steps.filter((s) => s.docType === t).map((s) => s.docId);
  const [procDocs, grns, pays] = await Promise.all([
    prisma.procurementDoc.findMany({ where: { id: { in: [...docIds('PO'), ...docIds('WO')] } }, select: { id: true, docNumber: true, finalAmount: true, vendorName: true, status: true } }),
    prisma.gRN.findMany({ where: { id: { in: docIds('GRN') } }, select: { id: true, grnNumber: true, invoiceValue: true, vendorName: true, status: true } }),
    prisma.vendorPayment.findMany({ where: { id: { in: docIds('PAYMENT') } }, select: { id: true, paymentNumber: true, amountToPay: true, vendorName: true, status: true } }),
  ]);
  const docById = new Map<string, { number: string; amount: number | null; vendor: string | null; status: string }>();
  for (const d of procDocs) docById.set(d.id, { number: d.docNumber, amount: d.finalAmount, vendor: d.vendorName, status: d.status });
  for (const g of grns) docById.set(g.id, { number: g.grnNumber, amount: g.invoiceValue, vendor: g.vendorName, status: g.status });
  for (const p of pays) docById.set(p.id, { number: p.paymentNumber, amount: p.amountToPay, vendor: p.vendorName, status: p.status });

  const rows = steps.map((s) => {
    const u = s.approverId ? userById.get(s.approverId) : undefined;
    const d = docById.get(s.docId);
    const ent = APPROVAL_ENTITY[s.docType];
    return {
      id: s.id,
      docType: s.docType, docId: s.docId, docNumber: d?.number ?? null, docStatus: d?.status ?? null,
      projectId: s.projectId,
      vendor: d?.vendor ?? null,          // read:parties
      amount: d?.amount ?? null,          // read:money
      step: s.order, status: s.status,    // WAITING | PENDING | APPROVED | ON_HOLD
      approverName: s.approverName,       // read:people
      approverUserId: s.approverId,
      approverEmail: u?.email ?? s.approverEmail ?? null,
      approverEmployeeCode: u?.employeeCode ?? null,
      remarks: s.remarks, raisedAt: iso(s.createdAt), actedAt: iso(s.actedAt),
      // Opens the actual document, where this person approves it.
      deepLink: ent ? deepLink(ent, s.docId, s.projectId) : deepLink('project', s.projectId, s.projectId),
    };
  });
  return sendList(req, res, rows, total);
}));

// ── Vendors realm (requires read:parties to call at all) ──────────────────────
router.get('/vendors', requireRealm('vendors'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { isActive: true };
  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({ where, orderBy: { name: 'asc' }, skip: offset, take: limit,
      select: { id: true, name: true, type: true, gstin: true, pan: true, contactPerson: true, phones: true } }),
    prisma.vendor.count({ where }),
  ]);
  // The company name IS counterparty data here, so surface it as `vendorName`
  // (classified read:parties) rather than the always-core `name`.
  const rows = vendors.map((v) => ({ id: v.id, vendorName: v.name, type: v.type, gstin: v.gstin, pan: v.pan, contact: v.contactPerson, phone: v.phones, deepLink: deepLink('vendor', v.id) }));
  return sendList(req, res, rows, total);
}));

// ── Projects realm — the rest of a project ────────────────────────────────────
router.get('/projects/:id/team', requireRealm('projects'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [members, total] = await Promise.all([
    prisma.projectMember.findMany({ where, skip: offset, take: limit, include: { user: { select: { id: true, name: true, email: true, employeeCode: true, role: true } } } }),
    prisma.projectMember.count({ where }),
  ]);
  const rows = members.map((m) => ({
    id: m.id, projectRole: m.role, userId: m.userId,
    employeeName: m.user?.name ?? null, approverEmail: m.user?.email ?? null, employeeCode: m.user?.employeeCode ?? null,
    systemRole: m.user?.role ?? null, deepLink: deepLink('team', m.projectId, m.projectId),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/zones', requireRealm('projects'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [zones, total] = await Promise.all([
    prisma.projectZone.findMany({ where, orderBy: { sortOrder: 'asc' }, skip: offset, take: limit,
      select: { id: true, zoneName: true, boqCategory: true, roomType: true, heightM: true, temperatureRange: true, isCommonBucket: true, plannedHandoverDate: true, actualHandoverDate: true, handoverCertUrl: true } }),
    prisma.projectZone.count({ where }),
  ]);
  const rows = zones.map((z) => ({
    id: z.id, zoneName: z.zoneName, category: z.boqCategory, roomType: z.roomType, heightM: z.heightM,
    temperatureRange: z.temperatureRange, isCommon: z.isCommonBucket,
    plannedHandover: iso(z.plannedHandoverDate), actualHandover: iso(z.actualHandoverDate),
    handoverCertUrl: z.handoverCertUrl, deepLink: deepLink('zone', z.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/milestones', requireRealm('projects'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [ms, total] = await Promise.all([
    prisma.projectMilestone.findMany({ where, orderBy: { sortOrder: 'asc' }, skip: offset, take: limit,
      select: { id: true, name: true, zoneId: true, committedDateVendor: true, fkiFreezeDate: true, actualDate: true, remarks: true } }),
    prisma.projectMilestone.count({ where }),
  ]);
  const rows = ms.map((x) => ({
    id: x.id, name: x.name, zoneId: x.zoneId, committedDate: iso(x.committedDateVendor),
    freezeDate: iso(x.fkiFreezeDate), actualDate: iso(x.actualDate), remarks: x.remarks,
    deepLink: deepLink('milestone', x.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/drawings', requireRealm('projects'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [dr, total] = await Promise.all([
    prisma.drawing.findMany({ where, orderBy: { uploadedAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, fileName: true, fileUrl: true, mimeType: true, fileSize: true, version: true, status: true, classification: true, discipline: true, isFinal: true, uploadedAt: true, finalisedAt: true, revisionNotes: true } }),
    prisma.drawing.count({ where }),
  ]);
  const rows = dr.map((d) => ({
    id: d.id, fileName: d.fileName, fileUrl: d.fileUrl, mimeType: d.mimeType, fileSize: d.fileSize,
    version: d.version, status: d.status, classification: d.classification, discipline: d.discipline,
    isFinal: d.isFinal, uploadedAt: iso(d.uploadedAt), finalisedAt: iso(d.finalisedAt), revisionNotes: d.revisionNotes,
    deepLink: deepLink('drawing', d.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/change-orders', requireRealm('projects'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [cos, total] = await Promise.all([
    prisma.changeOrder.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, coNumber: true, type: true, description: true, boqItemId: true, originalQty: true, changeQty: true, newTotalQty: true, unit: true, costImpact: true, paidByClient: true, justification: true, status: true, approvedAt: true, createdAt: true } }),
    prisma.changeOrder.count({ where }),
  ]);
  const rows = cos.map((c) => ({
    id: c.id, number: c.coNumber, type: c.type, description: c.description, boqItemId: c.boqItemId,
    originalQty: c.originalQty, changeQty: c.changeQty, newTotalQty: c.newTotalQty, unit: c.unit,
    costImpact: c.costImpact, paidByClient: c.paidByClient, justification: c.justification,
    status: c.status, approvedAt: iso(c.approvedAt), raisedAt: iso(c.createdAt),
    deepLink: deepLink('changeorder', c.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

// ── Procurement realm — the rest ──────────────────────────────────────────────
router.get('/projects/:id/quotations', requireRealm('procurement'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [qs, total] = await Promise.all([
    prisma.vendorQuotation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, boqItemId: true, vendorName: true, price: true, deliveryDate: true, deliveryWeeks: true, leadTimeText: true, paymentTerms: true, qualityRemarks: true, modelNumber: true, tdsUrl: true, quotationPdfUrl: true, revision: true, status: true, createdAt: true } }),
    prisma.vendorQuotation.count({ where }),
  ]);
  const rows = qs.map((q) => ({
    id: q.id, boqItemId: q.boqItemId, vendor: q.vendorName, price: q.price,
    deliveryDate: iso(q.deliveryDate), deliveryWeeks: q.deliveryWeeks, leadTime: q.leadTimeText,
    paymentTerms: q.paymentTerms, remarks: q.qualityRemarks, modelNumber: q.modelNumber,
    tdsUrl: q.tdsUrl, quotationPdfUrl: q.quotationPdfUrl, revision: q.revision, status: q.status,
    quotedAt: iso(q.createdAt), deepLink: deepLink('quotation', q.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/documents', requireRealm('procurement'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id, archived: false };
  const [docs, total] = await Promise.all([
    prisma.procurementDocument.findMany({ where, orderBy: { uploadedAt: 'desc' }, skip: offset, take: limit,
      select: { id: true, type: true, fileName: true, fileUrl: true, mimeType: true, linkedDocNumber: true, vendorName: true, uploadedAt: true } }),
    prisma.procurementDocument.count({ where }),
  ]);
  const rows = docs.map((d) => ({
    id: d.id, type: d.type, fileName: d.fileName, fileUrl: d.fileUrl, mimeType: d.mimeType,
    linkedDocNumber: d.linkedDocNumber, vendor: d.vendorName, uploadedAt: iso(d.uploadedAt),
    deepLink: deepLink('document', d.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/payment-milestones', requireRealm('procurement'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  // Milestones hang off a doc, so scope them to this project's docs.
  const docs = await prisma.procurementDoc.findMany({ where: { projectId: req.params.id }, select: { id: true, docNumber: true } });
  const numberByDoc = new Map(docs.map((d) => [d.id, d.docNumber]));
  const where = { docId: { in: docs.map((d) => d.id) } };
  const [ms, total] = await Promise.all([
    prisma.paymentMilestone.findMany({ where, orderBy: { sortOrder: 'asc' }, skip: offset, take: limit,
      select: { id: true, docId: true, name: true, triggerCondition: true, percentage: true, inrAmount: true, expectedDate: true, actualTriggerDate: true, status: true, paymentDate: true, utrNumber: true, remarks: true } }),
    prisma.paymentMilestone.count({ where }),
  ]);
  const rows = ms.map((x) => ({
    id: x.id, docId: x.docId, docNumber: numberByDoc.get(x.docId) ?? null, name: x.name,
    trigger: x.triggerCondition, percentage: x.percentage, inrAmount: x.inrAmount,
    expectedDate: iso(x.expectedDate), triggeredAt: iso(x.actualTriggerDate), status: x.status,
    paidOn: iso(x.paymentDate), utrNumber: x.utrNumber, remarks: x.remarks,
    deepLink: deepLink('milestone', x.docId, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

// ── Timeline realm — the rest ─────────────────────────────────────────────────
router.get('/projects/:id/progress', requireRealm('timeline'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [ps, total] = await Promise.all([
    prisma.progressEntry.findMany({ where, orderBy: { date: 'desc' }, skip: offset, take: limit,
      select: { id: true, boqItemId: true, date: true, quantityInstalled: true, unit: true, photoUrl: true, remarks: true, status: true, approvedAt: true } }),
    prisma.progressEntry.count({ where }),
  ]);
  const rows = ps.map((p) => ({
    id: p.id, boqItemId: p.boqItemId, date: iso(p.date), quantityInstalled: p.quantityInstalled,
    unit: p.unit, photoUrl: p.photoUrl, remarks: p.remarks, status: p.status, approvedAt: iso(p.approvedAt),
    deepLink: deepLink('progress', p.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

router.get('/projects/:id/dpr', requireRealm('timeline'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [ds, total] = await Promise.all([
    prisma.dPREntry.findMany({ where, orderBy: { date: 'desc' }, skip: offset, take: limit,
      select: { id: true, roomScopeItemId: true, kind: true, date: true, qtyDoneToday: true, labourTeam: true, remarks: true, photoUrl: true, status: true } }),
    prisma.dPREntry.count({ where }),
  ]);
  const rows = ds.map((d) => ({
    id: d.id, roomScopeItemId: d.roomScopeItemId, kind: d.kind, date: iso(d.date),
    qtyDoneToday: d.qtyDoneToday, labourTeam: d.labourTeam, remarks: d.remarks, photoUrl: d.photoUrl,
    status: d.status, deepLink: deepLink('dpr', d.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

// ── Finance realm — the rest (requires read:money) ────────────────────────────
router.get('/projects/:id/budget', requireRealm('finance'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [bs, total] = await Promise.all([
    prisma.bOQBudgetLine.findMany({ where, skip: offset, take: limit,
      select: { id: true, boqItemId: true, budgetQty: true, budgetRate: true, budgetAmount: true, notes: true, updatedAt: true } }),
    prisma.bOQBudgetLine.count({ where }),
  ]);
  const rows = bs.map((b) => ({
    id: b.id, boqItemId: b.boqItemId, budgetQty: b.budgetQty, budgetRate: b.budgetRate,
    budgetAmount: b.budgetAmount, notes: b.notes, updatedAt: iso(b.updatedAt),
    deepLink: deepLink('budget', b.boqItemId ?? b.id, req.params.id),
  }));
  return sendList(req, res, rows, total);
}));

// ── Vendors realm — machine model master ──────────────────────────────────────
router.get('/machine-models', requireRealm('vendors'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { isActive: true };
  const [mm, total] = await Promise.all([
    prisma.machineModel.findMany({ where, orderBy: { modelCode: 'asc' }, skip: offset, take: limit,
      select: { id: true, make: true, modelCode: true, fullDisplayName: true, capacityKW: true, refrigerantType: true, compressorType: true, applicableRooms: true, unitPrice: true, tdsUrl: true, evaporatorTempC: true, condenserTempC: true, airflow: true, powerInputKw: true, weightKg: true, dimensions: true, voltage: true, compressorModel: true } }),
    prisma.machineModel.count({ where }),
  ]);
  const rows = mm.map((m) => ({
    id: m.id, make: m.make, modelCode: m.modelCode, displayName: m.fullDisplayName,
    capacityKW: m.capacityKW, refrigerant: m.refrigerantType, compressorType: m.compressorType,
    applicableRooms: m.applicableRooms, unitPrice: m.unitPrice, tdsUrl: m.tdsUrl,
    evaporatorTempC: m.evaporatorTempC, condenserTempC: m.condenserTempC, airflow: m.airflow,
    powerInputKw: m.powerInputKw, weightKg: m.weightKg, dimensions: m.dimensions, voltage: m.voltage,
    compressorModel: m.compressorModel, deepLink: deepLink('machinemodel', m.id),
  }));
  return sendList(req, res, rows, total);
}));

// ── Write endpoints (timeline realm + write:tasks scope) ──────────────────────
// The API is just another caller of the same task actions the dashboard uses:
// read-only keys can never reach these. Retries are idempotent via Idempotency-Key.

type Produced = { status: number; body: unknown };
const errBody = (code: string, message: string, detail?: Record<string, unknown>) => ({ error: { code, message, ...(detail || {}) } });

// Idempotency wraps the ENTIRE handler (preconditions included): the cache is
// checked FIRST, so a retried Idempotency-Key replays the original response even
// though the underlying state has since changed (e.g. the task is now complete).
async function idempotent(req: Request, res: Response, produce: () => Promise<Produced>) {
  const keyId = req.apiKey!.id;
  const idem = req.header('idempotency-key');
  if (idem) {
    const prior = await prisma.apiIdempotencyRecord.findUnique({ where: { keyId_idemKey: { keyId, idemKey: idem } } });
    if (prior) return res.status(prior.status).json(prior.response);
  }
  const { status, body } = await produce();
  // Persist the result BEFORE responding (awaited, not fire-and-forget) so a
  // retry that arrives right after sees the record and replays it, rather than
  // re-running the mutation. A duplicate-key race is harmless — swallow it.
  if (idem) await prisma.apiIdempotencyRecord.create({ data: { keyId, idemKey: idem, status, response: body as object } }).catch(() => {});
  return res.status(status).json(body);
}

async function loadTask(projectId: string, taskId: string) {
  return prisma.ganttActivity.findFirst({ where: { id: taskId, projectId } });
}
function actor(req: Request) { return `apiKey:${req.apiKey!.id} (${req.apiKey!.name})`; }
async function taskItem(id: string, projectId: string, scopes: string[]) {
  const t = await prisma.ganttActivity.findUnique({ where: { id }, select: TASK_SELECT });
  const byId = new Map<string, Assignee>();
  if (t?.responsibleUserId) {
    const u = await prisma.user.findUnique({ where: { id: t.responsibleUserId }, select: { name: true, email: true, employeeCode: true } });
    if (u) byId.set(t.responsibleUserId, { name: u.name, email: u.email, employeeCode: u.employeeCode });
  }
  return applyScopes(mapTask(t!, projectId, byId), scopes).data; // respect the key's scopes
}

router.post('/projects/:id/tasks/:taskId/start', requireRealm('timeline'), requireScope('write:tasks'), asyncHandler(async (req, res) => {
  return idempotent(req, res, async (): Promise<Produced> => {
    const t = await loadTask(req.params.id, req.params.taskId);
    if (!t) return { status: 404, body: errBody('not_found', 'Task not found.') };
    const parse = z.object({ date: z.string().datetime().optional() }).safeParse(req.body ?? {});
    if (!parse.success) return { status: 400, body: errBody('validation_error', 'Invalid date.', { issues: parse.error.issues }) };
    if (t.actualEndDate) return { status: 400, body: errBody('validation_error', 'Task is already complete.') };
    const when = parse.data.date ? new Date(parse.data.date) : new Date();
    await prisma.ganttActivity.update({ where: { id: t.id }, data: { actualStartDate: when, status: 'IN_PROGRESS' } });
    await audit({ userId: null, projectId: req.params.id, action: 'GANTT_MARK_STARTED', entity: 'GanttActivity', entityId: t.id, details: { actor: actor(req), actualStartDate: when } });
    return { status: 200, body: { data: await taskItem(t.id, req.params.id, req.apiKey!.scopes) } };
  });
}));

router.post('/projects/:id/tasks/:taskId/complete', requireRealm('timeline'), requireScope('write:tasks'), asyncHandler(async (req, res) => {
  return idempotent(req, res, async (): Promise<Produced> => {
    const t = await loadTask(req.params.id, req.params.taskId);
    if (!t) return { status: 404, body: errBody('not_found', 'Task not found.') };
    const parse = z.object({ date: z.string().datetime().optional(), notes: z.string().max(2000).optional() }).safeParse(req.body ?? {});
    if (!parse.success) return { status: 400, body: errBody('validation_error', 'Invalid body.', { issues: parse.error.issues }) };
    if (t.actualEndDate) return { status: 400, body: errBody('validation_error', 'Task is already complete.') };
    const when = parse.data.date ? new Date(parse.data.date) : new Date();
    await prisma.ganttActivity.update({ where: { id: t.id }, data: {
      actualEndDate: when, completedAt: new Date(), actualStartDate: t.actualStartDate ?? t.plannedStartDate,
      status: 'COMPLETED', percentComplete: 100, percentCompleteAuto: false, completionNotes: parse.data.notes ?? undefined,
    } });
    await audit({ userId: null, projectId: req.params.id, action: 'GANTT_MARK_COMPLETE', entity: 'GanttActivity', entityId: t.id, details: { actor: actor(req), actualEndDate: when, notes: parse.data.notes } });
    return { status: 200, body: { data: await taskItem(t.id, req.params.id, req.apiKey!.scopes) } };
  });
}));

router.post('/projects/:id/tasks/:taskId/progress', requireRealm('timeline'), requireScope('write:tasks'), asyncHandler(async (req, res) => {
  return idempotent(req, res, async (): Promise<Produced> => {
    const t = await loadTask(req.params.id, req.params.taskId);
    if (!t) return { status: 404, body: errBody('not_found', 'Task not found.') };
    const parse = z.object({ percentComplete: z.coerce.number().min(0).max(100) }).safeParse(req.body ?? {});
    if (!parse.success) return { status: 400, body: errBody('validation_error', 'percentComplete must be 0–100.', { issues: parse.error.issues }) };
    if (t.actualEndDate) return { status: 400, body: errBody('validation_error', 'Task is already complete.') };
    const pct = parse.data.percentComplete;
    await prisma.ganttActivity.update({ where: { id: t.id }, data: {
      percentComplete: pct, percentCompleteAuto: false,
      status: pct > 0 ? 'IN_PROGRESS' : t.status, actualStartDate: t.actualStartDate ?? (pct > 0 ? new Date() : null),
    } });
    await audit({ userId: null, projectId: req.params.id, action: 'GANTT_SET_PROGRESS', entity: 'GanttActivity', entityId: t.id, details: { actor: actor(req), percentComplete: pct } });
    return { status: 200, body: { data: await taskItem(t.id, req.params.id, req.apiKey!.scopes) } };
  });
}));

export default router;
