import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { asyncHandler, badRequest, conflict, unauthorized } from '../lib/errors';
import { hashPassword, verifyPassword, signToken, validatePassword } from '../lib/auth';
import { requireAuth } from '../middleware/authMiddleware';
import { audit } from '../lib/audit';
import { parseGrants, parseSections } from '../lib/permissions';
import { isDprOwner } from '../lib/dprAccess';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string(),
});

function publicUser(u: {
  id: string; name: string; email: string; role: string;
  active?: boolean; pageAccess?: string | null; sectionPerms?: string | null;
}) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    active: u.active ?? true,
    pageAccess: parseGrants(u.pageAccess),
    sectionPerms: parseSections(u.sectionPerms),
    // Room-wise DPR is limited to specific owner accounts, not all admins.
    dprOwner: isDprOwner(u.email),
  };
}

// POST /api/auth/register — open self-registration creates a plain USER with NO
// page grants (signs in but sees nothing until an admin grants access). Admins
// provision real accounts via /api/users.
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const pwErr = validatePassword(body.password);
    if (pwErr) throw badRequest(pwErr);

    const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) throw conflict('An account with that email already exists');

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email.toLowerCase(),
        passwordHash: await hashPassword(body.password),
        role: 'USER',
      },
    });
    await audit({ userId: user.id, action: 'USER_REGISTER', entity: 'User', entityId: user.id });
    const token = signToken({ sub: user.id, email: user.email, role: user.role as never, name: user.name });
    res.status(201).json({ token, user: publicUser(user) });
  })
);

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user) throw unauthorized('Invalid email or password');
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) throw unauthorized('Invalid email or password');
    if (!user.active) throw unauthorized('Your account has been deactivated. Contact an administrator.');

    await audit({ userId: user.id, action: 'USER_LOGIN', entity: 'User', entityId: user.id });
    const token = signToken({ sub: user.id, email: user.email, role: user.role as never, name: user.name });
    res.json({ token, user: publicUser(user) });
  })
);

// GET /api/auth/me — current user from token.
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub } });
    if (!user) throw unauthorized();
    if (!user.active) throw unauthorized('Account is deactivated');
    res.json({ user: publicUser(user) });
  })
);

export default router;
