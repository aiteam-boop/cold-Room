import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requirePage } from '../middleware/authMiddleware';
import { maskFinancials } from '../lib/financial';
import { parseApprover } from '../lib/permissions';
import { isAdmin } from '../lib/enums';
import { verifyApprovalToken, recordDecision, finalizeApproval, markDocOnHold, resolveActor, approvalDocData, parseAmendments } from '../services/approvalChain';
import { signApiPath } from '../lib/signedUrl';

const router = Router();

// ── Public, token-authenticated one-click approval (from email links) ────────
// These MUST be declared before `requireAuth` — the approver may not have an app
// session; the signed token in the URL is the authorisation.
//
// The page embeds the document's actual PDF (PO/WO/GRN) via a short-lived signed
// URL so the approver reviews the whole thing before deciding. Approve/Reject
// POST back with an optional remark — the decision is never taken on page load,
// so an email-scanner prefetch can't approve anything.
function actPage(opts: { token: string; message?: string; done?: boolean; title?: string; subtitle?: string; pdfUrl?: string | null; intent?: string; amendments?: { remark: string; byName: string; at: string }[]; budget?: { description: string; budget: number | null; actual: number | null; variance: number | null; variancePct: number | null; wholePo?: boolean }[] }): string {
  const { token, message, done, title, subtitle, pdfUrl, intent, amendments, budget } = opts;
  // A document amended after approval comes back for RE-approval: show that, and
  // the reason the raiser gave, before the approver looks at the PDF.
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const rs = (n: number | null | undefined) => (n == null ? '—' : 'Rs. ' + n.toLocaleString('en-IN'));
  // Budget vs Actual for the approver (PRD §5) — same data as the builder's panel.
  const budgetTable = budget?.length
    ? `<div style="margin:12px 0;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px">
        <div style="font-size:14px;font-weight:700;color:#0f2942;margin-bottom:6px">Budget vs Actual</div>
        <table style="width:100%;border-collapse:collapse">
          <tr style="background:#f1f5f9;color:#475569;font-size:11px;text-transform:uppercase"><td style="padding:6px 8px">BOQ Item</td><td style="padding:6px 8px;text-align:right">Budget</td><td style="padding:6px 8px;text-align:right">This Doc</td><td style="padding:6px 8px;text-align:right">Variance</td></tr>
          ${budget.map((r) => { const under = r.variance != null && r.variance <= 0; return `<tr>
            <td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:13px">${esc(r.description.slice(0, 46))}</td>
            <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:13px">${rs(r.budget)}</td>
            <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:13px">${rs(r.actual)}${r.wholePo ? '<div style="font-size:9px;color:#94a3b8">whole PO</div>' : ''}</td>
            <td style="padding:6px 8px;border-top:1px solid #e2e8f0;text-align:right;font-size:13px;color:${r.variance == null ? '#94a3b8' : under ? '#16a34a' : '#dc2626'};font-weight:600">${r.variance == null ? '—' : `${under ? '−' : '+'}${rs(Math.abs(r.variance)).replace('Rs. ', '₹')}${r.variancePct != null ? ` (${r.variancePct > 0 ? '+' : ''}${r.variancePct}%)` : ''}`}</td></tr>`; }).join('')}
        </table>
        <div style="font-size:10px;color:#94a3b8;margin-top:4px">Internal only — not on the vendor document. Green = under budget, red = over.</div>
      </div>`
    : '';
  const amendBanner = amendments?.length
    ? (() => {
        const latest = amendments[amendments.length - 1];
        const earlier = amendments.slice(0, -1).reverse();
        const when = latest.at ? new Date(latest.at).toLocaleString('en-GB') : '';
        return `<div style="margin:12px 0;background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:12px 14px">
          <div style="font-size:14px;font-weight:700;color:#92400e">&#9888; Resubmitted after amendment — re-approval needed</div>
          <div style="font-size:11px;color:#b45309;text-transform:uppercase;letter-spacing:.3px;margin-top:8px">Reason for the amendment</div>
          <div style="font-size:15px;color:#78350f;margin-top:2px">${esc(latest.remark)}</div>
          <div style="font-size:12px;color:#b45309;margin-top:4px">&mdash; ${esc(latest.byName)}${when ? ` &middot; ${esc(when)}` : ''}</div>
          ${earlier.length ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #fde68a">
            <div style="font-size:11px;color:#b45309;text-transform:uppercase;letter-spacing:.3px">Earlier amendments (${earlier.length})</div>
            ${earlier.map((a) => `<div style="font-size:12px;color:#78350f;margin-top:4px">&bull; ${esc(a.remark)}<span style="color:#b45309"> &mdash; ${esc(a.byName)}${a.at ? ` &middot; ${esc(new Date(a.at).toLocaleString('en-GB'))}` : ''}</span></div>`).join('')}
          </div>` : ''}
        </div>`;
      })()
    : '';
  const viewer = pdfUrl
    ? `<div style="margin:14px 0">
         <iframe src="${pdfUrl}" title="Document" style="width:100%;height:72vh;border:1px solid #e2e8f0;border-radius:10px;background:#fff"></iframe>
         <div style="margin-top:6px"><a href="${pdfUrl}" target="_blank" rel="noreferrer" style="font-size:13px;color:#2563eb;text-decoration:none">Open the document in a new tab &#8599;</a></div>
       </div>`
    : `<p style="color:#64748b;font-size:13px;margin:12px 0">No printable document is attached to this approval.</p>`;
  // A document is never rejected outright: ON HOLD sends it back to the raiser
  // with a note on what to correct, so the remark is REQUIRED on that path.
  const focus = intent === 'hold' ? 'hold' : 'approve';
  const form = done ? '' : `${viewer}
    <label style="display:block;font-size:13px;color:#475569;margin-top:6px">Remarks <span style="color:#94a3b8">(required to put on hold — say what needs correcting)</span></label>
    <textarea id="remarks" placeholder="e.g. Invoice value does not match the PO — please correct line 2." style="width:100%;box-sizing:border-box;min-height:64px;margin:6px 0 12px;padding:8px;border:1px solid #cbd5e1;border-radius:8px"></textarea>
    <div style="display:flex;gap:10px">
      <button id="btnApprove" onclick="act('APPROVE')" style="flex:1;background:#16a34a;color:#fff;border:0;padding:12px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer">&#10003; Approve</button>
      <button id="btnHold" onclick="act('HOLD')" style="flex:1;background:#d97706;color:#fff;border:0;padding:12px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer">&#9208; Put On Hold</button>
    </div>
    <script>
      var FOCUS=${JSON.stringify(focus)};
      if(FOCUS==='hold'){var b=document.getElementById('btnHold');if(b)b.style.outline='3px solid #fde68a';}
      else{var a=document.getElementById('btnApprove');if(a)a.style.outline='3px solid #bbf7d0';}
      async function act(decision){
        var ap=document.getElementById('btnApprove'),hd=document.getElementById('btnHold');
        var remarks=document.getElementById('remarks').value;
        if(decision==='HOLD'&&!remarks.trim()){
          document.getElementById('msg').textContent='Please say what needs to be corrected before putting this on hold.';
          document.getElementById('remarks').focus();
          return;
        }
        if(ap)ap.disabled=true; if(hd)hd.disabled=true;
        try{
          var r=await fetch('/api/approvals/act',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)},decision:decision,remarks:remarks})});
          var d=await r.json();
          document.getElementById('msg').textContent=d.ok?('Recorded: '+(decision==='HOLD'?'Put on hold — sent back for correction':(d.outcome==='COMPLETED'?'Approved (final)':'Approved'))+'.'):('Error: '+(d.error||'failed'));
          if(d.ok)document.getElementById('actions').style.display='none';
          else{if(ap)ap.disabled=false; if(hd)hd.disabled=false;}
        }catch(e){document.getElementById('msg').textContent='Network error — please retry.';if(ap)ap.disabled=false;if(hd)hd.disabled=false;}
      }
    </script>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRMCTS Approval</title></head>
  <body style="font-family:Segoe UI,Arial,sans-serif;background:#f1f5f9;padding:20px;margin:0">
    <div style="max-width:900px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:22px 24px">
      <div style="font-weight:700;color:#0f172a;font-size:18px">CRMCTS &middot; ${title ? title : 'Approval'}</div>
      ${subtitle ? `<div style="color:#64748b;font-size:13px;margin-top:2px">${subtitle}</div>` : ''}
      ${done ? '' : amendBanner}
      ${done ? '' : budgetTable}
      <p id="msg" style="color:#334155;font-size:14px;margin:12px 0">${message ?? ''}</p>
      <div id="actions">${form}</div>
    </div>
  </body></html>`;
}

// GET — render the review + confirm page with the document PDF embedded.
router.get('/act', asyncHandler(async (req, res) => {
  const token = String(req.query.token || '');
  const intent = typeof req.query.intent === 'string' ? req.query.intent : undefined;
  const p = verifyApprovalToken(token);
  if (!p) return res.status(400).send(actPage({ token: '', message: 'This approval link is invalid or has expired.', done: true }));
  const step = await prisma.approvalStep.findUnique({ where: { id: p.stepId } });
  if (step && step.status !== 'PENDING') return res.send(actPage({ token, message: `This step has already been ${step.status.toLowerCase()}.`, done: true }));

  const data = await approvalDocData(p.docType, p.docId);
  // Sign the PDF path so the embedded viewer loads it without an app session.
  const pdfUrl = data?.pdfPath ? signApiPath(data.pdfPath) : null;
  res.send(actPage({
    token, intent, pdfUrl,
    title: data ? `${data.docLabelLong} ${data.number}` : 'Approval',
    subtitle: data?.amendments?.length
      ? 'This document was amended after approval and resubmitted. Review the change and the reason below, then Approve — or put it On Hold with a note on what to correct.'
      : 'Review the document below, then Approve — or put it On Hold with a note on what to correct.',
    amendments: data?.amendments,
    budget: data?.budget,
  }));
}));

// POST — perform the decision (JSON body from the confirm page). HOLD sends the
// document back to the raiser with the approver's note; it is never rejected.
router.post('/act', asyncHandler(async (req, res) => {
  const { token, decision, remarks } = req.body ?? {};
  const p = verifyApprovalToken(String(token || ''));
  if (!p) return res.status(400).json({ ok: false, error: 'Invalid or expired link' });
  const actor = await resolveActor(p.approverId);
  const note = typeof remarks === 'string' ? remarks.trim() : '';
  try {
    const dec = decision === 'HOLD' ? 'HOLD' : 'APPROVE';
    if (dec === 'HOLD' && !note) return res.status(400).json({ ok: false, error: 'Say what needs to be corrected before putting this on hold.' });
    const outcome = await recordDecision(p.docType, p.docId, actor, dec, note || undefined);
    if (dec === 'HOLD') await markDocOnHold(p.docType, p.docId, note);
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

  // `amendments` (non-empty) means the doc was changed after a previous approval
  // and resubmitted — the approver sees that, and the reason, before deciding.
  const items = steps.map((s) => {
    if (s.docType === 'GRN') {
      const g = grnById.get(s.docId);
      return g && { kind: 'GRN', docId: g.id, projectId: g.projectId, projectName: g.project?.name, number: g.grnNumber, vendorName: g.vendorName, finalAmount: g.invoiceValue, basicAmount: g.invoiceValue, submittedAt: g.createdAt, myRole: s.approverRole, invoiceNumber: g.invoiceNumber, invoicePdfUrl: g.invoicePdfUrl, amendments: parseAmendments(g.amendments) };
    }
    const d = docById.get(s.docId);
    return d && { kind: d.type, docId: d.id, projectId: d.projectId, projectName: d.project?.name, number: d.docNumber, vendorName: d.vendorName, finalAmount: d.finalAmount, basicAmount: d.basicAmount, submittedAt: d.updatedAt, myRole: s.approverRole, amendments: parseAmendments(d.amendments) };
  }).filter(Boolean) as any[];

  // Admins also see legacy items that were submitted without an approval chain.
  if (admin) {
    const withChain = new Set(steps.map((s) => s.docId));
    const [legacyDocs, legacyGrns] = await Promise.all([
      prisma.procurementDoc.findMany({ where: { status: 'PENDING_APPROVAL', id: { notIn: [...withChain] } }, include: { project: { select: { name: true } } } }),
      prisma.gRN.findMany({ where: { status: 'OPEN', id: { notIn: [...withChain] } }, include: { project: { select: { name: true } } } }),
    ]);
    for (const d of legacyDocs) items.push({ kind: d.type, docId: d.id, projectId: d.projectId, projectName: d.project?.name, number: d.docNumber, vendorName: d.vendorName, finalAmount: d.finalAmount, basicAmount: d.basicAmount, submittedAt: d.updatedAt, myRole: null, legacy: true, amendments: parseAmendments(d.amendments) });
    for (const g of legacyGrns) items.push({ kind: 'GRN', docId: g.id, projectId: g.projectId, projectName: g.project?.name, number: g.grnNumber, vendorName: g.vendorName, finalAmount: g.invoiceValue, basicAmount: g.invoiceValue, submittedAt: g.createdAt, myRole: null, legacy: true, invoiceNumber: g.invoiceNumber, invoicePdfUrl: g.invoicePdfUrl, amendments: parseAmendments(g.amendments) });
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
