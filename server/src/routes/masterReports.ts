import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { requireAuth, requirePage, requireFinancialView } from '../middleware/authMiddleware';
import { isAdmin } from '../lib/enums';
import { buildProcurementRegister, buildVendorOutstanding } from '../services/procurementRegister';

// Cross-project ("master") reports. Global — NOT project-scoped — so the whole
// group's procurement register is visible in one place. Financials are gated the
// same as the per-project register (requireFinancialView).
const router = Router();
router.use(requireAuth);

// GET /api/reports/master/procurement-register — every project's PO/WO register
// in one payload, each row carrying its project. Admin sees all projects;
// everyone else sees only the projects they are a member of.
router.get('/master/procurement-register', requirePage('reports'), requireFinancialView, asyncHandler(async (req, res) => {
  const me = req.account!;
  const projectIds = isAdmin(me.role)
    ? (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id)
    : (await prisma.projectMember.findMany({ where: { userId: me.id }, select: { projectId: true } })).map((m) => m.projectId);
  res.json(await buildProcurementRegister(projectIds));
}));

// GET /api/reports/master/vendor-outstanding — how much each vendor is owed
// across ALL accessible projects (same vendor aggregated group-wide).
router.get('/master/vendor-outstanding', requirePage('reports'), requireFinancialView, asyncHandler(async (req, res) => {
  const me = req.account!;
  const projectIds = isAdmin(me.role)
    ? (await prisma.project.findMany({ select: { id: true } })).map((p) => p.id)
    : (await prisma.projectMember.findMany({ where: { userId: me.id }, select: { projectId: true } })).map((m) => m.projectId);
  res.json({ vendors: await buildVendorOutstanding(projectIds) });
}));

export default router;
