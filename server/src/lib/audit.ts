import { prisma } from './prisma';

// Append-only audit trail (PRD §8.2). Never throws into the request path.
export async function audit(params: {
  userId?: string | null;
  projectId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  details?: unknown;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        projectId: params.projectId ?? null,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        details: params.details ? JSON.stringify(params.details) : null,
      },
    });
  } catch (err) {
    // Auditing must not break the operation it records.
    console.error('[audit] failed to write log:', err);
  }
}
