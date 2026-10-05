// One-off backfill: BOQs imported BEFORE the "Sub Total" handling landed stored
// their subtotal rows as normal line items — with a category and the roll-up
// figure sitting in plannedQty — which double-counts and tags the subtotal to a
// category it doesn't belong to.
//
// This converts every existing "Sub Total / Total / Grand Total" row in place to
// a no-category SUMMARY row (isGroup=true, category=null, plannedQty=0), so the
// BOQ view renders it as a live section total (Planned = Σ of the section's lines,
// Installed/Remaining update with progress) — exactly like a fresh import now does.
// It touches ONLY those rows: progress entries and every other BOQ item are left
// untouched, so there is no re-import and no data loss.
//
// SAFE BY DEFAULT: runs as a DRY RUN (prints what it WOULD change) unless --apply
// is passed, so the affected rows can be reviewed first.
//   Preview:  npx tsx scripts/backfillBoqSubtotals.ts
//   Apply:    npx tsx scripts/backfillBoqSubtotals.ts --apply
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// MUST stay identical to the detection in boqParser.ts + BOQTab.tsx so the rows we
// convert are exactly the ones the view renders as a total band.
const TOTAL_RE = /^\s*(sub\s*-?\s*total|grand\s*total|total)\b/i;
const APPLY = process.argv.includes('--apply');

(async () => {
  const [items, projects] = await Promise.all([
    prisma.bOQItem.findMany({
      select: { id: true, projectId: true, srNo: true, description: true, category: true, plannedQty: true, isGroup: true },
    }),
    prisma.project.findMany({ select: { id: true, name: true } }),
  ]);
  const nameOf = new Map(projects.map((p) => [p.id, p.name]));

  // Filter in JS (a Mongo regex-less equality filter can't express this, and a
  // newly-added field's null filter is unreliable — see Prisma+Mongo null notes).
  const targets = items.filter((it) => TOTAL_RE.test(it.description || ''));
  // Idempotent: skip rows already in the desired shape, so re-runs are no-ops.
  const toFix = targets.filter((it) => !it.isGroup || it.category != null || (Number(it.plannedQty) || 0) !== 0);

  console.log(`${APPLY ? '' : '[DRY RUN] '}Scanned ${items.length} BOQ rows.`);
  console.log(`Matched ${targets.length} subtotal/total row(s); ${toFix.length} need fixing.\n`);

  let fixed = 0;
  for (const it of toFix) {
    const proj = nameOf.get(it.projectId) || it.projectId;
    console.log(`  • ${proj}  |  sr ${it.srNo || '—'}  |  "${(it.description || '').replace(/\s+/g, ' ').slice(0, 70)}"`);
    console.log(`      isGroup ${it.isGroup} → true · category "${it.category ?? '∅'}" → ∅ · plannedQty ${it.plannedQty} → 0`);
    if (APPLY) {
      await prisma.bOQItem.update({ where: { id: it.id }, data: { isGroup: true, category: null, plannedQty: 0 } });
      fixed++;
    }
  }

  const projCount = new Set(toFix.map((t) => t.projectId)).size;
  console.log(`\n${APPLY ? `Fixed ${fixed}` : `Would fix ${toFix.length}`} row(s) across ${projCount} project(s).`);
  if (!APPLY && toFix.length) console.log('\nReview the list above, then re-run with --apply to write the changes.');
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
