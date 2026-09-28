import { Router } from 'express';
import express from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { audit } from '../lib/audit';
import { notifyEmployeeTechApproved } from '../services/travelChain';

// ── Public, no-login "Final Approval Form" (Travel tech entry, Stage 3 / Sir) ──
// The Stage-3 approver opens this from their emailed link and gives the FINAL
// approval on a trip's expenses WITHOUT logging in — mirroring the Advance /
// Payment / Travel approval forms. It shows the advance the traveller holds, the
// per-category stage breakdown (Submitted → Reviewer → Final), the day-wise
// actual spend, and lets them Approve (with a per-category override) or Reject.
// It never touches the in-app Stage 1/2 review or any other flow.
const router = Router();
router.use(express.urlencoded({ extended: false }));

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const rs = (n: unknown) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const dmy = (d: unknown) => (d ? new Date(d as string).toLocaleDateString('en-GB') : '—');
const num = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));

const CATS = ['travel', 'food', 'hotel', 'other', 'misc'] as const;
const CAT_LABEL: Record<string, string> = { travel: 'Travel', food: 'Food', hotel: 'Hotel', other: 'Other', misc: 'Misc' };
type Cats = { travel: number; food: number; hotel: number; other: number; misc: number };
const zero: Cats = { travel: 0, food: 0, hotel: 0, other: 0, misc: 0 };
const grand = (c: Cats) => CATS.reduce((s, k) => s + (Number(c[k]) || 0), 0);
function parseJson<T>(s: string | null | undefined, fb: T): T { try { return s ? (JSON.parse(s) as T) : fb; } catch { return fb; } }
// The tech's raw day row maps bus+auto → Travel (same as the in-app grid).
const dayCats = (d: any): Cats => ({ travel: (Number(d?.bus) || 0) + (Number(d?.auto) || 0), food: Number(d?.food) || 0, hotel: Number(d?.hotel) || 0, other: Number(d?.other) || 0, misc: Number(d?.misc) || 0 });
const sumDays = (rows: any[]): Cats => rows.reduce((a, d) => { const c = dayCats(d); return { travel: a.travel + c.travel, food: a.food + c.food, hotel: a.hotel + c.hotel, other: a.other + c.other, misc: a.misc + c.misc }; }, { ...zero });

function badge(status: string | null): string {
  if (status === 'APPROVED') return '<span style="background:#dcfce7;color:#166534;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">✓ APPROVED</span>';
  if (status === 'REJECTED') return '<span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">✗ REJECTED</span>';
  return '<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px">Awaiting final approval</span>';
}

// The traveller's ACTIVE New-Advance balance (same rule as /travel/person-advance).
async function raisedAdvanceTotal(employeeId: string | null): Promise<number> {
  if (!employeeId) return 0;
  const rows = await prisma.pettyCashEntry.findMany({ where: { personId: employeeId, category: 'Advance to Technician' } });
  const active = rows.filter((r) => !['VOID', 'REJECTED', 'PENDING_APPROVAL'].includes(r.status));
  return active.reduce((s, r) => s + (Number(r.sanctionedAmount ?? r.amount) || 0), 0);
}

async function loadByToken(token: string) {
  const plan = await prisma.travelPlan.findFirst({ where: { techApprovalToken: token } });
  if (!plan) return null;
  let projectName: string | null = null;
  if (plan.projectId) { const p = await prisma.project.findUnique({ where: { id: plan.projectId }, select: { name: true } }); projectName = p?.name ?? null; }
  const cfg = await prisma.travelConfig.findFirst({ where: { projectId: null } });
  const raised = await raisedAdvanceTotal(plan.employeeId);
  return { plan, projectName, cfg, raised };
}

function page(ctx: Awaited<ReturnType<typeof loadByToken>>, notice?: string): string {
  const { plan, projectName, raised } = ctx!;
  const title = `Final approval · ${esc(plan.planNumber)}`;
  const s1 = parseJson<any>(plan.techStage1, null);
  const s2 = parseJson<any>(plan.techStage2, null);
  const s3 = parseJson<any>(plan.techStage3, null);
  const submitted = sumDays(parseJson<any[]>(plan.actualDayCosts, []));
  const s1t: Cats = { ...zero, ...(s1?.totals || {}) };
  const s2t: Cats = { ...zero, ...(s2?.totals || {}) };
  // Prefill the Final-approval inputs from the latest signed stage (Final).
  const pre: Cats = { ...zero, ...((s2?.totals) || (s1?.totals) || submitted) };
  const decided = plan.techEntryStatus === 'APPROVED' || plan.techEntryStatus === 'REJECTED' || (s3 && s3.status);
  const editable = !decided; // form is live → breakdown amounts are click-to-fill

  const planAdv = Number(plan.totalAdvance) || 0;
  const advReceived = planAdv + raised;

  const row = (k: string, v: string) => `<tr><td style="padding:7px 10px;color:#64748b;font-size:12px;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:7px 10px;font-weight:600;color:#0f172a">${v}</td></tr>`;
  const win = `${dmy(plan.fromDate)} → ${dmy(plan.toDate)}${plan.days ? ` · ${plan.days} day(s)` : ''}`;
  const advVal = raised > 0 ? `<strong>${rs(advReceived)}</strong> <span style="color:#94a3b8;font-weight:500">(Plan ${rs(planAdv)} + New Advance ${rs(raised)})</span>` : `<strong>${rs(advReceived)}</strong>`;
  const detail = [
    row('Traveller', `${esc(plan.employeeName)}${plan.mLevel ? ` · ${esc(plan.mLevel)}` : ''}`),
    plan.destination ? row('Destination', esc(plan.destination)) : '',
    row('Dates', win),
    projectName ? row('Site / Project', esc(projectName)) : '',
    row('Advance received', advVal),
    row('Actual claimed', rs(grand(submitted))),
  ].join('');

  // ── Stage breakdown · per category ── (each amount is click-to-fill when live)
  const th = (t: string, align = 'right') => `<th style="padding:6px 10px;text-align:${align};font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#94a3b8;border-bottom:1px solid #e2e8f0">${t}</th>`;
  const plainTd = (v: string, color: string) => `<td style="padding:6px 10px;text-align:right;font-weight:600;color:${color}">${v}</td>`;
  // A single amount cell → clicking copies it into that category's Final-approval box.
  const pick = (col: string, cat: string, raw: number, exists: boolean, color: string) => (exists
    ? `<td class="${editable ? 'pick' : ''}" data-col="${col}" data-cat="${cat}" data-val="${raw}" ${editable ? `title="Click to use ${esc(rs(raw))} as ${CAT_LABEL[cat]}"` : ''} style="padding:6px 10px;text-align:right;font-weight:600;color:${color}${editable ? ';cursor:pointer' : ''}">${rs(raw)}</td>`
    : plainTd('—', color));
  // A column Total → clicking copies the WHOLE column into the Final-approval boxes.
  const pickcol = (col: string, total: number, exists: boolean, color: string, label: string) => (exists
    ? `<td class="${editable ? 'pickcol' : ''}" data-col="${col}" ${editable ? `title="Use the whole ${label} column"` : ''} style="padding:7px 10px;text-align:right;font-weight:800;color:${color}${editable ? ';cursor:pointer' : ''}">${rs(total)}</td>`
    : `<td style="padding:7px 10px;text-align:right;font-weight:800;color:${color}">—</td>`);
  const brRows = CATS.map((c) => `<tr>
      <td style="padding:6px 10px;color:#0f172a;font-weight:600">${CAT_LABEL[c]}</td>
      ${pick('submitted', c, submitted[c], true, '#0f172a')}
      ${pick('reviewer', c, s1t[c], !!s1, '#16a34a')}
      ${pick('final', c, s2t[c], !!s2, '#b45309')}
    </tr>`).join('');
  const totRow = `<tr style="border-top:2px solid #e2e8f0">
      <td style="padding:7px 10px;color:#0f172a;font-weight:800">Total</td>
      ${pickcol('submitted', grand(submitted), true, '#0f172a', 'Submitted')}
      ${pickcol('reviewer', grand(s1t), !!s1, '#16a34a', 'Reviewer')}
      ${pickcol('final', grand(s2t), !!s2, '#b45309', 'Final')}
    </tr>`;
  const hint = editable ? `<div style="font-size:11.5px;color:#2563eb;margin-bottom:6px">👆 Tap any Submitted / Reviewer / Final amount to copy it into your final approval below — or tap a column Total to copy the whole column. You can still type any amount.</div>` : '';
  const breakdown = `<div style="margin-top:16px">
      <div style="font-size:11px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px">Stage breakdown · per category</div>
      ${hint}
      <table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <thead><tr>${th('Category', 'left')}${th('Submitted')}${th('Reviewer')}${th('Final')}</tr></thead>
        <tbody>${brRows}${totRow}</tbody>
      </table>
    </div>`;

  // ── Day-wise actual spend ──
  const days = parseJson<any[]>(plan.actualDayCosts, []);
  const atts = parseJson<any[]>(plan.techAttachments, []);
  const attFor = (day: any, cat: string) => atts.find((a) => String(a.day) === String(day) && a.category === cat && a.fileUrl);
  const dayRows = days.map((d, i) => {
    const c = dayCats(d);
    const cells = CATS.map((k) => `<td style="padding:5px 8px;text-align:right;color:#334155">${c[k] ? rs(c[k]) : '—'}</td>`).join('');
    return `<tr style="border-top:1px solid #eef2f7">
      <td style="padding:5px 8px;color:#0f172a;font-weight:600;white-space:nowrap">Day ${d.day ?? i + 1}</td>
      <td style="padding:5px 8px;color:#64748b;white-space:nowrap">${esc(d.date ? dmy(d.date) : '')}</td>
      ${cells}
      <td style="padding:5px 8px;text-align:right;font-weight:700;color:#0f172a">${rs(grand(c))}</td>
    </tr>`;
  }).join('');
  const dayHead = `<tr>${th('Day', 'left')}${th('Date', 'left')}${CATS.map((c) => th(CAT_LABEL[c])).join('')}${th('Total')}</tr>`;
  const dayTable = days.length ? `<div style="margin-top:16px">
      <div style="font-size:11px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px">Day-wise actual spend</div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px">
        <thead style="background:#f8fafc">${dayHead}</thead><tbody>${dayRows}</tbody>
      </table></div>
    </div>` : '';
  const billLinks = atts.filter((a) => a.fileUrl);
  const bills = billLinks.length ? `<div style="margin-top:12px"><div style="font-size:11px;text-transform:uppercase;color:#94a3b8;margin-bottom:4px">Bills</div>${billLinks.map((a) => `<a href="${esc(a.fileUrl)}" target="_blank" rel="noreferrer" style="display:inline-block;margin:0 6px 6px 0;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:4px 8px;font-size:12px;color:#475569;text-decoration:none">🧾 ${esc(CAT_LABEL[a.category] || a.category)} · Day ${esc(a.day)}</a>`).join('')}</div>` : '';

  // ── Decision form ──
  const action = `/api/public/tech-approval/${esc(plan.techApprovalToken)}/decide`;
  const inputRows = CATS.map((c) => `<tr>
      <td style="padding:5px 8px;color:#0f172a;font-weight:600">${CAT_LABEL[c]}</td>
      <td style="padding:5px 8px;text-align:right"><input id="fin-${c}" type="number" min="0" name="${c}" value="${pre[c] || 0}" oninput="finTotal&&finTotal()" style="width:120px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:6px 8px;font-size:14px;text-align:right" /></td>
    </tr>`).join('');
  const finTotalRow = `<tr style="border-top:1px solid #fde68a"><td style="padding:7px 8px;color:#0f172a;font-weight:800">Total</td><td style="padding:7px 8px;text-align:right"><input id="fin-total" type="number" min="0" name="_total" value="${grand(pre)}" onchange="finRedistribute&&finRedistribute()" style="width:120px;box-sizing:border-box;border:1px solid #fbbf24;border-radius:6px;padding:6px 8px;font-size:14px;font-weight:800;text-align:right;background:#fffdf5" /></td></tr>`;
  const decisionForm = decided
    ? `<div style="margin-top:18px;padding:12px 14px;background:#f1f5f9;border-radius:8px;color:#475569;font-size:13px">This trip's expenses have already been decided${plan.techApprovedBy ? ` by ${esc(plan.techApprovedBy)}` : ''}.</div>`
    : `<form method="post" action="${action}" style="margin-top:20px;border-top:1px solid #e2e8f0;padding-top:16px">
        <div style="font-size:11px;text-transform:uppercase;color:#94a3b8;margin-bottom:6px">Your final approval amount — edit per category, or set the Total to split it across them</div>
        <table style="width:100%;border-collapse:collapse;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;overflow:hidden">
          <tbody>${inputRows}${finTotalRow}</tbody>
        </table>
        <label style="font-size:12px;color:#64748b;display:block;margin:14px 0 4px">Comments (required to Reject)</label>
        <textarea name="comment" rows="2" style="width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:14px"></textarea>
        <div style="margin-top:14px;display:flex;gap:10px">
          <button name="decision" value="APPROVED" style="background:#16a34a;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">✓ Approve as Final approval</button>
          <button name="decision" value="REJECTED" style="background:#dc2626;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">✗ Reject</button>
        </div>
      </form>`;

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}input[type=number]{-moz-appearance:textfield;appearance:textfield}</style></head>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#1e293b">
    <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
      <div style="background:#052379;color:#fff;padding:18px 22px">
        <div style="font-size:12px;opacity:.85;letter-spacing:.04em">CRMCTS · FINAL APPROVAL</div>
        <div style="font-size:20px;font-weight:800;margin-top:3px">${title}</div>
      </div>
      <div style="padding:22px">
        ${notice ? `<div style="margin-bottom:14px;padding:10px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;color:#065f46;font-weight:600">${esc(notice)}</div>` : ''}
        <div style="margin-bottom:10px">${badge(plan.techEntryStatus)}</div>
        <table style="width:100%;border-collapse:collapse;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">${detail}</table>
        ${breakdown}
        ${dayTable}
        ${bills}
        ${decisionForm}
      </div>
      <div style="padding:12px 22px;background:#f8fafc;color:#94a3b8;font-size:11px;text-align:center">CRMCTS · Crystal Group</div>
    </div>
    <script>
    (function(){
      var CATS=['travel','food','hotel','other','misc'];
      function flash(el){if(!el)return;el.style.background='#fde68a';setTimeout(function(){el.style.background='';},450);}
      // Sum the category boxes → mirror into the (editable) Total box.
      function finTotal(){var t=0;CATS.forEach(function(c){var el=document.getElementById('fin-'+c);if(el)t+=Number(el.value)||0;});var o=document.getElementById('fin-total');if(o)o.value=Math.round(t);}
      window.finTotal=finTotal;
      // Approver typed a Total directly → split it across the categories in their
      // current proportion (all-zero → put it in Other), so the per-category
      // breakdown that gets submitted always sums to the Total they chose.
      function finRedistribute(){
        var o=document.getElementById('fin-total'); if(!o) return;
        var T=Math.max(0,Math.round(Number(o.value)||0));
        var vals=CATS.map(function(c){var el=document.getElementById('fin-'+c);return el?Math.max(0,Number(el.value)||0):0;});
        var S=vals.reduce(function(a,b){return a+b;},0);
        var out;
        if(S<=0){ out=[0,0,0,0,0]; out[3]=T; } else { out=vals.map(function(v){return Math.round(v*T/S);}); }
        var diff=T-out.reduce(function(a,b){return a+b;},0);
        if(diff!==0){ var mi=0; for(var i=1;i<out.length;i++){ if(out[i]>out[mi]) mi=i; } out[mi]=Math.max(0,out[mi]+diff); }
        CATS.forEach(function(c,i){var el=document.getElementById('fin-'+c); if(el){ el.value=out[i]; flash(el); }});
        o.value=out.reduce(function(a,b){return a+b;},0);
      }
      window.finRedistribute=finRedistribute;
      function setCat(cat,val){var el=document.getElementById('fin-'+cat);if(!el)return;el.value=Math.round(Number(val)||0);flash(el);}
      document.querySelectorAll('td.pick').forEach(function(td){td.addEventListener('click',function(){setCat(td.getAttribute('data-cat'),td.getAttribute('data-val'));finTotal();});});
      document.querySelectorAll('td.pickcol').forEach(function(td){td.addEventListener('click',function(){var col=td.getAttribute('data-col');document.querySelectorAll('td.pick[data-col="'+col+'"]').forEach(function(c){setCat(c.getAttribute('data-cat'),c.getAttribute('data-val'));});finTotal();});});
      finTotal();
    })();
    </script>
  </body></html>`;
}

router.get('/:token', asyncHandler(async (req, res) => {
  const ctx = await loadByToken(req.params.token);
  if (!ctx) { res.status(404).send('<p style="font-family:sans-serif;padding:40px;text-align:center">This final-approval link is invalid or expired.</p>'); return; }
  res.send(page(ctx));
}));

router.post('/:token/decide', asyncHandler(async (req, res) => {
  const ctx = await loadByToken(req.params.token);
  if (!ctx) { res.status(404).send('Invalid link'); return; }
  const { plan, cfg } = ctx;
  const decision = req.body.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED';
  const comment: string | null = (req.body.comment || '').trim() || null;

  // Guards — mirror tech-stage-decide (Stage 3 only): must be a submitted expense,
  // Stage 3 must be configured, Stage 2 must have approved, and not already decided.
  const decided = plan.techEntryStatus === 'APPROVED' || plan.techEntryStatus === 'REJECTED';
  const s2 = parseJson<any>(plan.techStage2, null);
  const s3 = parseJson<any>(plan.techStage3, null);
  if (decided || (s3 && s3.status)) { res.send(confirmationPage(`Final approval · ${esc(plan.planNumber)}`, 'This trip was already decided.', false)); return; }
  if (plan.techEntryStatus !== 'SUBMITTED') { res.send(confirmationPage(`Final approval · ${esc(plan.planNumber)}`, 'This trip is not awaiting a final approval.', false)); return; }
  if (!cfg?.stage3Id) { res.send(confirmationPage(`Final approval · ${esc(plan.planNumber)}`, 'No final-approval stage is configured.', false)); return; }
  if (!s2 || s2.status !== 'APPROVED') { res.send(confirmationPage(`Final approval · ${esc(plan.planNumber)}`, 'The Final (Stage 2) review is still pending.', false)); return; }

  if (decision === 'REJECTED' && !comment) { res.send(page(ctx, 'Please add a comment to Reject.')); return; }

  // The Final approver's per-category amount wins; days carry over from Stage 2.
  const totals: Cats = { travel: num(req.body.travel), food: num(req.body.food), hotel: num(req.body.hotel), other: num(req.body.other), misc: num(req.body.misc) };
  const by = cfg.stage3Name || 'Final approver';
  const stageObj = { status: decision, by, at: new Date().toISOString(), comment, days: s2.days || [], totals };
  const data: any = { techStage3: JSON.stringify(stageObj) };
  if (decision === 'REJECTED') {
    data.techEntryStatus = 'REJECTED'; data.techApproveComment = comment; data.techApprovedBy = by; data.techApprovedAt = new Date();
  } else {
    data.techEntryStatus = 'APPROVED'; data.techApproved = JSON.stringify(totals); data.techApprovedBy = by; data.techApprovedAt = new Date();
  }
  await prisma.travelPlan.update({ where: { id: plan.id }, data });
  await audit({ userId: '', action: `TRAVEL_TECH_STAGE3_${decision}`, entity: 'TravelPlan', entityId: plan.id, details: { planNumber: plan.planNumber, via: 'public-form' } });
  if (decision === 'APPROVED') notifyEmployeeTechApproved(plan.id).catch(() => {});

  const notice = decision === 'APPROVED' ? 'Final approval recorded — the traveller has been notified.' : 'Rejected — sent back for correction.';
  res.send(confirmationPage(`Final approval · ${esc(plan.planNumber)}`, notice, decision === 'REJECTED'));
}));

function confirmationPage(heading: string, notice: string, reject: boolean): string {
  const accent = reject ? '#dc2626' : '#16a34a';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;margin:0;padding:24px;color:#1e293b">
    <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center">
      <div style="background:${accent};color:#fff;padding:22px;font-size:34px">${reject ? '✗' : '✓'}</div>
      <div style="padding:24px">
        <div style="font-size:18px;font-weight:800;color:#0f172a">${esc(heading)}</div>
        <div style="margin-top:10px;color:#475569;font-size:14px">${esc(notice)}</div>
        <div style="margin-top:16px;color:#94a3b8;font-size:12px">You can close this window.</div>
      </div>
    </div>
  </body></html>`;
}

export default router;
