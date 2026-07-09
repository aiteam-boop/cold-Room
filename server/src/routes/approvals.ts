import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requirePage } from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';
import { parseApprover } from '../lib/permissions';
import { isAdmin } from '../lib/enums';
import { verifyApprovalToken, recordDecision, finalizeApproval, markDocRejected, resolveActor } from '../services/approvalChain';

const router = Router();

// ── Public, token-authenticated one-click approval (from email links) ────────
// These MUST be declared before `requireAuth` — the approver may not have an app
// session; the signed token in the URL is the authorisation.
function actPage(token: string, message?: string, done?: boolean): string {
  const form = done ? '' : `
    <textarea id="remarks" placeholder="Remarks (optional)" style="width:100%;box-sizing:border-box;min-height:64px;margin:12px 0;padding:8px;border:1px solid #cbd5e1;border-radius:8px"></textarea>
    <div style="display:flex;gap:8px">
      <button onclick="act('APPROVE')" style="flex:1;background:#16a34a;color:#fff;border:0;padding:10px;border-radius:8px;font-size:15px;cursor:pointer">Approve</button>
      <button onclick="act('REJECT')" style="flex:1;background:#dc2626;color:#fff;border:0;padding:10px;border-radius:8px;font-size:15px;cursor:pointer">Reject</button>
    </div>
    <script>
      async function act(decision){
        const remarks=document.getElementById('remarks').value;
        const r=await fetch('/api/approvals/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)},decision,remarks})});
        const d=await r.json();
        document.getElementById('msg').textContent=d.ok?('Recorded: '+(decision==='REJECT'?'Rejected':(d.outcome==='COMPLETED'?'Approved (final)':'Approved'))+'.':('Error: '+(d.error||'failed')));
        document.getElementById('actions').style.display='none';
      }
    </script>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRMCTS Approval</title></head>
  <body style="font-family:Segoe UI,Arial,sans-serif;background:#f1f5f9;padding:24px">
    <div style="max-width:480px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px">
      <div style="font-weight:700;color:#0f172a;font-size:18px">CRMCTS · Approval</div>
      <p id="msg" style="color:#334155;font-size:14px;margin:12px 0">${message ?? ''}</p>
      <div id="actions">${form}</div>
    </div>
  </body></html>`;
}

// GET — render the confirm page.
router.get('/act', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const p = verifyApprovalToken(token);
  if (!p) return res.status(400).send(actPage('', 'This approval link is invalid or has expired.', true));
  const step = await prisma.approvalStep.findUnique({ where: { id: p.stepId } });
  if (step && step.status !== 'PENDING') return res.send(actPage(token, `This step has already been ${step.status.toLowerCase()}.`, true));
  res.send(actPage(token, 'Review this document and record your decision.'));
}));

// POST — perform the decision (JSON body from the confirm page).
router.post('/act', asyncHandler(async (req, res) => {
  const { token, decision, remarks } = req.body ?? {};
  const p = verifyApprovalToken(String(token || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'Invalid or expired link' });
  const actor = await resolveActor(p.approverId);
  try {
    const dec = decision === 'REJECT' ? 'REJECT' : 'APPROVE';
    const outcome = await recordDecision(p.docType, p.docId, actor, dec, typeof remarks === 'string' ? remarks : undefined);
    if (dec === 'REJECT') await markDocRejected(p.docType, p.docId, (typeof remarks === 'string' && remarks) || 'Rejected via email');
    else if (outcome === 'COMPLETED') await finalizeApproval(p.docType, p.docId, actor.id);
    res.json({ ok: true, outcome });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : 'Failed' });
  }
}));

router.use(requireAuth);

// GET /api/approvals/approvers — the approver registry (single source of truth
// for building approval chains). Any authenticated user can read it so document
// creators can pick a chain.
//
// Returned: everyone flagged canApprove, PLUS every ADMIN. Admins can approve any
// document type ("Admins can approve anything — no explicit approver setup
// needed") so they belong in the chain picker with types = ['ALL'], even though
// their approver profile is empty. `isAdmin` lets the UI label them.
router.get(
  '/approvers',
  asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, whatsapp: true, approver: true, role: true },
    });
    const approvers = users
      .map((u) => ({ user: u, p: parseApprover(u.approver), admin: isAdmin(u.role) }))
      .filter(({ p, admin }) => p.canApprove || admin)
      .map(({ user, p, admin }) => ({
        id: user.id, name: user.name, email: user.email, whatsapp: user.whatsapp ?? '',
        // An admin who hasn't set up a profile still approves every type.
        approvalRole: p.approvalRole || (admin ? 'Admin' : null),
        level: p.level,
        types: admin && !p.types.length ? ['ALL'] : p.types,
        isAdmin: admin,
      }));
    res.json({ approvers });
  })
);

// GET /api/approvals/mine — documents (PO/WO/GRN) where the signed-in user is
// the CURRENT pending approver. Admins see every pending item (chain steps +
// legacy no-chain docs). Actionable directly from the Approvals page; needs no
// project membership or page grant — being the approver is the authorisation.
router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const me = req.account!;
  const admin = me.role === 'ADMIN';

  const steps = await prisma.approvalStep.findMany({
    where: { status: 'PENDING', ...(admin ? {} : { approverId: me.id }) },
    orderBy: { createdAt: 'asc' },
  });
  const poIds = steps.filter((s) => s.docType !== 'GRN').map((s) => s.docId);
  const grnIds = steps.filter((s) => s.docType === 'GRN').map((s) => s.docId);

  const [docs, grns] = await Promise.all([
    prisma.procurementDoc.findMany({ where: { id: { in: poIds } }, include: { project: { select: { name: true } } } }),
    prisma.gRN.findMany({ where: { id: { in: grnIds } }, include: { project: { select: { name: true } } } }),
  ]);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const grnById = new Map(grns.map((g) => [g.id, g]));

  const items = steps.map((s) => {
    if (s.docType === 'GRN') {
      const g = grnById.get(s.docId);
      return g && { kind: 'GRN', docId: g.id, projectId: g.projectId, projectName: g.project?.name, number: g.grnNumber, vendorName: g.vendorName, finalAmount: g.invoiceValue, basicAmount: g.invoiceValue, submittedAt: g.createdAt, myRole: s.approverRole, invoiceNumber: g.invoiceNumber, invoicePdfUrl: g.invoicePdfUrl };
    }
    const d = docById.get(s.docId);
    return d && { kind: d.type, docId: d.id, projectId: d.projectId, projectName: d.project?.name, number: d.docNumber, vendorName: d.vendorName, finalAmount: d.finalAmount, basicAmount: d.basicAmount, submittedAt: d.updatedAt, myRole: s.approverRole };
  }).filter(Boolean) as any[];

  // Admins also see legacy items that were submitted without an approval chain.
  if (admin) {
    const withChain = new Set(steps.map((s) => s.docId));
    const [legacyDocs, legacyGrns] = await Promise.all([
      prisma.procurementDoc.findMany({ where: { status: 'PENDING_APPROVAL', id: { notIn: [...withChain] } }, include: { project: { select: { name: true } } } }),
      prisma.gRN.findMany({ where: { status: 'OPEN', id: { notIn: [...withChain] } }, include: { project: { select: { name: true } } } }),
    ]);
    for (const d of legacyDocs) items.push({ kind: d.type, docId: d.id, projectId: d.projectId, projectName: d.project?.name, number: d.docNumber, vendorName: d.vendorName, finalAmount: d.finalAmount, basicAmount: d.basicAmount, submittedAt: d.updatedAt, myRole: null, legacy: true });
    for (const g of legacyGrns) items.push({ kind: 'GRN', docId: g.id, projectId: g.projectId, projectName: g.project?.name, number: g.grnNumber, vendorName: g.vendorName, finalAmount: g.invoiceValue, basicAmount: g.invoiceValue, submittedAt: g.createdAt, myRole: null, legacy: true, invoiceNumber: g.invoiceNumber, invoicePdfUrl: g.invoicePdfUrl });
  }

  res.json({ items: maskFinancials(items, req.account) });
}));

// GET /api/approvals/pending — all PO/WO pending approval across projects.
router.get(
  '/pending',
  requirePage('approvals'),
  asyncHandler(async (req, res) => {
    const docs = await prisma.procurementDoc.findMany({
      where: { status: 'PENDING_APPROVAL' },
      orderBy: { updatedAt: 'desc' },
      include: { project: { select: { id: true, name: true } } },
    });
    const creatorIds = [...new Set(docs.map((d) => d.createdById).filter(Boolean) as string[])];
    const creators = await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } });
    const nameById = new Map(creators.map((c) => [c.id, c.name]));
    res.json({
      docs: maskFinancials(docs.map((d) => ({
        id: d.id, projectId: d.projectId, projectName: d.project?.name,
        type: d.type, docNumber: d.docNumber, vendorName: d.vendorName,
        basicAmount: d.basicAmount, finalAmount: d.finalAmount,
        createdBy: d.createdById ? nameById.get(d.createdById) : null, submittedAt: d.updatedAt,
      })), req.account),
    });
  })
);

export default router;
