// Throwaway: prove the value-threshold approval matrix behaves. Creates its own
// rules, asserts, then removes exactly the rules it created. Touches nothing else.
//   npx tsx scripts/_verifyMatrix.ts <projectId>
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { chainForAmount, validateChain, bandLabel } from '../src/services/approvalMatrix';

const prisma = new PrismaClient();
const pid = process.argv[2];

let pass = 0;
let fail = 0;
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

(async () => {
  const users = await prisma.user.findMany({ where: { active: true }, take: 3, select: { id: true, name: true } });
  if (users.length < 3) throw new Error('need 3 active users');
  const [site, dept, finance] = users;

  // Bands from the transcript: site petty cash, department head, finance.
  const created = await Promise.all([
    prisma.approvalRule.create({ data: { projectId: null, docType: 'PO', minAmount: 0, maxAmount: 10_000, approverId: site.id, approverName: site.name, order: 1 } }),
    prisma.approvalRule.create({ data: { projectId: null, docType: 'PO', minAmount: 10_001, maxAmount: 200_000, approverId: dept.id, approverName: dept.name, order: 2 } }),
    prisma.approvalRule.create({ data: { projectId: null, docType: 'PO', minAmount: 200_001, maxAmount: null, approverId: finance.id, approverName: finance.name, order: 3 } }),
  ]);

  try {
    console.log(`\nbands: ${created.map((r) => `${r.approverName} ${bandLabel(r.minAmount, r.maxAmount)}`).join(' | ')}\n`);

    const at5k = await chainForAmount('PO', pid, 5_000);
    check('₹5,000 → site engineer only', at5k.steps.length === 1 && at5k.steps[0].approverId === site.id,
      at5k.steps.map((s) => s.approverName).join(' → '));

    const at50k = await chainForAmount('PO', pid, 50_000);
    check('₹50,000 → department head only (site band excluded)', at50k.steps.length === 1 && at50k.steps[0].approverId === dept.id,
      at50k.steps.map((s) => s.approverName).join(' → '));

    const at500k = await chainForAmount('PO', pid, 500_000);
    check('₹5,00,000 → finance (unbounded band)', at500k.steps.length === 1 && at500k.steps[0].approverId === finance.id,
      at500k.steps.map((s) => s.approverName).join(' → '));

    check('scope is global when no project rule exists', at500k.scope === 'global', at500k.scope);
    check('configured=true once rules exist', at500k.configured);

    // Enforcement: a chain that omits the required approver must be rejected.
    const bad = await validateChain('PO', pid, 500_000, [site.id, dept.id]);
    check('chain without finance is rejected on a ₹5,00,000 PO', bad.ok === false,
      bad.ok ? '' : bad.message);

    const good = await validateChain('PO', pid, 500_000, [site.id, finance.id]);
    check('chain containing finance is accepted (extra reviewers allowed)', good.ok === true);

    // A project-specific rule must REPLACE the globals, not merge with them.
    const projRule = await prisma.approvalRule.create({
      data: { projectId: pid, docType: 'PO', minAmount: 0, maxAmount: null, approverId: dept.id, approverName: dept.name, order: 1 },
    });
    created.push(projRule);
    const scoped = await chainForAmount('PO', pid, 500_000);
    check('project rules replace the org defaults', scoped.scope === 'project' && scoped.steps.length === 1 && scoped.steps[0].approverId === dept.id,
      `${scoped.scope}, ${scoped.steps.map((s) => s.approverName).join(' → ')}`);

    // Same person appearing in two bands signs once.
    const dupe = await prisma.approvalRule.create({
      data: { projectId: pid, docType: 'PO', minAmount: 0, maxAmount: 1_000_000, approverId: dept.id, approverName: dept.name, order: 2 },
    });
    created.push(dupe);
    const deduped = await chainForAmount('PO', pid, 500_000);
    check('an approver in two matching bands is added once', deduped.steps.length === 1, `${deduped.steps.length} step(s)`);
  } finally {
    // Remove exactly what this script created — nothing else.
    await prisma.approvalRule.deleteMany({ where: { id: { in: created.map((r) => r.id) } } });
    const left = await prisma.approvalRule.count();
    console.log(`\ncleaned up ${created.length} test rules; ${left} rules remain in the database`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
