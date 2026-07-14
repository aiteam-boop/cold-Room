// One-off: `User.lastLoginAt` is new, but every login has always written a
// USER_LOGIN audit row — so seed the column from the newest USER_LOGIN per user
// instead of showing "—" for everyone who logged in before the column existed.
//   npx tsx scripts/backfillLastLogin.ts
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

(async () => {
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true, lastLoginAt: true } });
  let set = 0, never = 0;
  for (const u of users) {
    const last = await prisma.auditLog.findFirst({
      where: { userId: u.id, action: 'USER_LOGIN' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!last) { never++; continue; }
    if (u.lastLoginAt && u.lastLoginAt >= last.createdAt) continue;
    await prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: last.createdAt } });
    console.log(`  ${u.name} <${u.email}> → ${last.createdAt.toLocaleString('en-GB')}`);
    set++;
  }
  console.log(`\n${set} user(s) backfilled, ${never} never logged in, ${users.length} total.`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
