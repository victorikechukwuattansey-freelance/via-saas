// packages/core/src/locations.ts
// P1-16 — Location lifecycle (P1-C): create, rename, archive, restore, list.
//
// Owner-approved decisions implemented here:
//  - C-D9a: location administration is OWNER-only (core-level gate, same
//    two-layer pattern as staff administration).
//  - C-D10a: archiving the LAST ACTIVE location is rejected — an
//    organization always keeps at least one active location.
//  - C-D11a: per-store name uniqueness is DB-enforced
//    (`Location_storeId_name_key`, migration 20261116130001) with an
//    application-level pre-check for a readable error.
//  - C18: every automatic-selection listing orders deterministically
//    (createdAt, then id).
//  - Archive semantics (section 9.2): soft deactivation ONLY — inventory,
//    orders, movements, and carts are never touched; RETURN-after-archive
//    (C8/C16) is intentionally unrestricted in cancelOrder.
//  - C15/L1: archive/restore/create/rename take the per-org advisory lock
//    FIRST and re-read the active-location count INSIDE the lock (two
//    concurrent archives of the last two active locations → exactly one
//    succeeds, C-AC59).
//
// Audit (section 12): CREATE_LOCATION / UPDATE_LOCATION / ARCHIVE_LOCATION,
// authenticated actor, in the SAME transaction as the mutation.

import { Prisma } from "@prisma/client"
import { prisma } from "@via-saas/database"
import { logAuditEvent } from "./audit"
import { DomainError } from "./errors"

async function acquireOrgLock(tx: Prisma.TransactionClient, orgId: string) {
  // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns void, which
  // Prisma cannot deserialize into a result set.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${orgId}, 0))`
}

/** Owner-only gate enforced in core (C-D9a). */
async function requireOwnerMembership(orgId: string, actorId: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: actorId, organizationId: orgId } },
    select: { id: true, role: true },
  })
  if (!membership) {
    throw new DomainError("FORBIDDEN", "You are not authorized to manage locations.")
  }
  if (membership.role !== "OWNER") {
    throw new DomainError("FORBIDDEN", "Only Owners can manage locations.")
  }
  return membership
}

function normalizeLocationName(name: unknown): string {
  if (typeof name !== "string") {
    throw new DomainError("VALIDATION", "A location name is required.")
  }
  const trimmed = name.trim()
  if (!trimmed) {
    throw new DomainError("VALIDATION", "A location name is required.")
  }
  if (trimmed.length > 100) {
    throw new DomainError("VALIDATION", "Location name is too long.")
  }
  return trimmed
}

export type LocationView = {
  id: string
  storeId: string
  name: string
  archivedAt: Date | null
  createdAt: Date
}

/** Org-scoped listing; archived excluded by default; deterministic order (C18). */
export async function listLocations(
  orgId: string,
  options?: { includeArchived?: boolean }
): Promise<LocationView[]> {
  const rows = await prisma.location.findMany({
    where: {
      store: { organizationId: orgId },
      ...(options?.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  return rows.map((r) => ({
    id: r.id,
    storeId: r.storeId,
    name: r.name,
    archivedAt: r.archivedAt,
    createdAt: r.createdAt,
  }))
}

/**
 * Creates a location (OWNER only). The store must belong to the organization
 * (cross-org storeId fails closed with the uniform error); store omitted →
 * the organization's single store. Name is trimmed, non-empty, and unique
 * per store (C-D11a).
 */
export async function createLocation(
  orgId: string,
  actorId: string,
  data: { storeId?: string; name: string }
): Promise<LocationView> {
  await requireOwnerMembership(orgId, actorId)
  const name = normalizeLocationName(data.name)

  return prisma.$transaction(async (tx) => {
    await acquireOrgLock(tx, orgId)

    let storeId = data.storeId
    if (storeId) {
      const store = await tx.store.findFirst({
        where: { id: storeId, organizationId: orgId },
        select: { id: true },
      })
      if (!store) {
        throw new DomainError("FORBIDDEN", "Invalid store for this business.")
      }
    } else {
      const store = await tx.store.findFirst({
        where: { organizationId: orgId },
        select: { id: true },
      })
      if (!store) {
        throw new DomainError("VALIDATION", "No store exists for this organization.")
      }
      storeId = store.id
    }

    // Readable pre-check for the DB-unique index (C-D11a).
    const duplicate = await tx.location.findFirst({
      where: { storeId, name },
      select: { id: true },
    })
    if (duplicate) {
      throw new DomainError("VALIDATION", "A location with this name already exists.")
    }

    const created = await tx.location.create({ data: { storeId, name } })

    await logAuditEvent(
      orgId,
      actorId,
      "CREATE_LOCATION",
      created.id,
      { name: created.name, storeId },
      tx
    )

    return {
      id: created.id,
      storeId: created.storeId,
      name: created.name,
      archivedAt: created.archivedAt,
      createdAt: created.createdAt,
    }
  })
}

/**
 * Renames a location (OWNER only). Same validation as creation, excluding
 * self from the uniqueness check; org-scoped fetch with the uniform no-leak
 * error for cross-org ids.
 */
export async function renameLocation(
  orgId: string,
  actorId: string,
  locationId: string,
  name: string
): Promise<LocationView> {
  await requireOwnerMembership(orgId, actorId)
  const trimmed = normalizeLocationName(name)

  return prisma.$transaction(async (tx) => {
    await acquireOrgLock(tx, orgId)

    const location = await tx.location.findFirst({
      where: { id: locationId, store: { organizationId: orgId } },
      select: { id: true, storeId: true, name: true, archivedAt: true, createdAt: true },
    })
    if (!location) {
      throw new DomainError("NOT_FOUND", "Location not found.")
    }

    const duplicate = await tx.location.findFirst({
      where: { storeId: location.storeId, name: trimmed, id: { not: location.id } },
      select: { id: true },
    })
    if (duplicate) {
      throw new DomainError("VALIDATION", "A location with this name already exists.")
    }

    const updated = await tx.location.update({
      where: { id: location.id },
      data: { name: trimmed },
    })

    await logAuditEvent(
      orgId,
      actorId,
      "UPDATE_LOCATION",
      location.id,
      { before: { name: location.name }, after: { name: trimmed } },
      tx
    )

    return {
      id: updated.id,
      storeId: updated.storeId,
      name: updated.name,
      archivedAt: updated.archivedAt,
      createdAt: updated.createdAt,
    }
  })
}

/**
 * Archives (or restores) a location (OWNER only). Conditional in-tx
 * transition on `archivedAt` — single-winner under concurrency. Archiving
 * the last ACTIVE location is rejected inside the lock (C-D10a, C-AC59).
 * Archiving a location holding stock IS allowed: stock stays queryable and
 * the location restorable (section 9.2/9.6) — archive is not a stock event.
 */
export async function archiveLocation(
  orgId: string,
  actorId: string,
  locationId: string,
  options?: { restore?: boolean }
): Promise<LocationView> {
  await requireOwnerMembership(orgId, actorId)
  const restore = options?.restore === true

  return prisma.$transaction(async (tx) => {
    await acquireOrgLock(tx, orgId)

    const location = await tx.location.findFirst({
      where: { id: locationId, store: { organizationId: orgId } },
      select: { id: true, storeId: true, name: true, archivedAt: true, createdAt: true },
    })
    // Uniform no-leak error for cross-org / nonexistent ids (C-AC29).
    if (!location) {
      throw new DomainError("NOT_FOUND", "Location not found.")
    }

    if (!restore) {
      if (location.archivedAt) {
        throw new DomainError("VALIDATION", "Location is already archived.")
      }
      // Last-active-location guard (C-D10a): re-read INSIDE the lock — two
      // concurrent archives of the last two active locations serialize and
      // exactly one succeeds.
      const activeCount = await tx.location.count({
        where: { store: { organizationId: orgId }, archivedAt: null },
      })
      if (activeCount <= 1) {
        throw new DomainError(
          "VALIDATION",
          "Cannot archive the last active location of the organization."
        )
      }

      // Conditional transition: only a still-active row can be archived.
      const transition = await tx.location.updateMany({
        where: { id: location.id, archivedAt: null },
        data: { archivedAt: new Date() },
      })
      if (transition.count === 0) {
        throw new DomainError("VALIDATION", "Location is already archived.")
      }
    } else {
      if (!location.archivedAt) {
        throw new DomainError("VALIDATION", "Location is not archived.")
      }
      const transition = await tx.location.updateMany({
        where: { id: location.id, NOT: { archivedAt: null } },
        data: { archivedAt: null },
      })
      if (transition.count === 0) {
        throw new DomainError("VALIDATION", "Location is not archived.")
      }
    }

    await logAuditEvent(
      orgId,
      actorId,
      "ARCHIVE_LOCATION",
      location.id,
      { action: restore ? "RESTORE" : "ARCHIVE", name: location.name },
      tx
    )

    const updated = await tx.location.findUniqueOrThrow({ where: { id: location.id } })
    return {
      id: updated.id,
      storeId: updated.storeId,
      name: updated.name,
      archivedAt: updated.archivedAt,
      createdAt: updated.createdAt,
    }
  })
}
