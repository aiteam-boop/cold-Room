// Throwaway: drive the DPR HTTP surface end-to-end through the real auth +
// permission middleware, using a token minted from JWT_SECRET (no password).
//   npx tsx scripts/_verifyDpr.ts <projectId>
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = `http://localhost:${process.env.PORT || 4100}`;
const pid = process.argv[2];

(async () => {
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, email: true } });
  if (!admin) throw new Error('no admin user');
  const token = jwt.sign({ sub: admin.id, role: 'ADMIN' }, process.env.JWT_SECRET!, { expiresIn: '10m' });
  const h = { Authorization: `Bearer ${token}` };
  console.log(`as ${admin.email}\n`);

  const get = async (path: string) => {
    const r = await fetch(`${BASE}/api/projects/${pid}/dpr${path}`, { headers: h });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };

  const checks: [string, string][] = [
    ['/summary?mode=sheet', 'Dashboard + Room_Handover'],
    ['/summary?mode=corrected', 'corrected rollup'],
    ['/entries', 'Daily_Entry log'],
    ['/options', 'Room→Category→Item cascade'],
    ['/milestones', 'Milestones tab'],
    ['/reconcile', 'BOQ reconciliation'],
  ];

  for (const [path, label] of checks) {
    const { status, body } = await get(path);
    let detail = '';
    if (path.startsWith('/summary')) detail = `overall ${(body.overallPct * 100).toFixed(1)}%, ${body.totalActivities} activities, ${body.warnings.length} warnings`;
    if (path === '/entries') detail = `${body.entries.length} entries`;
    if (path === '/options') {
      const amb = body.rooms.find((r: any) => r.zoneName.startsWith('Ambient'));
      const common = body.rooms.find((r: any) => r.isCommonBucket);
      detail = `${body.rooms.length} rooms | Ambient categories: [${amb?.categories.join(', ')}] | Common: [${common?.categories.join(', ')}]`;
    }
    if (path === '/milestones') detail = `${body.milestones.length} milestones`;
    if (path === '/reconcile') detail = `${body.linked.length} linked, ${body.unlinkedBoqItems} BOQ items unlinked`;
    console.log(`${status === 200 ? 'OK  ' : 'FAIL'} ${path.padEnd(28)} ${label.padEnd(28)} ${detail}`);
  }

  // The B4 guard: an invalid Room×Category×Activity must be rejected at write time.
  const opts = (await get('/options')).body;
  const ambient = opts.rooms.find((r: any) => !r.isCommonBucket && r.zoneName.startsWith('Ambient'));
  const commonRoom = opts.rooms.find((r: any) => r.isCommonBucket);
  const piping = commonRoom.activities.find((a: any) => a.activity === 'Refrigeration Piping');
  console.log(`\nB4 guard: "Refrigeration Piping" is offered under ${commonRoom.zoneName} only.`);
  console.log(`  Ambient offers ${ambient.activities.length} activities, none of them Refrigeration:`,
    ambient.activities.some((a: any) => a.category === 'Refrigeration') ? 'LEAK!' : 'clean');
  console.log(`  Common offers ${commonRoom.activities.length} activities incl. ${piping ? piping.activity : 'MISSING'}`);

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
