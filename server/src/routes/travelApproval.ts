import { Router } from 'express';
import express from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { audit } from '../lib/audit';
import { appBaseUrl, sendEmail, isEmailEnabled } from '../services/email';
import { signApiPath } from '../lib/signedUrl';
import { modeOutsidePolicy } from '../lib/travelEntitlements';
import { upload } from '../middleware/upload';
import { notifyUser } from '../services/notify';
import { decideTravelStep, notifyCurrentTravelStep, decideExpenseStep, notifyCurrentExpenseStep, travelChainState } from '../services/travelChain';

// ── Public, no-login Travel "Approval Form" ──────────────────────────────────
// Mirrors the payment/invoice approval forms. Two flows share this route, keyed by
// the record's releaseToken:
//   • type=request → a TravelPlan (the travel request; e.g. Akash approves).
//   • type=expense → a TravelExpense (post-trip spend; Ops any-of → Akash).
// On the FINAL expense approval the traveller is notified + can download the PDF.
const router = Router();
router.use(express.urlencoded({ extended: false }));

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const rs = (n: unknown) => 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN');
const dmy = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB') : '—');

type Loaded =
  | { kind: 'request'; plan: any }
  | { kind: 'expense'; expense: any; plan: any };

async function loadByToken(token: string): Promise<Loaded | null> {
  const plan = await prisma.travelPlan.findFirst({ where: { releaseToken: token } });
  if (plan) return { kind: 'request', plan };
  const expense = await prisma.travelExpense.findFirst({ where: { releaseToken: token }, include: { plan: true } });
  if (expense) return { kind: 'expense', expense, plan: expense.plan };
  return null;
}

function badge(status: string | null): string {
  if (status === 'APPROVED') return '<span style="background:#dcfce7;color:#166534;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">✓ APPROVED</span>';
  if (status === 'ON_HOLD') return '<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">⏸ ON HOLD</span>';
  return '<span style="background:#f1f5f9;color:#64748b;padding:3px 10px;border-radius:999px;font-weight:600;font-size:13px">Pending decision</span>';
}

function page(data: Loaded, token: string, chain: Awaited<ReturnType<typeof travelChainState>>, notice?: string, step?: string | null): string {
  const type = data.kind;
  const plan = data.plan;
  const rec: any = type === 'request' ? plan : (data as any).expense;
  const title = type === 'request' ? `Travel Request · ${esc(plan.planNumber)}` : `Travel Expense · ${esc((data as any).expense.expenseNumber)}`;
  const decided = rec.releaseStatus === 'APPROVED' || rec.releaseStatus === 'ON_HOLD';
  const row = (k: string, v: string) => `<tr><td style="padding:7px 10px;color:#64748b;font-size:12px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:7px 10px;font-weight:600;color:#0f172a">${v}</td></tr>`;
  const win = `${dmy(plan.fromDate)} → ${dmy(plan.toDate)} · ${plan.days} day(s)`;

  let detail = '';
  if (type === 'request') {
    const meta = [plan.designation, plan.department].filter(Boolean).map(esc).join(' · ');
    // Out-of-entitlement mode (e.g. an M-13 picked Flight) — flag it loudly so the
    // approver consciously authorises the out-of-policy travel.
    const mp = modeOutsidePolicy(plan.mLevel, plan.travelMode);
    const modeWarnRow = mp?.outside
      ? `<tr><td colspan="2" style="padding:10px"><div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px 12px;color:#92400e;font-weight:700;font-size:13px">⚠ Mode of travel (${esc(plan.travelMode)}) is NOT in this traveller's entitlement — M-Level ${esc(plan.mLevel)}, Grade ${esc(mp.group)} allows only ${esc(mp.allowed.join(' / '))}. Approve only if this urgent / out-of-policy travel is authorised.</div></td></tr>`
      : '';
    const aadharVal = [plan.aadharNo ? `<strong>${esc(plan.aadharNo)}</strong>` : '', plan.aadharFileUrl ? `<a href="${appBaseUrl()}${esc(plan.aadharFileUrl)}" target="_blank" style="color:#052379;font-weight:600">📎 card</a>` : ''].filter(Boolean).join(' · ');
    detail = [
      row('Traveller', esc(plan.employeeName) + (plan.isNonCrystal ? ' <span style="color:#b45309">(Non-Crystal)</span>' : '') + (plan.mLevel ? ` · ${esc(plan.mLevel)}` : '') + (meta ? ` · ${meta}` : '')),
      plan.grade ? row('Grade / class', esc(plan.grade)) : '',
      plan.employeePhone ? row('Phone', esc(plan.employeePhone)) : '',
      aadharVal ? row('Aadhaar', aadharVal) : '',
      row('Route', [plan.origin, plan.destination].filter(Boolean).map(esc).join(' → ') || '—'),
      row('Dates', win),
      modeWarnRow,
      plan.travelMode ? row('Mode', esc(plan.travelMode) + (mp?.outside ? ' <span style="color:#b45309;font-weight:700">⚠ outside entitlement</span>' : '')) : '',
      plan.tripType ? row('Ticket for', plan.tripType === 'going' ? 'Going only' : plan.tripType === 'return' ? 'Return only' : 'Going + Return') : '',
      (() => { const urls: string[] = (Array.isArray(plan.requestedTicketUrls) && plan.requestedTicketUrls.length) ? plan.requestedTicketUrls : (plan.requestedTicketUrl ? [plan.requestedTicketUrl] : []); return urls.length ? row('Ticket(s) to book', urls.map((u, i) => `<a href="${appBaseUrl()}${esc(u)}" target="_blank" style="color:#052379;font-weight:600">📎 Ticket ${i + 1}</a>`).join(' &nbsp; ')) : ''; })(),
      plan.ticketPrice != null ? row('Ticket price', rs(plan.ticketPrice)) : '',
      plan.ticketFileUrl ? row('Booked ticket', `<a href="${appBaseUrl()}${esc(plan.ticketFileUrl)}" target="_blank" style="color:#052379;font-weight:600">📎 View ticket</a>`) : '',
      plan.paymentProofUrl ? row('Payment proof', `<a href="${appBaseUrl()}${esc(plan.paymentProofUrl)}" target="_blank" style="color:#052379;font-weight:600">📎 View</a>`) : '',
      row('Purpose', esc(plan.purpose) || '—'),
      plan.remarks ? row('Remarks', esc(plan.remarks)) : '',
      row('Advance requested', rs(plan.totalAdvance)),
    ].filter(Boolean).join('');
  } else {
    const exp = (data as any).expense;
    const items = (() => { try { return JSON.parse(exp.items || '[]'); } catch { return []; } })();
    const itemRows = items.map((it: any) => `<tr><td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${dmy(it.date)}</td><td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${esc(it.details)}</td><td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${esc(it.paymentMode)}</td><td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px">${it.supportingUrl ? `<a href="${appBaseUrl()}${esc(it.supportingUrl)}" target="_blank" style="color:#052379;font-weight:600">📎 View</a>` : (it.paymentMode === 'Cash' ? '<span style="color:#94a3b8">— cash</span>' : '<span style="color:#dc2626">missing</span>')}</td><td style="padding:6px 8px;border-top:1px solid #e2e8f0;font-size:12px;text-align:right;font-weight:700">${rs(it.amount)}</td></tr>`).join('');
    const itemsTable = `<div style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;margin-top:6px"><table style="width:100%;border-collapse:collapse"><tr style="background:#eef2f7"><th style="padding:6px 8px;text-align:left;font-size:11px;color:#64748b">DATE</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:#64748b">DETAILS</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:#64748b">MODE</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:#64748b">SUPPORT</th><th style="padding:6px 8px;text-align:right;font-size:11px;color:#64748b">AMOUNT</th></tr>${itemRows}</table></div>`;
    detail = [
      row('Traveller', esc(plan.employeeName) + (plan.mLevel ? ` · ${esc(plan.mLevel)}` : '')),
      row('Trip', esc(plan.planNumber) + ' · ' + win),
      row('Total claimed', `<strong style="font-size:15px">${rs(exp.totalAmount)}</strong>`),
      `<tr><td colspan="2" style="padding:10px">${itemsTable}</td></tr>`,
    ].join('');
  }

  const action = `/api/public/travel-approval/${esc(token)}/decide`;
  // This step's approver is flagged to BOOK & UPLOAD the ticket → show an upload
  // field on their form (request only). The uploaded ticket is saved against the trip.
  const curStep = (chain.steps as any[]).find((s) => s.status === 'PENDING' && s.uploadsTicket);
  const showUpload = type === 'request' && !!curStep;
  const fld = 'display:block;width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:7px;font-size:13px;margin-top:3px';
  const lbl = 'font-size:11px;font-weight:700;color:#334155;text-transform:uppercase;margin-top:10px;display:block';
  const uploadBlock = showUpload
    ? `<div style="margin:0 0 14px;padding:14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px">
         <div style="font-size:14px;font-weight:800;color:#1e3a8a">🎫 You book &amp; upload the ticket</div>
         <div style="font-size:12px;color:#334155;margin-top:4px">Attach the booked ticket + payment proof and tell us how you paid — it's saved against this trip and sent to ${esc(plan.employeeName)} on final approval.</div>
         <label style="${lbl}">Ticket price (Rs.)</label>
         <input type="number" name="ticketPrice" min="0" value="${plan.ticketPrice != null ? esc(plan.ticketPrice) : ''}" placeholder="Actual booked price" style="${fld}" />
         <label style="${lbl}">Ticket file (PDF/image) ${plan.ticketFileUrl ? `<a href="${appBaseUrl()}${esc(plan.ticketFileUrl)}" target="_blank" style="color:#052379">· current ↗</a>` : ''}</label>
         <input type="file" name="ticketFile" accept="image/*,.pdf" style="${fld}" />
         <label style="${lbl}">Payment proof (PDF/image) ${plan.paymentProofUrl ? `<a href="${appBaseUrl()}${esc(plan.paymentProofUrl)}" target="_blank" style="color:#052379">· current ↗</a>` : ''}</label>
         <input type="file" name="paymentProof" accept="image/*,.pdf" style="${fld}" />
         <label style="${lbl}">Paid by</label>
         <select name="paymentMethod" style="${fld}">
           <option value="">— Select —</option>
           <option value="Card"${plan.paymentMethod === 'Card' ? ' selected' : ''}>Card</option>
           <option value="Online"${plan.paymentMethod === 'Online' ? ' selected' : ''}>Online</option>
           <option value="Cash"${plan.paymentMethod === 'Cash' ? ' selected' : ''}>Cash</option>
         </select>
         <label style="${lbl}">Bank</label>
         <input type="text" name="paymentBank" list="banklist" value="${esc(plan.paymentBank || '')}" placeholder="e.g. SBI, HDFC" style="${fld}" />
         <datalist id="banklist"><option value="SBI"><option value="HDFC"><option value="ICICI"><option value="Axis"><option value="Kotak"><option value="PNB"><option value="Bank of Baroda"><option value="Yes Bank"></datalist>
       </div>`
    : '';
  const decisionForm = decided
    ? `<div style="margin-top:18px;padding:12px;background:#f8fafc;border-radius:8px;color:#334155">This ${type === 'request' ? 'request' : 'expense'} is already <strong>${esc(rec.releaseStatus)}</strong>${rec.releaseBy ? ` by ${esc(rec.releaseBy)}` : ''}${rec.releaseRemark ? ` — “${esc(rec.releaseRemark)}”` : ''}.</div>`
    : `<form method="post" action="${action}" ${showUpload ? 'enctype="multipart/form-data"' : ''} style="margin-top:18px">
        <input type="hidden" name="step" value="${esc(step || '')}" />
        ${uploadBlock}
        <label style="font-size:12px;color:#64748b;display:block;margin-bottom:4px">Comments (required to put On Hold)</label>
        <textarea name="remark" rows="2" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:14px"></textarea>
        <div style="margin-top:12px;display:flex;gap:10px">
          <button name="decision" value="APPROVED" style="background:#16a34a;color:#fff;border:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">✓ ${showUpload ? 'Upload &amp; Approve' : 'Approve'}</button>
          <button name="decision" value="ON_HOLD" style="background:#f59e0b;color:#fff;border:none;padding:11px 22px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">⏸ Put On Hold</button>
        </div>
      </form>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#1e293b">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="background:#052379;color:#fff;padding:18px 22px">
        <div style="font-size:12px;opacity:.85;letter-spacing:.04em">CRMCTS · TRAVEL ${type === 'request' ? 'REQUEST' : 'EXPENSE'}</div>
        <div style="font-size:20px;font-weight:800;margin-top:3px">${title}</div>
      </div>
      <div style="padding:22px">
        ${notice ? `<div style="margin-bottom:14px;padding:10px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;color:#065f46;font-weight:600">${esc(notice)}</div>` : ''}
        <div style="margin-bottom:10px">${badge(rec.releaseStatus)}</div>
        <table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">${detail}</table>
        ${decisionForm}
      </div>
      <div style="padding:12px 22px;background:#f8fafc;color:#94a3b8;font-size:11px;text-align:center">CRMCTS · Crystal Group</div>
    </div>
  </body></html>`;
}

router.get('/:token', asyncHandler(async (req, res) => {
  const data = await loadByToken(req.params.token);
  if (!data) { res.status(404).send('<p style="font-family:sans-serif;padding:40px;text-align:center">This travel approval link is invalid or expired.</p>'); return; }
  const chain = await travelChainState(data.kind === 'request' ? 'TRAVEL' : 'TRAVEL_EXPENSE', data.kind === 'request' ? data.plan.id : (data as any).expense.id);
  res.send(page(data, req.params.token, chain, undefined, String(req.query.step ?? '')));
}));

router.post('/:token/decide', upload.fields([{ name: 'ticketFile', maxCount: 1 }, { name: 'paymentProof', maxCount: 1 }]), asyncHandler(async (req, res) => {
  const data = await loadByToken(req.params.token);
  if (!data) { res.status(404).send('Invalid link'); return; }
  const decision = req.body.decision === 'ON_HOLD' ? 'ON_HOLD' : 'APPROVED';
  const remark: string | null = (req.body.remark || '').trim() || null;
  const linkStep = req.body.step ? parseInt(String(req.body.step), 10) : null;

  // The "ticket uploader" approver fills the booking details on their form (ticket
  // file + payment proof + price + how they paid + bank). Save it against the trip,
  // but ONLY while we're genuinely at that pending uploader step (guards a stale /
  // reopened link from writing late).
  if (data.kind === 'request') {
    const st = await travelChainState('TRAVEL', data.plan.id);
    const pendingOrders = st.steps.filter((s) => s.status === 'PENDING').map((s) => s.order);
    const atUploader = st.steps.some((s: any) => s.status === 'PENDING' && s.uploadsTicket) && (!linkStep || linkStep === Math.min(...pendingOrders));
    if (atUploader || st.steps.length === 0) {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const tf = files?.ticketFile?.[0];
      const pp = files?.paymentProof?.[0];
      const upd: any = {};
      if (tf) upd.ticketFileUrl = `/uploads/${tf.filename}`;
      if (pp) upd.paymentProofUrl = `/uploads/${pp.filename}`;
      if (req.body.ticketPrice !== undefined && String(req.body.ticketPrice).trim() !== '') upd.ticketPrice = Number(req.body.ticketPrice) || 0;
      if (req.body.paymentMethod) upd.paymentMethod = String(req.body.paymentMethod);
      if (req.body.paymentBank) upd.paymentBank = String(req.body.paymentBank).trim();
      if (Object.keys(upd).length) { upd.ticketBookedBy = (st.steps.find((s: any) => s.status === 'PENDING' && s.uploadsTicket)?.name) || null; await prisma.travelPlan.update({ where: { id: data.plan.id }, data: upd }); }
    }
  }
  if (decision === 'ON_HOLD' && !remark) {
    const chain = await travelChainState(data.kind === 'request' ? 'TRAVEL' : 'TRAVEL_EXPENSE', data.kind === 'request' ? data.plan.id : (data as any).expense.id);
    res.send(page(data, req.params.token, chain, 'Please add a comment to put it On Hold.', String(linkStep ?? '')));
    return;
  }

  let notice = '';
  if (data.kind === 'request') {
    const outcome = await decideTravelStep(data.plan.id, decision, null, remark, linkStep);
    if (outcome === 'STALE') notice = 'This step was already decided.';
    else if (decision === 'ON_HOLD') notice = 'Travel request put On Hold — sent back to the requester.';
    else if (outcome === 'ADVANCED') { const p = await prisma.travelPlan.findUnique({ where: { id: data.plan.id } }); if (p) await notifyCurrentTravelStep(p as any); notice = 'Approved — forwarded to the next approver.'; }
    else { notice = 'Travel request approved — the traveller has been notified.'; await notifyEmployeeRequestApproved(data.plan.id); }
    await audit({ userId: '', action: 'TRAVEL_DECISION', entity: 'TravelPlan', entityId: data.plan.id, details: { decision, remark } });
  } else {
    const exp = (data as any).expense;
    const outcome = await decideExpenseStep(exp.id, decision, null, remark, linkStep);
    if (outcome === 'STALE') notice = 'This step was already decided.';
    else if (decision === 'ON_HOLD') notice = 'Expense put On Hold — sent back to the employee.';
    else if (outcome === 'ADVANCED') { const e = await prisma.travelExpense.findUnique({ where: { id: exp.id }, include: { plan: true } }); if (e) await notifyCurrentExpenseStep(e as any, e.plan as any); notice = 'Approved — forwarded to the next approver.'; }
    else { notice = 'Expense fully approved — the employee has been notified.'; await notifyEmployeeExpenseApproved(exp.id); }
    await audit({ userId: '', action: 'TRAVEL_EXPENSE_DECISION', entity: 'TravelExpense', entityId: exp.id, details: { decision, remark } });
  }

  // After a decision, show a confirmation ONLY — never re-render an action form
  // (that would wrongly surface the NEXT approver's form/upload to the person who
  // just acted). The next approver gets their own emailed link.
  const heading = data.kind === 'request' ? `Travel Request · ${esc(data.plan.planNumber)}` : `Travel Expense · ${esc((data as any).expense.expenseNumber)}`;
  const hold = decision === 'ON_HOLD';
  res.send(confirmationPage(heading, notice, hold));
}));

// A no-form "your decision is recorded" page shown after Approve / Hold.
function confirmationPage(heading: string, notice: string, hold: boolean): string {
  const accent = hold ? '#f59e0b' : '#16a34a';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#1e293b">
    <div style="max-width:520px;margin:40px auto 0;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="background:${accent};color:#fff;padding:20px 22px;text-align:center">
        <div style="font-size:34px;line-height:1">${hold ? '⏸' : '✓'}</div>
        <div style="font-size:18px;font-weight:800;margin-top:6px">${hold ? 'Put On Hold' : 'Decision recorded'}</div>
      </div>
      <div style="padding:24px;text-align:center">
        <div style="font-size:12px;color:#94a3b8;letter-spacing:.04em">${heading}</div>
        <p style="font-size:15px;color:#334155;margin:12px 0 0">${esc(notice)}</p>
        <p style="font-size:12px;color:#94a3b8;margin-top:18px">You can close this window.</p>
      </div>
      <div style="padding:12px 22px;background:#f8fafc;color:#94a3b8;font-size:11px;text-align:center">CRMCTS · Crystal Group</div>
    </div>
  </body></html>`;
}

// The traveller's "your expense is approved" notification + PDF download link.
async function notifyEmployeeExpenseApproved(expId: string) {
  const exp = await prisma.travelExpense.findUnique({ where: { id: expId }, include: { plan: true } });
  if (!exp) return;
  const p = exp.plan;
  // Signed so the emailed link opens without a login (authMiddleware unlocks a
  // signed GET path ending in /pdf).
  const pdf = appBaseUrl() + signApiPath(`/api/travel/expenses/${exp.id}/pdf`);
  if (p.employeeId) {
    await notifyUser(p.employeeId, { type: 'TRAVEL_EXPENSE_APPROVED', title: 'Travel expense approved', message: `Your travel expense ${exp.expenseNumber} (${rs(exp.totalAmount)}) has been approved.`, link: '/travel' });
  }
  if (isEmailEnabled() && p.employeeEmail) {
    const html = `<p>Hi ${esc(p.employeeName)},</p><p>Your travel expense <strong>${esc(exp.expenseNumber)}</strong> for trip <strong>${esc(p.planNumber)}</strong> (total <strong>${rs(exp.totalAmount)}</strong>) has been <strong style="color:#16a34a">approved</strong>.</p><p><a href="${pdf}" style="background:#052379;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Download approval PDF</a></p>`;
    try { await sendEmail({ to: p.employeeEmail, subject: `Travel expense approved — ${exp.expenseNumber}`, html }); } catch { /* best-effort */ }
  }
}

// The traveller's "your ticket / travel request has been approved" notification —
// fires automatically once the request clears the whole approval chain. Carries the
// trip details (route, dates, mode, ticket) so the traveller can act on it.
async function notifyEmployeeRequestApproved(planId: string) {
  const p = await prisma.travelPlan.findUnique({ where: { id: planId } });
  if (!p) return;
  if (p.employeeId) {
    await notifyUser(p.employeeId, { type: 'TRAVEL_REQUEST_APPROVED', title: 'Travel request approved', message: `Your travel request ${p.planNumber}${p.destination ? ` to ${p.destination}` : ''} has been approved.`, link: '/travel' });
  }
  if (isEmailEnabled() && p.employeeEmail) {
    const route = [p.origin, p.destination].filter(Boolean).map(esc).join(' → ') || '—';
    const win = `${dmy(p.fromDate)} → ${dmy(p.toDate)}${p.days ? ` · ${p.days} day(s)` : ''}`;
    const rowH = (k: string, v: string) => `<tr><td style="padding:4px 0;color:#64748b;font-size:13px;width:120px">${k}</td><td style="padding:4px 0;font-size:14px;font-weight:600;color:#0f172a">${v}</td></tr>`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
        <div style="background:#16a34a;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
          <div style="font-size:12px;opacity:.85;letter-spacing:.04em">TRAVEL REQUEST · ${esc(p.planNumber)}</div>
          <div style="font-size:19px;font-weight:700;margin-top:3px">✓ Your ticket has been approved</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:20px">
          <p style="margin:0 0 14px;font-size:14px">Hi ${esc(p.employeeName)}, your travel request has been <b style="color:#16a34a">approved</b>. Details below:</p>
          <table style="width:100%;border-collapse:collapse">
            ${rowH('Route', route)}
            ${rowH('Dates', win)}
            ${p.travelMode ? rowH('Mode', esc(p.travelMode)) : ''}
            ${p.ticketPrice != null ? rowH('Ticket price', rs(p.ticketPrice)) : ''}
            ${p.mLevel ? rowH('M-Level', esc(p.mLevel)) : ''}
            ${p.purpose ? rowH('Purpose', esc(p.purpose)) : ''}
          </table>
          ${p.ticketFileUrl ? `<p style="margin:14px 0 0"><a href="${appBaseUrl()}${esc(p.ticketFileUrl)}" style="color:#052379;font-weight:600">📎 View ticket</a></p>` : ''}
        </div>
      </div>`;
    try { await sendEmail({ to: p.employeeEmail, subject: `Travel request approved — ${p.planNumber}`, html }); } catch { /* best-effort */ }
  }
}

export default router;
