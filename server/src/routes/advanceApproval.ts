import { Router } from 'express';
import express from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { audit } from '../lib/audit';
import { decideAdvanceStep, advanceChainState } from '../services/advanceChain';

// ── Public, no-login "Advance Approval Form" ─────────────────────────────────
// Mirrors the Travel approval form but for a raised advance (PettyCashEntry,
// docType 'ADVANCE'). The current approver opens it from their emailed link and
// Approves / puts On Hold. On the final approval the advance becomes active.
const router = Router();
router.use(express.urlencoded({ extended: false }));

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const rs = (n: unknown) => 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN');
const dmy = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB') : '—');

function badge(status: string | null): string {
  if (status === 'APPROVED') return '<span style="background:#dcfce7;color:#166534;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">✓ APPROVED</span>';
  if (status === 'ON_HOLD') return '<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">⏸ ON HOLD</span>';
  return '<span style="background:#f1f5f9;color:#64748b;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px">Pending decision</span>';
}

function page(adv: any, projectName: string | null, chain: Awaited<ReturnType<typeof advanceChainState>>, notice?: string, step?: string | null): string {
  const title = `Advance · ${esc(adv.entryNumber)}`;
  const decided = adv.approvalStatus === 'APPROVED' || adv.approvalStatus === 'ON_HOLD';
  const row = (k: string, v: string) => `<tr><td style="padding:7px 10px;color:#64748b;font-size:12px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:7px 10px;font-weight:600;color:#0f172a">${v}</td></tr>`;
  const detail = [
    row('For', esc(adv.technician || '—')),
    row('Amount', `<strong>${rs(adv.amount)}</strong>`),
    projectName ? row('Site / Project', esc(projectName)) : '',
    adv.description ? row('Note', esc(adv.description)) : '',
    adv.recordedByName ? row('Raised by', esc(adv.recordedByName)) : '',
    row('Date', dmy(adv.date)),
  ].join('');

  const chainRows = chain.steps.map((s) => {
    const st = s.status === 'APPROVED' || s.status === 'SKIPPED' ? '✓' : s.status === 'ON_HOLD' ? '⏸' : s.status === 'PENDING' ? '⋯' : '·';
    return `<div style="font-size:12px;color:#64748b;padding:2px 0">${st} ${esc(s.name)}${s.role ? ` <span style="color:#94a3b8">(${esc(s.role)})</span>` : ''} — ${esc(s.status)}</div>`;
  }).join('');

  const action = `${''}/api/public/advance-approval/${esc(adv.approvalToken)}/decide`;
  const decisionForm = decided
    ? `<div style="margin-top:16px;color:#64748b;font-size:13px">This advance has already been decided.</div>`
    : `<form method="post" action="${action}" style="margin-top:18px">
        <input type="hidden" name="step" value="${esc(step || '')}" />
        <label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px">Comments (required to put On Hold)</label>
        <textarea name="remark" rows="2" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:14px"></textarea>
        <div style="margin-top:12px;display:flex;gap:10px">
          <button name="decision" value="APPROVED" style="background:#16a34a;color:#fff;border:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">✓ Approve</button>
          <button name="decision" value="ON_HOLD" style="background:#f59e0b;color:#fff;border:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">⏸ Put On Hold</button>
        </div>
      </form>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#1e293b">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="background:#052379;color:#fff;padding:18px 22px">
        <div style="font-size:12px;opacity:.85;letter-spacing:.04em">CRMCTS · ADVANCE</div>
        <div style="font-size:20px;font-weight:800;margin-top:3px">${title}</div>
      </div>
      <div style="padding:22px">
        ${notice ? `<div style="margin-bottom:14px;padding:10px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;color:#065f46;font-weight:600">${esc(notice)}</div>` : ''}
        <div style="margin-bottom:10px">${badge(adv.approvalStatus)}</div>
        <table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">${detail}</table>
        ${chainRows ? `<div style="margin-top:14px"><div style="font-size:11px;text-transform:uppercase;color:#94a3b8;margin-bottom:4px">Approval chain</div>${chainRows}</div>` : ''}
        ${decisionForm}
      </div>
      <div style="padding:12px 22px;background:#f8fafc;color:#94a3b8;font-size:11px;text-align:center">CRMCTS · Crystal Group</div>
    </div>
  </body></html>`;
}

async function loadByToken(token: string) {
  const adv = await prisma.pettyCashEntry.findFirst({ where: { approvalToken: token } });
  if (!adv) return null;
  let projectName: string | null = null;
  if (adv.projectId) { const p = await prisma.project.findUnique({ where: { id: adv.projectId }, select: { name: true } }); projectName = p?.name ?? null; }
  return { adv, projectName };
}

router.get('/:token', asyncHandler(async (req, res) => {
  const data = await loadByToken(req.params.token);
  if (!data) { res.status(404).send('<p style="font-family:sans-serif;padding:40px;text-align:center">This advance approval link is invalid or expired.</p>'); return; }
  const chain = await advanceChainState(data.adv.id);
  res.send(page(data.adv, data.projectName, chain, undefined, String(req.query.step ?? '')));
}));

router.post('/:token/decide', asyncHandler(async (req, res) => {
  const data = await loadByToken(req.params.token);
  if (!data) { res.status(404).send('Invalid link'); return; }
  const decision = req.body.decision === 'ON_HOLD' ? 'ON_HOLD' : 'APPROVED';
  const remark: string | null = (req.body.remark || '').trim() || null;
  const linkStep = req.body.step ? parseInt(String(req.body.step), 10) : null;

  if (decision === 'ON_HOLD' && !remark) {
    const chain = await advanceChainState(data.adv.id);
    res.send(page(data.adv, data.projectName, chain, 'Please add a comment to put it On Hold.', String(linkStep ?? '')));
    return;
  }

  const outcome = await decideAdvanceStep(data.adv.id, decision, null, remark, linkStep);
  let notice = '';
  if (outcome === 'STALE') notice = 'This step was already decided.';
  else if (decision === 'ON_HOLD') notice = 'Advance put On Hold — sent back to the raiser.';
  else if (outcome === 'ADVANCED') notice = 'Approved — forwarded to the next approver.';
  else notice = 'Advance fully approved — it is now active.';
  await audit({ userId: '', action: 'ADVANCE_DECISION', entity: 'PettyCashEntry', entityId: data.adv.id, details: { decision, remark } });

  res.send(confirmationPage(`Advance · ${esc(data.adv.entryNumber)}`, notice, decision === 'ON_HOLD'));
}));

function confirmationPage(heading: string, notice: string, hold: boolean): string {
  const accent = hold ? '#f59e0b' : '#16a34a';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#1e293b">
    <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center">
      <div style="background:${accent};color:#fff;padding:22px;font-size:34px">${hold ? '⏸' : '✓'}</div>
      <div style="padding:24px">
        <div style="font-size:18px;font-weight:800;color:#0f172a">${esc(heading)}</div>
        <div style="margin-top:10px;color:#475569;font-size:14px">${esc(notice)}</div>
        <div style="margin-top:16px;color:#94a3b8;font-size:12px">You can close this window.</div>
      </div>
    </div>
  </body></html>`;
}

export default router;
