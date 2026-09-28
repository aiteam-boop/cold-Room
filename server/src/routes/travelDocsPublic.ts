import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { asyncHandler } from '../lib/errors';
import { buildTravelDocsPdf } from '../services/travelDocs';

// Public, no-login combined-documents PDF for a trip — the link put on the
// "Travel Account FMS" sheet so the FMS team can open every bill/proof in one
// PDF. Read-only; keyed by an unguessable per-trip token.
const router = Router();

router.get('/:token', asyncHandler(async (req, res) => {
  const plan = await prisma.travelPlan.findFirst({ where: { docsToken: req.params.token }, select: { id: true } });
  if (!plan) { res.status(404).send('<p style="font-family:sans-serif;padding:40px;text-align:center">This documents link is invalid or expired.</p>'); return; }
  const out = await buildTravelDocsPdf(plan.id);
  if (!out) { res.status(404).send('Not found'); return; }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${out.planNumber}-documents.pdf"`);
  res.send(out.buffer);
}));

export default router;
