import { prisma } from "@via-saas/database"
import { AuditAction } from "@prisma/client"

export async function logAuditEvent(
  orgId: string,
  actorId: string,
  action: AuditAction,
  targetId?: string,
  metadata?: any
) {
  // Append-only: We do not have UPDATE or DELETE functions for AuditLog
  await prisma.auditLog.create({
    data: {
      organizationId: orgId,
      actorId,
      action,
      targetId,
      metadata: metadata || {},
    }
  })
}
