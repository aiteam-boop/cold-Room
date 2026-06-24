import { prisma } from '../lib/prisma';

interface NotifyPayload {
  type: string;
  title: string;
  message: string;
  projectId?: string | null;
  relatedDocType?: string;
  relatedDocId?: string;
  link?: string;
}

// Create a notification for a single user.
export async function notifyUser(userId: string, p: NotifyPayload) {
  if (!userId) return;
  try {
    await prisma.notification.create({ data: { userId, type: p.type, title: p.title, message: p.message, projectId: p.projectId ?? null, relatedDocType: p.relatedDocType, relatedDocId: p.relatedDocId, link: p.link } });
  } catch (e) {
    console.error('[notify] failed:', e);
  }
}

// Notify every project member holding one of the given roles (plus global
// ADMINs), excluding the actor. Used for "send to approvers / accounts" etc.
export async function notifyProjectRoles(projectId: string, roles: string[], p: NotifyPayload, excludeUserId?: string) {
  try {
    const members = await prisma.projectMember.findMany({ where: { projectId, role: { in: roles } }, select: { userId: true } });
    const globalAdmins = roles.includes('ADMIN')
      ? await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      : [];
    const ids = new Set<string>();
    for (const m of members) ids.add(m.userId);
    for (const a of globalAdmins) ids.add(a.id);
    if (excludeUserId) ids.delete(excludeUserId);
    await Promise.all([...ids].map((userId) => notifyUser(userId, { ...p, projectId })));
  } catch (e) {
    console.error('[notifyProjectRoles] failed:', e);
  }
}
