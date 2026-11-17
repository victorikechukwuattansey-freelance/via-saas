// packages/core/src/staff.ts
// P1-14 — Staff and membership management (P1-C).
//
// Owner-approved decisions implemented here:
//  - C-D1b: role values are a TS union backed by the DB CHECK
//    `membership_role_canonical` (migration 20261116130000).
//  - C-D2a: staff administration is OWNER-only (enforced HERE, in core, and
//    again at the action layer — two-layer pattern, neither trusted alone).
//  - C-D3a/C-D17a: ALL self-targeting mutations are blocked (removal, role
//    change, location-scope change) — closes the C14 owner self-lockout path.
//  - C-D4a: removal HARD-DELETES the Membership row with an audit snapshot;
//    nothing references Membership (verified), so no business history is
//    touched and sessions lose access through resolution failure.
//  - C-D19a: OWNER grants via edit are permitted — the actor must already be
//    OWNER to reach this function, so promotion is an authenticated act.
//  - C15/L1: every mutation takes the per-org advisory transaction lock
//    FIRST, re-reads owner state INSIDE the lock, and writes conditionally —
//    concurrent last-owner removal/demotion cannot drop the final OWNER.
//
// Audit (section 12): UPDATE_STAFF / REMOVE_STAFF, authenticated actor only,
// in the SAME transaction as the mutation, never a synthetic actor.

import { Prisma } from "@prisma/client"
import { prisma } from "@via-saas/database"
import { logAuditEvent } from "./audit"
import { DomainError } from "./errors"

/** C-D1: the canonical role set — application-level gate for the DB CHECK. */
export const CANONICAL_ROLES = ["OWNER", "MANAGER", "STAFF"] as const
export type CanonicalRole = (typeof CANONICAL_ROLES)[number]

export function isCanonicalRole(value: unknown): value is CanonicalRole {
  return (
    typeof value === "string" &&
    (CANONICAL_ROLES as readonly string[]).includes(value)
  )
}

export type StaffMemberView = {
  membershipId: string
  userId: string
  name: string
  email: string
  role: CanonicalRole
  allowedLocationIds: string[]
}

/**
 * Acquires the per-org administrative advisory lock (L1) inside the current
 * transaction. All competing administrative mutations use the SAME protocol,
 * so owner-count and active-location-count guards are race-free; the lock is
 * released automatically at commit/rollback.
 */
async function acquireOrgLock(tx: Prisma.TransactionClient, orgId: string) {
  // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns void, which
  // Prisma cannot deserialize into a result set.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 0))`
}

/** Owner-only gate enforced in core (C-D2a): returns the caller's membership. */
async function requireOwnerMembership(orgId: string, actorId: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: actorId, organizationId: orgId } },
    select: { id: true, role: true },
  })
  if (!membership) {
    throw new DomainError("FORBIDDEN", "You are not authorized to manage staff.")
  }
  if (membership.role !== "OWNER") {
    throw new DomainError("FORBIDDEN", "Only Owners can manage staff.")
  }
  return membership
}

/**
 * Lists the organization's staff (OWNER only). Org-scoped by construction;
 * exposes name/email — the caller (dashboard settings) is OWNER-gated.
 */
export async function listStaffMembers(
  orgId: string,
  actorId: string
): Promise<StaffMemberView[]> {
  await requireOwnerMembership(orgId, actorId)

  const memberships = await prisma.membership.findMany({
    where: { organizationId: orgId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { id: "asc" },
  })

  return memberships.map((m) => ({
    membershipId: m.id,
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role as CanonicalRole,
    allowedLocationIds: m.allowedLocationIds,
  }))
}

/**
 * Validates an allowedLocationIds list: every id must be an ACTIVE location
 * of the organization (archived locations can never be granted, C-AC5;
 * cross-org ids fail closed with the uniform no-leak error).
 */
async function validateLocationScope(orgId: string, allowedLocationIds: string[]) {
  if (!Array.isArray(allowedLocationIds) || allowedLocationIds.some((id) => typeof id !== "string")) {
    throw new DomainError("VALIDATION", "Invalid location scope.")
  }
  const unique = Array.from(new Set(allowedLocationIds))
  if (unique.length === 0) return [] // empty = all ACTIVE locations (expansion rule)
  const active = await prisma.location.findMany({
    where: { id: { in: unique }, store: { organizationId: orgId }, archivedAt: null },
    select: { id: true },
  })
  if (active.length !== unique.length) {
    throw new DomainError("FORBIDDEN", "Invalid location for this business.")
  }
  return unique
}

/**
 * Updates a member's role and/or location scope (OWNER only).
 *
 * Guards, in order, inside the L1-serialized transaction:
 *   1. self-mutation blocked (C-D3/C-D17 — one uniform rule),
 *   2. canonical role validation (C-D1),
 *   3. last-owner demotion guard: the owner count is RE-READ inside the lock
 *      (defense-in-depth: the conditional write keeps its state predicate).
 */
export async function updateStaffMember(
  orgId: string,
  actorId: string,
  membershipId: string,
  data: { role: CanonicalRole; allowedLocationIds?: string[] }
): Promise<StaffMemberView> {
  await requireOwnerMembership(orgId, actorId)

  if (!isCanonicalRole(data.role)) {
    throw new DomainError("VALIDATION", "Role must be OWNER, MANAGER, or STAFF.")
  }
  const allowedLocationIds = await validateLocationScope(orgId, data.allowedLocationIds ?? [])

  return prisma.$transaction(async (tx) => {
    await acquireOrgLock(tx, orgId)

    const target = await tx.membership.findFirst({
      where: { id: membershipId, organizationId: orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    // Uniform no-leak error: cross-org ids are indistinguishable from
    // nonexistent ones.
    if (!target) {
      throw new DomainError("NOT_FOUND", "Staff member not found.")
    }

    // C-D3/C-D17: no staff-management operation may target the actor's own
    // membership (role change or location strip) — the single-owner org's
    // owner cannot lock themselves out; multi-owner orgs mutate each other.
    if (target.userId === actorId) {
      throw new DomainError("FORBIDDEN", "You cannot modify your own staff record.")
    }

    // Last-owner demotion guard (C-AC6): re-read INSIDE the lock.
    if (target.role === "OWNER" && data.role !== "OWNER") {
      const ownerCount = await tx.membership.count({
        where: { organizationId: orgId, role: "OWNER" },
      })
      if (ownerCount <= 1) {
        throw new DomainError(
          "VALIDATION",
          "Cannot demote the last Owner of the organization."
        )
      }
    }

    const before = { role: target.role, allowedLocationIds: target.allowedLocationIds }
    const after = { role: data.role, allowedLocationIds }

    const updated = await tx.membership.update({
      where: { id: target.id },
      data: { role: data.role, allowedLocationIds },
    })

    // Exactly one UPDATE_STAFF audit, atomic with the write (C-AC11).
    await logAuditEvent(
      orgId,
      actorId,
      "UPDATE_STAFF",
      target.id,
      { before, after },
      tx
    )

    return {
      membershipId: updated.id,
      userId: target.user.id,
      name: target.user.name,
      email: target.user.email,
      role: updated.role as CanonicalRole,
      allowedLocationIds: updated.allowedLocationIds,
    }
  })
}

/**
 * Removes a member (OWNER only). Hard-deletes the Membership row (C-D4a)
 * with a full audit snapshot; User, sessions, and all historical attribution
 * survive intact — nothing references Membership (verified against the
 * schema), and access ends through session-resolution failure.
 */
export async function removeStaffMember(
  orgId: string,
  actorId: string,
  membershipId: string,
  options?: { reason?: string }
): Promise<void> {
  await requireOwnerMembership(orgId, actorId)

  const reason = options?.reason
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    throw new DomainError("VALIDATION", "Invalid removal reason.")
  }

  await prisma.$transaction(async (tx) => {
    await acquireOrgLock(tx, orgId)

    const target = await tx.membership.findFirst({
      where: { id: membershipId, organizationId: orgId },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    if (!target) {
      throw new DomainError("NOT_FOUND", "Staff member not found.")
    }

    // C-D3a: self-removal is blocked outright ("leave organization" is a
    // future flow); same uniform rule as C-D17 for edits.
    if (target.userId === actorId) {
      throw new DomainError("FORBIDDEN", "You cannot remove your own membership.")
    }

    // Last-owner removal guard (C-AC6/C-AC7): re-read INSIDE the lock.
    if (target.role === "OWNER") {
      const ownerCount = await tx.membership.count({
        where: { organizationId: orgId, role: "OWNER" },
      })
      if (ownerCount <= 1) {
        throw new DomainError(
          "VALIDATION",
          "Cannot remove the last Owner of the organization."
        )
      }
    }

    // Snapshot BEFORE the delete — the audit row is the durable record of
    // who was removed and what their access was (C-AC9).
    await logAuditEvent(
      orgId,
      actorId,
      "REMOVE_STAFF",
      target.id,
      {
        userId: target.userId,
        email: target.user.email,
        role: target.role,
        allowedLocationIds: target.allowedLocationIds,
        ...(reason !== undefined ? { reason } : {}),
      },
      tx
    )

    await tx.membership.delete({ where: { id: target.id } })
  })
}
