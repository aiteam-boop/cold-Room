import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

// ── FKI Cold Room BOQ baseline (PRD §7) ─────────────────────────────────────
// category, room/zone, description, unit, plannedQty
type Row = { category: string; room?: string; description: string; unit: string; qty: number };

const BOQ: Row[] = [
  // 7.1 Refrigeration Units
  { category: 'Refrigeration Units', room: 'Blast Freezer (-30C)', description: 'Supply + Install Indoor & Outdoor Units — Blast Freezer', unit: "No's", qty: 2 },
  { category: 'Refrigeration Units', room: 'Freezer (-25C)', description: 'Supply + Install Indoor & Outdoor Units — Freezer', unit: "No's", qty: 4 },
  { category: 'Refrigeration Units', room: 'Chiller (1-3C)', description: 'Supply + Install Indoor & Outdoor Units — Chiller', unit: "No's", qty: 3 },
  { category: 'Refrigeration Units', room: 'Ambient (18C)', description: 'Supply + Install Indoor & Outdoor Units — Ambient', unit: "No's", qty: 2 },
  { category: 'Refrigeration Units', room: 'Cold Anteroom (7-10C)', description: 'Supply + Install Indoor & Outdoor Units — Cold Anteroom', unit: "No's", qty: 3 },

  // 7.2 Refrigerant Piping (mtr)
  { category: 'Refrigerant Piping', room: 'Blast Freezer (-30C)', description: 'Copper refrigerant piping (suction + liquid + insulation)', unit: 'mtr', qty: 60 },
  { category: 'Refrigerant Piping', room: 'Freezer (-25C)', description: 'Copper refrigerant piping (suction + liquid + insulation)', unit: 'mtr', qty: 165 },
  { category: 'Refrigerant Piping', room: 'Chiller (2-4C)', description: 'Copper refrigerant piping (suction + liquid + insulation)', unit: 'mtr', qty: 130 },
  { category: 'Refrigerant Piping', room: 'Ambient (18C)', description: 'Copper refrigerant piping (suction + liquid + insulation)', unit: 'mtr', qty: 90 },
  { category: 'Refrigerant Piping', room: 'Cold Anteroom (7-10C)', description: 'Copper refrigerant piping (suction + liquid + insulation)', unit: 'mtr', qty: 135 },
  { category: 'Refrigerant Piping', room: 'Anteroom (18-24C)', description: 'Copper refrigerant piping (suction + liquid + insulation)', unit: 'mtr', qty: 105 },

  // 7.3 PUF Panels & Floor Insulation (Sq.M)
  { category: 'PUF Panels', room: 'Freezer/Chiller/Ambient', description: '150mm PUF Panels (Walls/Ceiling)', unit: 'Sq.M', qty: 3950 },
  { category: 'PUF Panels', room: 'Anteroom', description: '60mm PUF Panels (Walls/Ceiling)', unit: 'Sq.M', qty: 150 },
  { category: 'PUF Panels', room: 'Anteroom', description: 'FKI-supplied 60mm panels (Anteroom) — reinstall', unit: 'Sq.M', qty: 350 },
  { category: 'PUF Panels', room: 'Blast Freezer', description: '150mm PUF Floor Slab — Blast Freezer (100+50 two-layer)', unit: 'Sq.M', qty: 60 },
  { category: 'PUF Panels', room: 'Freezer', description: '150mm PUF Floor Slab — Freezer (100+50 two-layer)', unit: 'Sq.M', qty: 365 },
  { category: 'PUF Panels', room: 'Chiller', description: '150mm PUF Floor Slab — Chiller (100+50 two-layer)', unit: 'Sq.M', qty: 230 },
  { category: 'PUF Panels', room: 'Ambient Anteroom', description: '150mm PUF Floor Slab — Ambient Anteroom (100+50 two-layer)', unit: 'Sq.M', qty: 150 },
  { category: 'PUF Panels', room: 'Cold Anteroom', description: '150mm PUF Floor Slab — Cold Anteroom (100+50 two-layer)', unit: 'Sq.M', qty: 150 },

  // 7.4 Doors, Air Curtains & Strip Curtains
  { category: 'Insulated Doors', room: 'Blast Freezer', description: 'Automatic Sliding Door — Blast Freezer 1.8M x 2.1M x 150mm', unit: "No's", qty: 1 },
  { category: 'Insulated Doors', room: 'Freezer', description: 'Automatic Sliding Door — Freezer 1.8M x 2.1M x 120mm', unit: "No's", qty: 4 },
  { category: 'Insulated Doors', room: 'Emergency Freezer', description: 'Automatic Sliding Door — Emergency Freezer 1.2M x 2.1M', unit: "No's", qty: 1 },
  { category: 'Insulated Doors', room: 'Chiller', description: 'Automatic Sliding Door — Chiller 1.8M x 2.1M x 120mm', unit: "No's", qty: 4 },
  { category: 'Insulated Doors', room: 'Emergency Chiller', description: 'Automatic Sliding Door — Emergency Chiller 1.2M x 2.1M', unit: "No's", qty: 1 },
  { category: 'Insulated Doors', room: 'Ambient', description: 'Automatic Sliding Door — Ambient 1.8M x 2.1M x 80mm', unit: "No's", qty: 4 },
  { category: 'Insulated Doors', room: 'Cold Anteroom', description: 'Automatic Sliding Door — Cold Anteroom 1.2M x 2.1M', unit: "No's", qty: 1 },
  { category: 'Insulated Doors', room: 'Anteroom', description: 'Automatic Sliding Door — Anteroom 1.8M x 2.1M x 80mm', unit: "No's", qty: 1 },
  { category: 'Insulated Doors', room: 'Freezer', description: 'Emergency Hinge Door — Freezer 1.2M x 2.1M x 120mm PIR', unit: "No's", qty: 2 },
  { category: 'Insulated Doors', room: 'Chiller', description: 'Emergency Hinge Door — Chiller 1.2M x 2.1M x 80mm PIR', unit: "No's", qty: 2 },
  { category: 'Insulated Doors', room: 'Cold Anteroom', description: 'Emergency Hinge Door — Cold Anteroom 1.2M x 2.1M x 80mm', unit: "No's", qty: 4 },

  { category: 'Air Curtains', room: 'Freezer', description: 'Air Curtain — Freezer 1.8M doors', unit: "No's", qty: 4 },
  { category: 'Air Curtains', room: 'Chiller', description: 'Air Curtain — Chiller 1.8M doors', unit: "No's", qty: 4 },
  { category: 'Air Curtains', room: 'Ambient', description: 'Air Curtain — Ambient 1.8M doors', unit: "No's", qty: 4 },
  { category: 'Air Curtains', room: 'Cold Anteroom + Anteroom', description: 'Air Curtain — Cold Anteroom + Anteroom', unit: "No's", qty: 2 },
  { category: 'Air Curtains', room: 'All rooms', description: 'PVC Strip Curtains (3mm polar)', unit: 'Sq.M', qty: 58 },

  // MS Structural Supports
  { category: 'MS Structural Supports', room: 'MTS areas', description: 'MS Door Structural Supports', unit: 'MT', qty: 3 },
  { category: 'MS Structural Supports', room: 'All rooms', description: 'MS structural supports — supply', unit: 'MT', qty: 5 },
  { category: 'MS Structural Supports', room: 'All rooms', description: 'MS structural supports — reinstallation', unit: 'MT', qty: 1.5 },

  // 7.5 Drain Piping (CPVC)
  { category: 'Drain Piping', room: 'Indoor units', description: '32mm CPVC — individual branch drain pipes', unit: 'mtr', qty: 100 },
  { category: 'Drain Piping', room: 'Header', description: '50mm CPVC — header drain pipes', unit: 'mtr', qty: 240 },

  // 7.6 Electrical Cabling & Cable Tray
  { category: 'Electrical Cabling', room: 'Blast Freezer (-30C)', description: 'FRLS Copper Cable', unit: 'RMT', qty: 90 },
  { category: 'Electrical Cabling', room: 'Freezer (-25C)', description: 'FRLS Copper Cable', unit: 'RMT', qty: 248 },
  { category: 'Electrical Cabling', room: 'Chiller (1-3C)', description: 'FRLS Copper Cable', unit: 'RMT', qty: 195 },
  { category: 'Electrical Cabling', room: 'Ambient (18C)', description: 'FRLS Copper Cable', unit: 'RMT', qty: 135 },
  { category: 'Electrical Cabling', room: 'Cold Anteroom (7-10C)', description: 'FRLS Copper Cable', unit: 'RMT', qty: 203 },
  { category: 'Electrical Cabling', room: 'Anteroom (18-24C)', description: 'FRLS Copper Cable', unit: 'RMT', qty: 158 },
  { category: 'Electrical Cabling', room: 'Sensors/Hooters/Door heaters', description: '3Cx1.5 Sq.M Control Wiring', unit: 'RMT', qty: 680 },
  { category: 'Electrical Cabling', room: 'Main runs', description: 'GI Cable Tray 600mm x 50mm', unit: 'RMT', qty: 240 },
  { category: 'Electrical Cabling', room: 'Sub runs', description: 'GI Cable Tray 300mm x 50mm', unit: 'RMT', qty: 100 },
  { category: 'Electrical Cabling', room: 'Branches', description: 'GI Cable Tray 100mm x 50mm', unit: 'RMT', qty: 50 },

  // SCADA
  { category: 'SCADA System', room: 'Control Room', description: 'SCADA — PLC/DDC, 10" HMI, remote monitoring, energy & parameter reports', unit: 'set', qty: 1 },

  // Miscellaneous
  { category: 'Miscellaneous', room: 'All rooms', description: 'Panic switches', unit: "No's", qty: 11 },
  { category: 'Miscellaneous', room: 'All rooms', description: 'Door alarms', unit: "No's", qty: 11 },
  { category: 'Miscellaneous', room: 'All rooms', description: 'High-level sensors', unit: "No's", qty: 11 },
  { category: 'Miscellaneous', room: 'All rooms', description: 'Condensate drain pumps', unit: "No's", qty: 8 },
  { category: 'Miscellaneous', room: 'All rooms', description: 'IR thermometers', unit: "No's", qty: 6 },
];

// Floor-plan zones (0..100 coordinate space) for the 2D view.
const ZONES = [
  { zoneName: 'Blast Freezer', boqCategory: 'Refrigeration Units', roomType: 'Blast Freezer (-30C)', heightM: 4, coords: [{ x: 4, y: 6 }, { x: 30, y: 6 }, { x: 30, y: 34 }, { x: 4, y: 34 }] },
  { zoneName: 'Freezer', boqCategory: 'Refrigeration Units', roomType: 'Freezer (-25C)', heightM: 4, coords: [{ x: 32, y: 6 }, { x: 64, y: 6 }, { x: 64, y: 40 }, { x: 32, y: 40 }] },
  { zoneName: 'Chiller', boqCategory: 'Refrigeration Units', roomType: 'Chiller (1-3C)', heightM: 4, coords: [{ x: 66, y: 6 }, { x: 96, y: 6 }, { x: 96, y: 38 }, { x: 66, y: 38 }] },
  { zoneName: 'Ambient', boqCategory: 'Refrigeration Units', roomType: 'Ambient (18C)', heightM: 3.5, coords: [{ x: 4, y: 38 }, { x: 34, y: 38 }, { x: 34, y: 66 }, { x: 4, y: 66 }] },
  { zoneName: 'Cold Anteroom', boqCategory: 'Refrigeration Units', roomType: 'Cold Anteroom (7-10C)', heightM: 3.5, coords: [{ x: 36, y: 44 }, { x: 64, y: 44 }, { x: 64, y: 70 }, { x: 36, y: 70 }] },
  { zoneName: 'Anteroom', boqCategory: 'Refrigeration Units', roomType: 'Anteroom (18-24C)', heightM: 3.5, coords: [{ x: 66, y: 42 }, { x: 96, y: 42 }, { x: 96, y: 70 }, { x: 66, y: 70 }] },
  { zoneName: 'Control Room', boqCategory: 'SCADA System', roomType: 'Control Room', heightM: 3, coords: [{ x: 4, y: 70 }, { x: 96, y: 70 }, { x: 96, y: 94 }, { x: 4, y: 94 }] },
];

async function main() {
  console.log('Seeding CRMCTS...');
  const pw = await bcrypt.hash('Password123', 10);

  // Page-access grant helper: pages is a list of [pageKey, canEdit?].
  const grant = (pages: [string, boolean?][]) =>
    JSON.stringify(Object.fromEntries(pages.map(([k, e]) => [k, { view: true, edit: !!e }])));
  const sect = (s: Record<string, boolean>) => JSON.stringify(s);

  // Demo accounts. Global role is ADMIN | USER (IMS-style). The descriptive
  // per-project role (projectRole) drives in-project workflow semantics and is
  // stored on ProjectMember. USERs get explicit page grants + section perms.
  const SPEC = [
    {
      name: 'Asha Admin', email: 'admin@crmcts.dev', role: 'ADMIN', projectRole: 'ADMIN',
      pageAccess: null as string | null, sectionPerms: null as string | null,
    },
    {
      name: 'Ravi Engineer', email: 'engineer@crmcts.dev', role: 'USER', projectRole: 'ENGINEER',
      pageAccess: grant([['dashboard'], ['boq', true], ['drawing'], ['pay'], ['po'], ['wo'], ['grn', true], ['vendors'], ['documents', true]]),
      sectionPerms: sect({}),
    },
    {
      name: 'Suman Supervisor', email: 'supervisor@crmcts.dev', role: 'USER', projectRole: 'SUPERVISOR',
      pageAccess: grant([['dashboard'], ['boq', true], ['drawing'], ['pay'], ['po'], ['wo'], ['grn', true], ['vendors'], ['documents', true], ['approvals']]),
      sectionPerms: sect({ canApprove: true }),
    },
    {
      name: 'Client User', email: 'client@crmcts.dev', role: 'USER', projectRole: 'CLIENT',
      pageAccess: grant([['dashboard'], ['drawing']]),
      sectionPerms: sect({ hideFinancials: true }),
    },
    {
      name: 'Manish Management', email: 'management@crmcts.dev', role: 'USER', projectRole: 'MANAGEMENT',
      pageAccess: grant([['dashboard'], ['pay'], ['financials'], ['approvals'], ['vendors'], ['documents']]),
      sectionPerms: sect({ canMarkPaid: true }),
    },
  ];

  const users = await Promise.all(
    SPEC.map((u) =>
      prisma.user.upsert({
        where: { email: u.email },
        update: { role: u.role, name: u.name, active: true, pageAccess: u.pageAccess, sectionPerms: u.sectionPerms },
        create: { name: u.name, email: u.email, role: u.role, active: true, pageAccess: u.pageAccess, sectionPerms: u.sectionPerms, passwordHash: pw },
      })
    )
  );
  const admin = users[0];
  const engineer = users[1];
  const supervisor = users[2];
  console.log(`  ✓ ${users.length} demo users (password: Password123)`);

  // Fresh project each seed run (idempotent by name).
  const existing = await prisma.project.findFirst({ where: { name: 'FKI Cold Room Project' } });
  if (existing) {
    await prisma.project.delete({ where: { id: existing.id } });
  }

  const start = new Date();
  start.setDate(start.getDate() - 30);
  const target = new Date();
  target.setDate(target.getDate() + 60);

  const project = await prisma.project.create({
    data: {
      name: 'FKI Cold Room Project',
      clientName: 'FKI Industries',
      siteLocation: 'Plant 2, Industrial Area',
      startDate: start,
      targetCompletionDate: target,
      status: 'ACTIVE',
      createdById: admin.id,
      members: {
        create: users.map((u, i) => ({ userId: u.id, role: SPEC[i].projectRole })),
      },
    },
  });
  console.log(`  ✓ Project: ${project.name}`);

  // Group headers + items
  const categories = [...new Set(BOQ.map((r) => r.category))];
  let order = 0;
  const itemIdByDesc = new Map<string, string>();
  for (const cat of categories) {
    await prisma.bOQItem.create({
      data: { projectId: project.id, description: cat, category: cat, isGroup: true, plannedQty: 0, sortOrder: order++ },
    });
    for (const row of BOQ.filter((r) => r.category === cat)) {
      const item = await prisma.bOQItem.create({
        data: {
          projectId: project.id,
          description: row.description,
          category: row.category,
          roomZone: row.room,
          unit: row.unit,
          plannedQty: row.qty,
          sortOrder: order++,
        },
      });
      itemIdByDesc.set(row.description, item.id);
    }
  }
  console.log(`  ✓ ${BOQ.length} BOQ line items across ${categories.length} categories`);

  // Zones, then link refrigeration-unit items to zones by room
  const allItems = await prisma.bOQItem.findMany({ where: { projectId: project.id, isGroup: false } });
  let zOrder = 0;
  for (const z of ZONES) {
    const zone = await prisma.projectZone.create({
      data: {
        projectId: project.id,
        zoneName: z.zoneName,
        boqCategory: z.boqCategory,
        roomType: z.roomType,
        heightM: z.heightM,
        coordinates: JSON.stringify(z.coords),
        sortOrder: zOrder++,
      },
    });
    // Link any item whose roomZone contains this zone's room name
    const matchKey = z.zoneName.toLowerCase();
    const linkIds = allItems.filter((i) => (i.roomZone ?? '').toLowerCase().includes(matchKey)).map((i) => i.id);
    if (linkIds.length) await prisma.bOQItem.updateMany({ where: { id: { in: linkIds } }, data: { zoneId: zone.id } });
  }
  console.log(`  ✓ ${ZONES.length} floor-plan zones`);

  // Sample approved progress so the dashboard isn't empty.
  const sample: { desc: string; pct: number }[] = [
    { desc: 'Copper refrigerant piping (suction + liquid + insulation)', pct: 0.5 }, // matches several rooms
    { desc: '150mm PUF Panels (Walls/Ceiling)', pct: 0.62 },
    { desc: 'Supply + Install Indoor & Outdoor Units — Blast Freezer', pct: 1.0 },
    { desc: 'Supply + Install Indoor & Outdoor Units — Freezer', pct: 0.75 },
    { desc: 'FRLS Copper Cable', pct: 0.4 },
    { desc: 'Automatic Sliding Door — Freezer 1.8M x 2.1M x 120mm', pct: 0.5 },
  ];
  let entryCount = 0;
  for (const it of allItems) {
    const match = sample.find((s) => it.description.includes(s.desc));
    if (!match || it.plannedQty <= 0) continue;
    const totalQty = Math.round(it.plannedQty * match.pct * 100) / 100;
    if (totalQty <= 0) continue;
    // Spread across a few recent days for a realistic 7-day rate.
    const chunks = 3;
    for (let i = 0; i < chunks; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (chunks - i));
      await prisma.progressEntry.create({
        data: {
          projectId: project.id,
          boqItemId: it.id,
          submittedById: engineer.id,
          approvedById: supervisor.id,
          date: d,
          quantityInstalled: Math.round((totalQty / chunks) * 100) / 100,
          unit: it.unit,
          status: 'APPROVED',
          approvedAt: d,
          remarks: 'Seed sample progress',
        },
      });
      entryCount++;
    }
  }
  // One pending entry to populate the approval queue.
  const pendItem = allItems.find((i) => i.description.includes('Chiller') && i.plannedQty > 0);
  if (pendItem) {
    await prisma.progressEntry.create({
      data: { projectId: project.id, boqItemId: pendItem.id, submittedById: engineer.id, date: new Date(), quantityInstalled: 1, unit: pendItem.unit, status: 'PENDING', remarks: 'Awaiting supervisor approval' },
    });
  }
  console.log(`  ✓ ${entryCount} approved + 1 pending progress entries`);

  console.log('\nSeed complete.\n  Login: admin@crmcts.dev / Password123\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
