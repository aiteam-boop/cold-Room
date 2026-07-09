// Throwaway: drive the newly-implemented PRD surfaces end-to-end through the
// real auth + permission middleware, using a token minted from JWT_SECRET.
//   npx tsx scripts/_verifyPrd.ts <projectId>
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = `http://localhost:${process.env.PORT || 4100}`;
const pid = process.argv[2];

const ok = (b: boolean) => (b ? 'OK  ' : 'FAIL');

(async () => {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, email: true } });
  if (!admin) throw new Error('no admin');
  const token = jwt.sign({ sub: admin.id, role: 'ADMIN' }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  console.log(`as ${admin.email}\n`);

  const get = async (p: string) => {
    const r = await fetch(`${BASE}${p}`, { headers: h });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  // ── G7: delivery on the PO register ───────────────────────────────────────
  const docs = await get(`/api/projects/${pid}/procurement/docs?type=PO`);
  const d0 = docs.body?.docs?.[0];
  console.log(`${ok(docs.status === 200 && !!d0?.delivery)} G7  PO register carries derived delivery`,
    d0 ? `— ${d0.docNumber}: status=${d0.delivery.status}, promised=${d0.delivery.promisedDeliveryDate ?? 'unset'}, actual=${d0.delivery.actualDeliveryDate ?? 'none'}` : '(no POs)');

  // ── G8: GRN + invoice on the BOQ cost rows ────────────────────────────────
  const cost = await get(`/api/projects/${pid}/boq/cost`);
  const withPo = (cost.body?.items ?? []).filter((i: any) => i.pos.length > 0);
  const hasShape = withPo.length === 0 || (withPo[0].receiptStatus !== undefined && Array.isArray(withPo[0].pos[0].grns));
  const grnLines = withPo.filter((i: any) => i.pos.some((p: any) => p.grns.length > 0));
  console.log(`${ok(cost.status === 200 && hasShape)} G8  BOQ cost rows carry receiptStatus + grns[]`,
    `— ${withPo.length} items with a PO, ${grnLines.length} of them with a GRN`);
  if (grnLines[0]) {
    const g = grnLines[0].pos.flatMap((p: any) => p.grns)[0];
    console.log(`         e.g. ${grnLines[0].description.slice(0, 40)} → ${grnLines[0].receiptStatus}, GRN ${g.grnNumber} (${g.status}), invoice ${g.invoiceNumber ?? '—'}`);
  }

  // ── G6: approval matrix ───────────────────────────────────────────────────
  const rules = await get('/api/approval-rules?docType=PO');
  const cands = await get('/api/approval-rules/candidates?docType=PO');
  const preview = await get(`/api/approval-rules/preview?docType=PO&projectId=${pid}&amount=200000`);
  console.log(`${ok(rules.status === 200)} G6  GET /approval-rules — ${rules.body?.rules?.length ?? 0} rules configured`);
  console.log(`${ok(cands.status === 200)} G6  GET /candidates    — ${cands.body?.candidates?.length ?? 0} eligible PO approvers`);
  console.log(`${ok(preview.status === 200)} G6  preview ₹2,00,000 — configured=${preview.body?.configured}, scope=${preview.body?.scope}, steps=${preview.body?.steps?.length ?? 0}`);

  // ── G11: reports ──────────────────────────────────────────────────────────
  const reg = await get(`/api/projects/${pid}/reports/procurement-register`);
  const s = reg.body?.summary;
  console.log(`${ok(reg.status === 200)} G11 procurement-register — ${reg.body?.rows?.length ?? 0} docs, ordered=${s?.totalOrdered}, paid=${s?.totalPaid}, outstanding=${s?.totalPending}`);
  if (s) console.log(`         on-time delivery ${s.onTimeDelivery.onTime}/${s.onTimeDelivery.measured}, on-time payment ${s.onTimePayment.onTime}/${s.onTimePayment.measured}, ${s.docsWithoutDeliveryDate} docs with no promised date`);
  const vo = await get(`/api/projects/${pid}/reports/vendor-outstanding`);
  console.log(`${ok(vo.status === 200)} G11 vendor-outstanding  — ${vo.body?.vendors?.length ?? 0} vendors`);
  for (const v of (vo.body?.vendors ?? []).slice(0, 3)) {
    console.log(`         ${v.vendorName}: ordered ${v.totalOrdered}, paid ${v.totalPaid}, outstanding ${v.totalOutstanding}, dueNow ${v.dueNow}`);
  }

  // ── G10: drawing revision chain ───────────────────────────────────────────
  const dr = await get(`/api/projects/${pid}/drawings`);
  const list = dr.body?.drawings ?? [];
  const shaped = list.length === 0 || 'isFinal' in list[0];
  console.log(`${ok(dr.status === 200 && shaped)} G10 drawings carry parentId/isFinal/discipline — ${list.length} drawings, ${list.filter((x: any) => x.isFinal).length} final, ${list.filter((x: any) => x.parentId).length} revisions`);

  // ── G9 has no endpoint of its own (client-side view split) ────────────────
  console.log('---  G9  BOQ Master is a client-side view over GET /boq (no new endpoint)');

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
