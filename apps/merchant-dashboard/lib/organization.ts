// lib/organization.ts — P1-17 switch core (Next-free, unit-testable).
//
// Contract (plan §10.3/§10.5, approved C-D13/C-D22b):
//  - The candidate org id is UNVERIFIED CLIENT INPUT: membership AND
//    eligibility (≥1 accessible ACTIVE location) are verified server-side;
//    failure = uniform DomainError, NO state change, NO audit (C-AC34).
//  - The session update is CONDITIONAL on `expiresAt > now` — an expired
//    session can never be resurrected (C-AC40). No token rotation, no expiry
//    change (C-D14).
//  - A successful switch writes exactly ONE SWITCH_ORG audit in the TARGET
//    org, IN THE SAME TRANSACTION as the session update (C-D22b). The
//    previous org is the EFFECTIVE session organization resolved under
//    §10.2 — the action passes `fromOrganizationId` from getSessionContext,
//    never the raw nullable/stale `Session.activeOrganizationId`.
import { DomainError, logAuditEvent } from "@via-saas/core"
import { prisma } from "@via-saas/database"

export async function performOrganizationSwitch(params: {
  token: string
  userId: string
  /** Effective session organization resolved under §10.2 (from getSessionContext). */
  fromOrganizationId: string
  targetOrganizationId: string
}): Promise<void> {
  const { token, userId, fromOrganizationId, targetOrganizationId } = params

  // 1. Server-side membership + eligibility verification — the
  //    client-supplied id is untrusted. Uniform error for nonexistent AND
  //    ineligible targets (no state change, no audit).
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: targetOrganizationId },
    },
    include: {
      organization: { include: { stores: { include: { locations: true } } } },
    },
  })
  const eligible =
    membership &&
    membership.organization.stores
      .flatMap((store) => store.locations)
      .some(
        (loc) =>
          !loc.archivedAt &&
          (membership.allowedLocationIds.length === 0 ||
            membership.allowedLocationIds.includes(loc.id))
      )
  if (!eligible) {
    throw new DomainError("FORBIDDEN", "You do not have access to that organization.")
  }

  // 2. Conditional session update + audit, ONE transaction (C-D22b).
  await prisma.$transaction(async (tx) => {
    const updated = await tx.session.updateMany({
      where: { token, expiresAt: { gt: new Date() } },
      data: { activeOrganizationId: targetOrganizationId },
    })
    if (updated.count === 0) {
      // Expired between resolution and the write — no resurrect, no audit.
      throw new DomainError("FORBIDDEN", "Your session has expired. Please log in again.")
    }

    await logAuditEvent(
      targetOrganizationId,
      userId,
      "SWITCH_ORG",
      targetOrganizationId,
      { fromOrganizationId, toOrganizationId: targetOrganizationId },
      tx
    )
  })
}
