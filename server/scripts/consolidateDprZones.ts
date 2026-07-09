// Consolidate duplicate DPR rooms onto the project's existing floor-plan zones.
//
// The /dpr/seed route used to match zones by exact name only, so on a project
// whose floor plan already had "Ambient Room" it created a second zone called
// "Ambient". This moves the room-wise scope onto the original zone and removes
// the duplicate. Rooms with no floor-plan counterpart (Corridor & Warm Room,
// Ante Room, Common / Plant-wide) are left exactly as they are.
//
// The /dpr/seed route now adopts the existing zone (see zoneNameCandidates in
// lib/dprCatalog.ts), so freshly-seeded projects never get into this state. This
// script is only for projects seeded before that fix.
//
// Dry run by default. Pass --apply to write.
//
//   npx tsx scripts/consolidateDprZones.ts <projectId> [--apply]

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { zoneNameCandidates, DPR_ROOMS, COMMON_BUCKET } from '../src/lib/dprCatalog';

const prisma = new PrismaClient();

(async () => {
  const projectId = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!projectId) throw new Error('Usage: tsx scripts/_tmp_probe.ts <projectId> [--apply]');

  const zones = await prisma.projectZone.findMany({ where: { projectId } });
  const byName = new Map(zones.map((z) => [z.zoneName, z]));
  const scopeCounts = new Map<string, number>();
  for (const z of zones) {
    scopeCounts.set(z.id, await prisma.roomScopeItem.count({ where: { zoneId: z.id } }));
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — project ${projectId}\n`);

  let moved = 0;
  let removed = 0;

  for (const room of [...DPR_ROOMS, COMMON_BUCKET]) {
    const isCommon = room === COMMON_BUCKET;
    const candidates = zoneNameCandidates(room, isCommon);
    // The zone the DPR is currently attached to (holds the scope rows).
    const dprZone = zones.find((z) => z.zoneName === room && (scopeCounts.get(z.id) ?? 0) > 0);
    if (!dprZone) { console.log(`  ${room.padEnd(22)} — no scope attached, skipping`); continue; }

    // The project's own zone for the same physical room, under a different name.
    const target = candidates.slice(1).map((n) => byName.get(n)).find((z) => z && z.id !== dprZone.id);
    if (!target) { console.log(`  ${room.padEnd(22)} — keep "${dprZone.zoneName}" (no floor-plan counterpart)`); continue; }

    const targetScope = scopeCounts.get(target.id) ?? 0;
    if (targetScope > 0) {
      console.log(`  ${room.padEnd(22)} — SKIP: "${target.zoneName}" already has ${targetScope} scope rows (would collide)`);
      continue;
    }

    const n = scopeCounts.get(dprZone.id) ?? 0;
    console.log(`  ${room.padEnd(22)} — move ${n} scope rows "${dprZone.zoneName}" → "${target.zoneName}", then delete the duplicate`);

    if (apply) {
      // DPREntry points at RoomScopeItem, not the zone, so repointing zoneId is
      // enough — no entry is touched and no cumulative changes.
      const res = await prisma.roomScopeItem.updateMany({ where: { zoneId: dprZone.id }, data: { zoneId: target.id } });
      await prisma.projectZone.update({
        where: { id: target.id },
        data: {
          isCommonBucket: dprZone.isCommonBucket,
          plannedHandoverDate: dprZone.plannedHandoverDate ?? target.plannedHandoverDate,
        },
      });
      // Re-point any milestone that referenced the duplicate.
      await prisma.projectMilestone.updateMany({ where: { projectId, zoneId: dprZone.id }, data: { zoneId: target.id } });
      await prisma.projectZone.delete({ where: { id: dprZone.id } });
      moved += res.count;
      removed++;
    }
  }

  console.log(`\n${apply ? `moved ${moved} scope rows, removed ${removed} duplicate zones` : 'nothing written — re-run with --apply'}`);

  const after = await prisma.projectZone.findMany({ where: { projectId }, orderBy: { sortOrder: 'asc' } });
  console.log(`\nzones now: ${after.length}`);
  for (const z of after) {
    const n = await prisma.roomScopeItem.count({ where: { zoneId: z.id } });
    console.log(`  ${z.zoneName.padEnd(30)} coords:${z.coordinates ? 'yes' : 'no '} common:${z.isCommonBucket} scope:${n}`);
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
