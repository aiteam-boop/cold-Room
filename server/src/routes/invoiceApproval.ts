import { Router } from 'express';
import express from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { audit } from '../lib/audit';
import { appBaseUrl } from '../services/email';
import { signApiPath } from '../lib/signedUrl';
import { decideInvoiceStep, notifyCurrentInvoiceStep } from '../services/invoiceChain';

// ── Public, no-login TAX-INVOICE "Approval Form" ───────────────────────────────
// Mirrors the payment-release Approval Form (paymentApproval.ts), but for the tax
// invoice: once uploaded, "Submit Invoice for Approval" mails the SAME payment
// approvers a no-login page to review the Invoice / PO / PI / KYC and mark it
// APPROVED or ON HOLD. The page also shows the payment's own status + UTR for
// reference. Keyed by invoiceReleaseToken; runs alongside the payment release.
const router = Router();
router.use(express.urlencoded({ extended: false }));

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const rs = (n: unknown) => 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN');
const dmy = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB') : '—');

async function loadByToken(token: string) {
  const gr = await prisma.gRN.findFirst({ where: { invoiceReleaseToken: token } });
  if (!gr) return null;
  const doc = await prisma.procurementDoc.findUnique({ where: { id: gr.docId }, select: { docNumber: true, vendorId: true, vendorName: true, finalAmount: true } });
  const project = await prisma.project.findUnique({ where: { id: gr.projectId }, select: { name: true } });
  const vendorId = doc?.vendorId ?? null;
  let vendorEmail = '';
  let kycCount = 0;
  if (vendorId) {
    const v = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { email: true } });
    vendorEmail = v?.email ?? '';
    kycCount = await prisma.procurementDocument.count({ where: { vendorId, type: 'KYC' } });
  }
  return { gr, doc, project, vendorId, vendorEmail, kycCount };
}

function statusBadge(status: string | null): string {
  if (status === 'APPROVED') return '<span style="background:#dcfce7;color:#166534;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">✓ APPROVED</span>';
  if (status === 'ON_HOLD') return '<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">⏸ ON HOLD</span>';
  return '<span style="background:#f1f5f9;color:#64748b;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px">Pending decision</span>';
}

function page(data: NonNullable<Awaited<ReturnType<typeof loadByToken>>>, token: string, notice?: string, edit = false, step?: string | null): string {
  const { gr, doc, project, vendorId, vendorEmail, kycCount } = data;
  const base = appBaseUrl();
  const poPdf = base + signApiPath(`/api/projects/${gr.projectId}/procurement/docs/${gr.docId}/pdf`) + '&approvals=1';
  const grnPdf = base + signApiPath(`/api/projects/${gr.projectId}/procurement/grns/${gr.id}/pdf`);
  const kycUrl = vendorId && kycCount ? base + signApiPath(`/api/vendors/${vendorId}/kyc-view`) : null;
  const piUrl = gr.piPdfUrl ? (gr.piPdfUrl.startsWith('/api/') ? base + signApiPath(gr.piPdfUrl) : base + gr.piPdfUrl) : null;
  // The tax invoice — the whole point of this page. /uploads/* is public; a signed
  // /api/* link if it ever moves there.
  const invUrl = gr.invoicePdfUrl ? (gr.invoicePdfUrl.startsWith('/api/') ? base + signApiPath(gr.invoicePdfUrl) : base + gr.invoicePdfUrl) : null;
  const row = (k: string, v: string) => `<tr><td style="padding:7px 10px;color:#64748b;font-size:12px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:7px 10px;font-weight:600;color:#0f172a">${v}</td></tr>`;
  const link = (label: string, url: string | null) => (url ? `<a href="${url}" target="_blank" rel="noopener" class="doclink" data-title="${esc(label)}" style="color:#052379;font-weight:600;text-decoration:none">📄 ${label}</a>` : '<span style="color:#94a3b8">—</span>');
  const action = `/api/public/invoice-approval/${esc(token)}/decide`;
  // The payment's own approval status, shown here for the invoice approver's context.
  const payBadge = gr.releaseStatus === 'APPROVED' ? '<span style="color:#16a34a;font-weight:700">✓ Payment approved</span>'
    : gr.releaseStatus === 'ON_HOLD' ? '<span style="color:#d97706;font-weight:700">⏸ Payment on hold</span>'
    : '<span style="color:#64748b">Payment decision pending</span>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice Approval — ${esc(gr.grnNumber)}</title></head>
<body style="margin:0;background:#f1f5f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <div style="max-width:640px;margin:0 auto;padding:20px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div><span style="font-size:20px;font-weight:800;color:#052379">Crystal</span> <span style="font-size:12px;color:#94a3b8">Invoice Approval</span></div>
      ${statusBadge(gr.invoiceReleaseStatus)}
    </div>
    ${notice ? `<div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;padding:10px 14px;border-radius:10px;margin-bottom:14px;font-weight:600">${esc(notice)}</div>` : ''}
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">
      <div style="background:#052379;color:#fff;padding:12px 16px;font-weight:700;font-size:15px">Tax Invoice · ${esc(gr.grnNumber)} · ${esc(doc?.docNumber ?? '')}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${row('Project', esc(project?.name ?? '—'))}
        ${row('PO / WO Number', esc(doc?.docNumber ?? '—'))}
        ${row('Payment No. (GRN)', esc(gr.grnNumber))}
        ${row('Vendor', esc(gr.vendorName ?? doc?.vendorName ?? '—'))}
        ${row('Vendor Email', vendorEmail ? esc(vendorEmail) : '<span style="color:#94a3b8">—</span>')}
        ${row('Invoice Number', esc(gr.invoiceNumber ?? '—'))}
        ${row('Invoice Value', gr.invoiceValue != null ? rs(gr.invoiceValue) : '—')}
        ${row('Invoice Date', dmy(gr.invoiceDate))}
        ${row('PO Total', doc?.finalAmount != null ? rs(doc.finalAmount) : '—')}
        ${row('Payment Status', `${esc(gr.paymentStatus ?? '—')} · ${payBadge}`)}
        ${row('UTR / Payment Ref', gr.utrNumber ? `${esc(gr.utrNumber)}${gr.paidAt ? ` · ${dmy(gr.paidAt)}` : ''}` : '<span style="color:#94a3b8">—</span>')}
        ${row('Documents', `${link('Invoice', invUrl)} &nbsp; ${link('PO', poPdf)} &nbsp; ${link('PI', piUrl)} &nbsp; ${link('Payment / GRN', grnPdf)} &nbsp; ${link(`KYC (${kycCount})`, kycUrl)}`)}
        ${(gr.invoiceReleaseStatus === 'APPROVED' || gr.invoiceReleaseStatus === 'ON_HOLD') ? row('Current Decision', `${statusBadge(gr.invoiceReleaseStatus)}${gr.invoiceReleaseBy ? ` · by ${esc(gr.invoiceReleaseBy)}` : ''}${gr.invoiceReleaseAt ? ` · ${dmy(gr.invoiceReleaseAt)}` : ''}`) : ''}
      </table>
    </div>

    ${(gr.invoiceReleaseStatus === 'APPROVED' || gr.invoiceReleaseStatus === 'ON_HOLD') && !edit ? `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-top:14px">
      <div style="font-weight:700;margin-bottom:8px">Decision recorded</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${statusBadge(gr.invoiceReleaseStatus)}${gr.invoiceReleaseBy ? `<span style="color:#475569;font-size:13px">by ${esc(gr.invoiceReleaseBy)}</span>` : ''}${gr.invoiceReleaseAt ? `<span style="color:#94a3b8;font-size:13px">· ${dmy(gr.invoiceReleaseAt)}</span>` : ''}</div>
      ${gr.invoiceReleaseRemark ? `<div style="margin-top:8px;color:#475569;font-size:13px">Remark: ${esc(gr.invoiceReleaseRemark)}</div>` : ''}
      <div style="margin-top:14px"><a href="/api/public/invoice-approval/${esc(token)}?edit=1" style="color:#052379;font-weight:600;font-size:13px;text-decoration:none">✎ Change decision</a></div>
      <div style="font-size:11px;color:#94a3b8;margin-top:10px">This records a management decision on the tax invoice. It shows next to the payment in CRMCTS. It does not itself release funds.</div>
    </div>
    ` : `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:16px;margin-top:14px">
      <div style="font-weight:700;margin-bottom:10px">Your decision</div>
      <form method="POST" action="${action}">
        <input type="hidden" name="step" value="${step ? esc(String(step)) : ''}" />
        <label style="display:block;font-size:12px;color:#64748b;margin-bottom:4px">Your email (optional — recorded as who made this decision)</label>
        <input name="by" type="email" value="${edit ? esc(gr.invoiceReleaseBy ?? '') : ''}" placeholder="e.g. accounts@crystalgroup.in" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:10px;font-size:14px" />
        <label style="display:block;font-size:12px;color:#64748b;margin-bottom:4px">Remark (optional — required when putting on hold; say what needs correcting)</label>
        <textarea name="remark" rows="3" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:14px;font-size:14px;font-family:inherit;line-height:1.4;min-height:70px;resize:vertical">${edit ? esc(gr.invoiceReleaseRemark ?? '') : ''}</textarea>
        <div style="display:flex;gap:10px">
          <button type="submit" name="decision" value="APPROVED" style="flex:1;background:#16a34a;color:#fff;border:0;padding:12px;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer">✓ Approve</button>
          <button type="submit" name="decision" value="ON_HOLD" style="flex:1;background:#d97706;color:#fff;border:0;padding:12px;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer">⏸ On Hold</button>
        </div>
      </form>
      <div style="font-size:11px;color:#94a3b8;margin-top:10px">This records a management decision on the tax invoice. It shows next to the payment in CRMCTS. It does not itself release funds.</div>
    </div>`}
  </div>

  <!-- In-page document viewer (opens Invoice / PO / PI / GRN / KYC in a popup) -->
  <div id="docModal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.55);padding:16px;box-sizing:border-box">
    <div style="max-width:960px;height:90vh;margin:0 auto;display:flex;flex-direction:column;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:center;gap:12px;border-bottom:1px solid #e2e8f0;padding:10px 14px;flex-shrink:0">
        <div id="docModalTitle" style="flex:1;font-weight:700;color:#052379;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Document</div>
        <a id="docModalDownload" href="#" download style="border:1px solid #cbd5e1;border-radius:8px;padding:5px 12px;font-size:12px;color:#052379;text-decoration:none;font-weight:700;white-space:nowrap">⬇ Download</a>
        <button type="button" id="docModalClose" style="border:none;background:#f1f5f9;border-radius:8px;width:30px;height:30px;font-size:16px;color:#475569;cursor:pointer;line-height:1">✕</button>
      </div>
      <div id="docModalBody" style="flex:1;min-height:0;background:#f1f5f9"></div>
    </div>
  </div>
  <script>
    (function () {
      var modal = document.getElementById('docModal');
      var body = document.getElementById('docModalBody');
      var titleEl = document.getElementById('docModalTitle');
      var dl = document.getElementById('docModalDownload');
      function isImage(u) { return /\\.(png|jpe?g|gif|webp|bmp|svg)(\\?|$)/i.test(u); }
      function open(url, title) {
        titleEl.textContent = title || 'Document';
        dl.setAttribute('href', url);
        body.innerHTML = isImage(url)
          ? '<div style="width:100%;height:100%;overflow:auto;display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box"><img src="' + url + '" style="max-width:100%;max-height:100%;object-fit:contain" /></div>'
          : '<iframe src="' + url + '" style="width:100%;height:100%;border:0;background:#fff"></iframe>';
        modal.style.display = 'block';
      }
      function close() { modal.style.display = 'none'; body.innerHTML = ''; }
      var links = document.querySelectorAll('a.doclink');
      for (var i = 0; i < links.length; i++) {
        links[i].addEventListener('click', function (e) {
          e.preventDefault();
          open(this.getAttribute('href'), this.getAttribute('data-title'));
        });
      }
      document.getElementById('docModalClose').addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    })();
  </script>
</body></html>`;
}

// GET /:token — the invoice approval page (opened from the email link).
router.get('/:token', asyncHandler(async (req, res) => {
  const data = await loadByToken(req.params.token);
  if (!data) { res.status(404).type('html').send('<div style="font-family:system-ui;padding:40px;text-align:center"><h2>🔒 Link not valid</h2><p>This invoice-approval link is invalid or has expired.</p></div>'); return; }
  res.type('html').send(page(data, req.params.token, undefined, req.query.edit === '1', typeof req.query.step === 'string' ? req.query.step : null));
}));

// POST /:token/decide — record the decision on the CURRENT step of the invoice chain.
router.post('/:token/decide', asyncHandler(async (req, res) => {
  const decision = String((req.body?.decision ?? '')).toUpperCase();
  if (decision !== 'APPROVED' && decision !== 'ON_HOLD') { res.status(400).type('html').send('Invalid decision.'); return; }
  const by = String(req.body?.by ?? '').trim().slice(0, 120) || null;
  const remark = String(req.body?.remark ?? '').trim().slice(0, 500) || null;
  const linkStep = Number(req.body?.step) || null;
  const gr = await prisma.gRN.findFirst({ where: { invoiceReleaseToken: req.params.token } });
  if (!gr) { res.status(404).type('html').send('Link not valid.'); return; }

  const outcome = await decideInvoiceStep(gr.id, decision as 'APPROVED' | 'ON_HOLD', by, remark, linkStep);
  await audit({ projectId: gr.projectId, action: 'INVOICE_RELEASE_DECISION', entity: 'GRN', entityId: gr.id, details: { grnNumber: gr.grnNumber, decision, by, outcome, via: 'invoice-approval-link' } });

  // Final invoice approval CLOSES the payment entry (paid + invoice verified). Only
  // a paid payment closes — an unpaid one stays open until it is paid.
  if (outcome === 'COMPLETED' && gr.paymentStatus === 'PAID') {
    await prisma.gRN.update({ where: { id: gr.id }, data: { paymentStatus: 'CLOSED', paymentClosedAt: new Date() } });
    await audit({ projectId: gr.projectId, action: 'GRN_PAYMENT_CLOSE', entity: 'GRN', entityId: gr.id, details: { grnNumber: gr.grnNumber, via: 'invoice-approved' } });
  }

  const data = await loadByToken(req.params.token);
  if (outcome === 'STALE') {
    res.type('html').send(page(data!, req.params.token, 'This step has already been approved by someone on it — nothing more is needed from you.'));
    return;
  }
  if (outcome === 'ADVANCED') {
    const fresh = await prisma.gRN.findFirst({ where: { id: gr.id } });
    if (fresh) await notifyCurrentInvoiceStep(fresh);
    res.type('html').send(page(data!, req.params.token, 'Approved — thank you. The invoice now moves to the next approver in the chain.'));
    return;
  }
  res.type('html').send(page(data!, req.params.token, `Recorded: ${decision === 'APPROVED' ? 'Approved' : 'On Hold'}. Thank you.`));
}));

export default router;
