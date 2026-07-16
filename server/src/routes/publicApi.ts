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
    links: { purchaseOrders: `${base}/purchase-orders`, workOrders: `${base}/work-orders`, grns: `${base}/grns`, payments: `${base}/payments`, tasks: `${base}/tasks`, boqItems: `${base}/boq-items` },
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
const mapTask = (t: { id: string; activityName: string; status: string; percentComplete: number; plannedStartDate: Date; plannedEndDate: Date; actualStartDate: Date | null; actualEndDate: Date | null; responsibleName: string | null }, projectId: string) => ({
  id: t.id, name: t.activityName, status: t.status, percentComplete: t.percentComplete,
  plannedStart: iso(t.plannedStartDate), plannedEnd: iso(t.plannedEndDate),
  actualStart: iso(t.actualStartDate), actualEnd: iso(t.actualEndDate), responsible: t.responsibleName,
  deepLink: deepLink('task', t.id, projectId),
});

router.get('/projects/:id/tasks', requireRealm('timeline'), asyncHandler(async (req, res) => {
  const { limit, offset } = parseListParams(req);
  const where = { projectId: req.params.id };
  const [tasks, total] = await Promise.all([
    prisma.ganttActivity.findMany({ where, orderBy: { plannedStartDate: 'asc' }, skip: offset, take: limit,
      select: { id: true, activityName: true, status: true, percentComplete: true, plannedStartDate: true, plannedEndDate: true, actualStartDate: true, actualEndDate: true, responsibleName: true } }),
    prisma.ganttActivity.count({ where }),
  ]);
  return sendList(req, res, tasks.map((t) => mapTask(t, req.params.id)), total);
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
  if (idem) prisma.apiIdempotencyRecord.create({ data: { keyId, idemKey: idem, status, response: body as object } }).catch(() => {});
  return res.status(status).json(body);
}

async function loadTask(projectId: string, taskId: string) {
  return prisma.ganttActivity.findFirst({ where: { id: taskId, projectId } });
}
function actor(req: Request) { return `apiKey:${req.apiKey!.id} (${req.apiKey!.name})`; }
async function taskItem(id: string, projectId: string) {
  const t = await prisma.ganttActivity.findUnique({ where: { id }, select: { id: true, activityName: true, status: true, percentComplete: true, plannedStartDate: true, plannedEndDate: true, actualStartDate: true, actualEndDate: true, responsibleName: true } });
  return applyScopes(mapTask(t!, projectId), []).data; // task item has no sensitive fields; core-only view is fine
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
    return { status: 200, body: { data: await taskItem(t.id, req.params.id) } };
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
    return { status: 200, body: { data: await taskItem(t.id, req.params.id) } };
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
    return { status: 200, body: { data: await taskItem(t.id, req.params.id) } };
  });
}));

export default router;
