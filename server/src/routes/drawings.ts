import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAuth, requireProjectMember, requirePage, requireEdit } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { audit } from '../lib/audit';
import { loadProjectProgress } from '../services/projectProgress';
import { buildFocusedPlan, pickFootprint, pointInPolygon } from '../services/dxfRenderer';
import { classifyRooms, classifyDrawings, extractRoomDetails } from '../services/aiClassify';
import { extractPdfText } from '../services/pdfText';
import { aiProvider } from '../services/boqParser';
import path from 'path';
import fs from 'fs';

const router = Router({ mergeParams: true });
router.use(requireAuth);

// GET .../drawings — list with versions.
router.get(
  '/',
  requireProjectMember,
  requirePage('drawing'),
  asyncHandler(async (req, res) => {
    const drawings = await prisma.drawing.findMany({
      where: { projectId: req.params.projectId },
      orderBy: { uploadedAt: 'desc' },
      include: { uploadedBy: { select: { name: true } } },
    });
    res.json({ drawings });
  })
);

// POST .../drawings — upload PDF/JPG/PNG (FR-DM-01). Versioned per filename.
router.post(
  '/',
  requireProjectMember,
  requireEdit('drawing'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded (field: file)');
    const prior = await prisma.drawing.count({ where: { projectId: req.params.projectId, fileName: req.file.originalname } });
    const drawing = await prisma.drawing.create({
      data: {
        projectId: req.params.projectId,
        fileName: req.file.originalname,
        fileUrl: `/uploads/${req.file.filename}`,
        mimeType: req.file.mimetype,
        fileSize: req.file.size,
        uploadedById: req.user!.sub,
        version: prior + 1,
        status: 'APPROVED',
      },
    });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'DRAWING_UPLOAD', entity: 'Drawing', entityId: drawing.id, details: { file: req.file.originalname } });
    res.status(201).json({ drawing });
  })
);

// ── Zones (2D floor plan polygons) ──────────────────────────────────────────

// GET .../zones — zones with computed colour status derived from linked BOQ
// items (PRD §5.1.3, §11.5).
router.get(
  '/zones',
  requireProjectMember,
  requirePage('drawing'),
  asyncHandler(async (req, res) => {
    const [zones, prog] = await Promise.all([
      prisma.projectZone.findMany({ where: { projectId: req.params.projectId }, orderBy: { sortOrder: 'asc' }, include: { boqItems: { select: { id: true } } } }),
      loadProjectProgress(req.params.projectId),
    ]);
    const out = zones.map((z) => {
      const linked = z.boqItems.map((b) => prog.itemsById.get(b.id)).filter(Boolean) as NonNullable<ReturnType<typeof prog.itemsById.get>>[];
      const planned = linked.reduce((s, i) => s + i.plannedQty, 0);
      const installed = linked.reduce((s, i) => s + i.installedQty, 0);
      const pct = planned > 0 ? Math.round((installed / planned) * 10000) / 100 : 0;
      const color = pct >= 80 ? 'GREEN' : pct >= 20 ? 'YELLOW' : 'RED';
      return {
        id: z.id,
        zoneName: z.zoneName,
        boqCategory: z.boqCategory,
        roomType: z.roomType,
        coordinates: z.coordinates ? JSON.parse(z.coordinates) : null,
        heightM: z.heightM,
        completionPct: pct,
        colorStatus: color,
        linkedItemCount: linked.length,
        lastUpdated: prog.targetCompletionDate, // placeholder, real ts below
      };
    });
    res.json({ zones: out });
  })
);

const zoneSchema = z.object({
  zoneName: z.string().min(1),
  boqCategory: z.string().optional(),
  roomType: z.string().optional(),
  coordinates: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  heightM: z.number().optional(),
  drawingId: z.string().optional(),
  boqItemIds: z.array(z.string()).optional(),
});

// POST .../zones/auto-generate — build a grid of zones straight from the BOQ.
// Groups non-group BOQ items by roomZone (fallback: category), creates one
// rectangular zone per group laid out in a grid (0..100 space), and links the
// items so each zone gets a live completion %. ?replace=true clears first.
const autoSchema = z.object({ groupBy: z.enum(['roomZone', 'category']).optional(), replace: z.boolean().optional(), drawingId: z.string().optional() });
router.post(
  '/zones/auto-generate',
  requireProjectMember,
  requireEdit('drawing'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const body = autoSchema.parse(req.body ?? {});
    const groupBy = body.groupBy ?? 'roomZone';

    const items = await prisma.bOQItem.findMany({ where: { projectId, isGroup: false } });
    if (items.length === 0) throw badRequest('No BOQ items yet — import the BOQ first, then auto-generate zones.');

    // Build groups of itemIds keyed by the chosen field.
    const groups = new Map<string, { key: string; category?: string; itemIds: string[] }>();
    for (const it of items) {
      const key = (groupBy === 'roomZone' ? it.roomZone : it.category) || it.category || 'General';
      const g = groups.get(key) ?? { key, category: it.category ?? undefined, itemIds: [] };
      g.itemIds.push(it.id);
      groups.set(key, g);
    }
    const list = [...groups.values()];

    if (body.replace) {
      await prisma.bOQItem.updateMany({ where: { projectId }, data: { zoneId: null } });
      await prisma.projectZone.deleteMany({ where: { projectId } });
    }

    // Grid layout in 0..100 space with padding.
    const cols = Math.ceil(Math.sqrt(list.length));
    const rows = Math.ceil(list.length / cols);
    const pad = 3;
    const cellW = (100 - pad) / cols;
    const cellH = (100 - pad) / rows;

    let order = 0;
    const created = [];
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const c = i % cols;
      const r = Math.floor(i / cols);
      const x0 = pad + c * cellW;
      const y0 = pad + r * cellH;
      const x1 = x0 + cellW - pad;
      const y1 = y0 + cellH - pad;
      const coords = [ { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 } ];
      const zone = await prisma.projectZone.create({
        data: {
          projectId,
          drawingId: body.drawingId,
          zoneName: g.key,
          boqCategory: g.category,
          roomType: g.key,
          heightM: 3.5,
          coordinates: JSON.stringify(coords),
          sortOrder: order++,
        },
      });
      await prisma.bOQItem.updateMany({ where: { id: { in: g.itemIds }, projectId }, data: { zoneId: zone.id } });
      created.push(zone.id);
    }
    await audit({ userId: req.user!.sub, projectId, action: 'ZONE_AUTOGEN', entity: 'Project', details: { count: created.length, groupBy } });
    res.status(201).json({ ok: true, count: created.length });
  })
);

// POST .../drawings/classify — AI classifies every uploaded diagram into which
// building part/discipline it shows and which rooms it covers (PRD §5.1.2).
router.post(
  '/classify',
  requireProjectMember,
  requireEdit('drawing'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    if (!aiProvider()) throw badRequest('AI is not configured. Set GROQ_API_KEY in server/.env.');

    const drawings = await prisma.drawing.findMany({ where: { projectId }, orderBy: { uploadedAt: 'desc' } });
    if (drawings.length === 0) throw badRequest('No drawings uploaded yet.');

    // Room list: prefer existing zones, else BOQ rooms/categories.
    const zones = await prisma.projectZone.findMany({ where: { projectId }, select: { zoneName: true } });
    let roomList = zones.map((z) => z.zoneName);
    if (roomList.length === 0) {
      const items = await prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, select: { roomZone: true, category: true } });
      roomList = [...new Set(items.map((i) => i.roomZone || i.category).filter(Boolean) as string[])];
    }

    // Build per-drawing hints: read PDF text content so the AI can map each
    // diagram to the SPECIFIC rooms it shows (not just "All").
    const withHints = await Promise.all(
      drawings.map(async (d) => {
        let hint = '';
        const fp = path.resolve(process.cwd(), 'uploads', path.basename(d.fileUrl));
        if (d.fileName.toLowerCase().endsWith('.pdf') && fs.existsSync(fp)) {
          hint = await extractPdfText(fp);
        } else if (d.fileName.toLowerCase().endsWith('.dxf') && d.extractedZones) {
          // Feed the DXF's identified room names so it classifies properly.
          try {
            const meta = JSON.parse(d.extractedZones);
            const names = (meta.rooms || []).map((r: any) => r.name).filter(Boolean);
            hint = `DXF architectural floor plan. Identified rooms: ${names.join(', ')}.`;
          } catch { /* ignore */ }
        }
        return { id: d.id, fileName: d.fileName, hint };
      })
    );

    const result = await classifyDrawings(withHints, roomList);
    if (!result) throw badRequest('AI classification failed. Check the API key and try again.');

    // Persist classification onto each drawing.
    const byId = new Map(result.map((r) => [r.id, r]));
    await Promise.all(
      drawings.map((d) => {
        const c = byId.get(d.id);
        if (!c) return Promise.resolve();
        return prisma.drawing.update({ where: { id: d.id }, data: { classification: JSON.stringify(c) } });
      })
    );

    // If a section/elevation drawing reveals more floors, update the analyzed
    // DXF's facility summary so the floor count reflects the full drawing set.
    const maxFloors = Math.max(1, ...result.map((r) => r.floors ?? 0));
    if (maxFloors > 1) {
      const dxf = await prisma.drawing.findFirst({ where: { projectId, extractedZones: { not: null } } });
      if (dxf?.extractedZones) {
        const meta = JSON.parse(dxf.extractedZones);
        if (meta.facility && meta.facility.floors < maxFloors) {
          meta.facility.floors = maxFloors;
          meta.facility.floorsBasis = `Detected ${maxFloors} levels from the section/elevation drawing.`;
          await prisma.drawing.update({ where: { id: dxf.id }, data: { extractedZones: JSON.stringify(meta) } });
        }
      }
    }

    await audit({ userId: req.user!.sub, projectId, action: 'DRAWINGS_CLASSIFY', entity: 'Project', details: { count: result.length, provider: aiProvider(), maxFloors } });
    res.json({ ok: true, provider: aiProvider(), classified: result.length, floors: maxFloors, drawings: result });
  })
);

// POST .../drawings/:drawingId/analyze — AI-assisted drawing analysis (§5.1.2).
// Renders the real DXF floor plan (focused on the room cluster), asks the AI
// to identify & classify the rooms, positions them on the REAL geometry, links
// BOQ items, and saves the plan SVG for the "Real Plan" view.
router.post(
  '/:drawingId/analyze',
  requireProjectMember,
  requireEdit('drawing'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const drawing = await prisma.drawing.findFirst({ where: { id: req.params.drawingId, projectId } });
    if (!drawing) throw notFound('Drawing not found');

    const filePath = path.resolve(process.cwd(), 'uploads', path.basename(drawing.fileUrl));
    if (!fs.existsSync(filePath)) throw badRequest('Drawing file is missing on the server.');
    if (!filePath.toLowerCase().endsWith('.dxf')) {
      throw badRequest('AI drawing analysis currently supports DXF files. For PDF/image drawings, use “Manage Zones”.');
    }
    if (!aiProvider()) throw badRequest('AI is not configured. Set GROQ_API_KEY (or ANTHROPIC_API_KEY) in server/.env.');

    // 1. Render the focused REAL floor plan (walls) + room-label cluster.
    const plan = buildFocusedPlan(filePath);
    if (plan.roomLabels.length === 0) throw badRequest('No room labels found in the drawing to identify from.');

    // 2. AI: classify the room-cluster labels into rooms (Groq).
    const boqCats = (await prisma.bOQItem.findMany({ where: { projectId, isGroup: false }, select: { category: true }, distinct: ['category'] }))
      .map((c) => c.category).filter(Boolean) as string[];
    const rooms = await classifyRooms(plan.roomLabels.map((l) => l.text), boqCats);
    if (!rooms || rooms.length === 0) throw badRequest('The AI could not identify any rooms from the drawing labels.');

    // 3. Recover each room's REAL world coordinates by matching back to a label.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const pool = plan.roomLabels.length ? plan.roomLabels : plan.allLabels;
    type Placed = { room: typeof rooms[number]; x: number; y: number };
    const placed: Placed[] = [];
    const usedKeys = new Set<string>();
    for (const room of rooms) {
      const target = norm(room.matchText);
      let lbl = pool.find((l) => norm(l.text) === target && !usedKeys.has(`${l.x},${l.y}`));
      if (!lbl) lbl = pool.find((l) => (norm(l.text).includes(target) || target.includes(norm(l.text))) && !usedKeys.has(`${l.x},${l.y}`));
      if (!lbl) lbl = pool.find((l) => norm(l.text).includes(norm(room.roomName)) && !usedKeys.has(`${l.x},${l.y}`));
      if (lbl) { usedKeys.add(`${lbl.x},${lbl.y}`); placed.push({ room, x: lbl.x, y: lbl.y }); }
    }
    if (placed.length === 0) throw badRequest('Could not align identified rooms back to drawing coordinates.');

    // 4. Normalize world coords → 0..100 (flip Y) for the schematic 2D/3D views.
    const { crop } = plan;
    const spanX = crop.x1 - crop.x0 || 1, spanY = crop.y1 - crop.y0 || 1;
    const nx = (x: number) => 4 + ((x - crop.x0) / spanX) * 92;
    const ny = (y: number) => 4 + ((crop.y1 - y) / spanY) * 92; // flip
    const areas = placed.map((p) => p.room.areaSqFt).filter((a): a is number => a != null && a > 0);
    const maxArea = areas.length ? Math.max(...areas) : 0;
    const sizeFor = (a: number | null) => (!a || !maxArea ? 11 : 8 + Math.sqrt(a / maxArea) * 16);

    // 5. Replace existing zones — this drawing analysis is authoritative.
    if (req.body?.replace !== false) {
      await prisma.bOQItem.updateMany({ where: { projectId }, data: { zoneId: null } });
      await prisma.projectZone.deleteMany({ where: { projectId } });
    }

    let order = 0;
    const roomMeta: any[] = [];
    for (const p of placed) {
      // Try to find the room's REAL footprint polygon from the drawing geometry.
      const footWorld = pickFootprint(p.x, p.y, plan.roomPolys, plan.cropArea);
      let coords: { x: number; y: number }[];
      if (footWorld && footWorld.length >= 4) {
        // Normalize the real polygon into 0..100 schematic space (flip Y).
        coords = footWorld.map((v) => ({ x: nx(v[0]), y: ny(v[1]) }));
      } else {
        // Fallback: area-sized box around the label.
        const cx = nx(p.x), cy = ny(p.y);
        const half = sizeFor(p.room.areaSqFt) / 2;
        coords = [
          { x: Math.max(cx - half, 1), y: Math.max(cy - half, 1) },
          { x: Math.min(cx + half, 99), y: Math.max(cy - half, 1) },
          { x: Math.min(cx + half, 99), y: Math.min(cy + half, 99) },
          { x: Math.max(cx - half, 1), y: Math.min(cy + half, 99) },
        ];
      }
      const zone = await prisma.projectZone.create({
        data: {
          projectId, drawingId: drawing.id,
          zoneName: p.room.roomName,
          boqCategory: p.room.category || undefined,
          roomType: p.room.roomType || p.room.roomName,
          heightM: 3.5,
          coordinates: JSON.stringify(coords),
          sortOrder: order++,
        },
      });
      const kw = norm(p.room.roomName).split(' ')[0];
      const link = await prisma.bOQItem.findMany({
        where: {
          projectId, isGroup: false,
          OR: [
            ...(p.room.category ? [{ category: p.room.category }] : []),
            { roomZone: { contains: kw } },
            { description: { contains: kw } },
          ],
        },
        select: { id: true },
      });
      if (link.length) await prisma.bOQItem.updateMany({ where: { id: { in: link.map((l) => l.id) } }, data: { zoneId: zone.id } });
      roomMeta.push({
        zoneId: zone.id, name: zone.zoneName, category: zone.boqCategory, roomType: zone.roomType,
        worldX: p.x, worldY: p.y, areaSqFt: p.room.areaSqFt, linked: link.length,
        footprint: footWorld && footWorld.length >= 4 ? footWorld.map((v) => [Math.round(v[0] * 10) / 10, Math.round(v[1] * 10) / 10]) : null,
      });
    }

    // 5b. Extract rich per-room details (area, pallets, equipment) + facility
    // summary (floors, totals) from the text labels inside each room.
    const cropSpan = Math.max(plan.crop.x1 - plan.crop.x0, plan.crop.y1 - plan.crop.y0);
    const roomsForDetail = roomMeta.map((rm) => {
      let inside;
      if (rm.footprint && rm.footprint.length >= 4) {
        inside = plan.allLabels.filter((l) => pointInPolygon(l.x, l.y, rm.footprint));
      } else {
        const R = cropSpan * 0.08;
        inside = plan.allLabels.filter((l) => Math.abs(l.x - rm.worldX) < R && Math.abs(l.y - rm.worldY) < R);
      }
      return { name: rm.name, labels: inside.map((l) => l.text) };
    });
    let facility: any = null;
    const details = await extractRoomDetails(roomsForDetail, plan.allLabels.map((l) => l.text));
    if (details) {
      facility = details.facility;
      const norm2 = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const rm of roomMeta) {
        const d = details.rooms.find((r) => norm2(r.name) === norm2(rm.name)) || details.rooms.find((r) => norm2(r.name).includes(norm2(rm.name)) || norm2(rm.name).includes(norm2(r.name)));
        rm.details = d || null;
      }
    }

    // 6. Save the focused plan SVG paths to disk for the "Real Plan" view.
    const planFile = `${drawing.id}_plan.svg`;
    fs.writeFileSync(path.resolve(process.cwd(), 'uploads', planFile), plan.pathsMarkup);

    await prisma.drawing.update({
      where: { id: drawing.id },
      data: { status: 'APPROVED', extractedZones: JSON.stringify({ viewBox: plan.viewBox, planFile, pathCount: plan.pathCount, rooms: roomMeta, facility }) },
    });
    await audit({ userId: req.user!.sub, projectId, action: 'DRAWING_ANALYZE', entity: 'Drawing', entityId: drawing.id, details: { labels: plan.allLabels.length, rooms: rooms.length, zones: roomMeta.length, paths: plan.pathCount, provider: aiProvider() } });

    res.status(201).json({
      ok: true,
      provider: aiProvider(),
      labelsFound: plan.allLabels.length,
      roomsIdentified: rooms.length,
      zonesCreated: roomMeta.length,
      wallPaths: plan.pathCount,
      zones: roomMeta.map((r) => ({ id: r.zoneId, name: r.name, category: r.category, linked: r.linked })),
    });
  })
);

// GET .../drawings/:drawingId/floorplan — real rendered plan + room overlays
// with live completion, for the "Real Plan" view.
router.get(
  '/:drawingId/floorplan',
  requireProjectMember,
  requirePage('drawing'),
  asyncHandler(async (req, res) => {
    const projectId = req.params.projectId;
    const drawing = await prisma.drawing.findFirst({ where: { id: req.params.drawingId, projectId } });
    if (!drawing) throw notFound('Drawing not found');
    if (!drawing.extractedZones) throw badRequest('This drawing has not been analyzed yet. Click “Analyze with AI”.');

    const meta = JSON.parse(drawing.extractedZones);
    const planPath = path.resolve(process.cwd(), 'uploads', meta.planFile);
    const pathsMarkup = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';

    // Live completion per room via its linked zone.
    const prog = await loadProjectProgress(projectId);
    const zones = await prisma.projectZone.findMany({ where: { projectId }, include: { boqItems: { select: { id: true } } } });
    const zoneCompletion = (zoneId: string) => {
      const z = zones.find((q) => q.id === zoneId);
      if (!z) return { pct: 0, color: 'RED' as const };
      const linked = z.boqItems.map((b) => prog.itemsById.get(b.id)).filter(Boolean) as NonNullable<ReturnType<typeof prog.itemsById.get>>[];
      const planned = linked.reduce((s, i) => s + i.plannedQty, 0);
      const installed = linked.reduce((s, i) => s + i.installedQty, 0);
      const pct = planned > 0 ? Math.round((installed / planned) * 1000) / 10 : 0;
      return { pct, color: pct >= 80 ? 'GREEN' as const : pct >= 20 ? 'YELLOW' as const : 'RED' as const };
    };

    const rooms = (meta.rooms || []).map((r: any) => {
      const c = zoneCompletion(r.zoneId);
      return { zoneId: r.zoneId, name: r.name, category: r.category, roomType: r.roomType, worldX: r.worldX, worldY: r.worldY, footprint: r.footprint ?? null, areaSqFt: r.details?.areaSqFt ?? r.areaSqFt, details: r.details ?? null, linkedItemCount: r.linked, completionPct: c.pct, colorStatus: c.color };
    });

    res.json({ viewBox: meta.viewBox, pathCount: meta.pathCount, pathsMarkup, rooms, facility: meta.facility ?? null });
  })
);

router.post(
  '/zones',
  requireProjectMember,
  requireEdit('drawing'),
  asyncHandler(async (req, res) => {
    const body = zoneSchema.parse(req.body);
    const max = await prisma.projectZone.aggregate({ where: { projectId: req.params.projectId }, _max: { sortOrder: true } });
    const zone = await prisma.projectZone.create({
      data: {
        projectId: req.params.projectId,
        drawingId: body.drawingId,
        zoneName: body.zoneName,
        boqCategory: body.boqCategory,
        roomType: body.roomType,
        coordinates: body.coordinates ? JSON.stringify(body.coordinates) : null,
        heightM: body.heightM,
        sortOrder: (max._max.sortOrder ?? 0) + 1,
      },
    });
    if (body.boqItemIds?.length) {
      await prisma.bOQItem.updateMany({ where: { id: { in: body.boqItemIds }, projectId: req.params.projectId }, data: { zoneId: zone.id } });
    }
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ZONE_CREATE', entity: 'ProjectZone', entityId: zone.id });
    res.status(201).json({ zone });
  })
);

router.patch(
  '/zones/:zoneId',
  requireProjectMember,
  requireEdit('drawing'),
  asyncHandler(async (req, res) => {
    const body = zoneSchema.partial().parse(req.body);
    const zone = await prisma.projectZone.update({
      where: { id: req.params.zoneId },
      data: {
        ...(body.zoneName !== undefined && { zoneName: body.zoneName }),
        ...(body.boqCategory !== undefined && { boqCategory: body.boqCategory }),
        ...(body.roomType !== undefined && { roomType: body.roomType }),
        ...(body.heightM !== undefined && { heightM: body.heightM }),
        ...(body.coordinates !== undefined && { coordinates: JSON.stringify(body.coordinates) }),
      },
    });
    if (body.boqItemIds) {
      await prisma.bOQItem.updateMany({ where: { id: { in: body.boqItemIds }, projectId: req.params.projectId }, data: { zoneId: zone.id } });
    }
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ZONE_UPDATE', entity: 'ProjectZone', entityId: zone.id });
    res.json({ zone });
  })
);

router.delete(
  '/zones/:zoneId',
  requireProjectMember,
  requireEdit('drawing'),
  asyncHandler(async (req, res) => {
    await prisma.bOQItem.updateMany({ where: { zoneId: req.params.zoneId }, data: { zoneId: null } });
    await prisma.projectZone.delete({ where: { id: req.params.zoneId } });
    await audit({ userId: req.user!.sub, projectId: req.params.projectId, action: 'ZONE_DELETE', entity: 'ProjectZone', entityId: req.params.zoneId });
    res.json({ ok: true });
  })
);

export default router;
