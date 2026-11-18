// packages/core/src/stock-counts.ts
// P1-D / P1-22 — stock count lifecycle (§6.3 of docs/VIA_P1D_IMPLEMENTATION_PLAN.md).
//
// OPEN ──approve──→ APPROVED (terminal)
// OPEN ──cancel───→ CANCELLED (terminal, no stock effect)
//
// Design points that are not obvious from the call sites:
//  - Authorization is read from the membership row INSIDE the transaction.
//    The role is never a caller-supplied argument, so no code path can grant a
//    STAFF member count access (PD-D2/PD-AC16).
//  - Approval never computes a delta from an earlier read. The affected
//    Inventory rows are locked in deterministic order, and the balance is read
//    from the locked rows inside the transaction. Two concurrent approvals of
//    different counts touching the same variant therefore serialize on the row
//    lock and each delta is computed against the balance it will actually
//    modify (PD-D4/PD-AC38).
//  - Every quantity change goes through mutateInventory (PD-D4). This module
//    never writes Inventory directly.
//  - The status transition and every corrective write share one transaction:
//    a failure leaves the count OPEN with no movements and no quantity change
//    (PD-AC32).
import { prisma } from "@via-saas/database"
import { Prisma } from "@prisma/client"
import { DomainError } from "./errors"
import { mutateInventory } from "./inventory"
import { logAuditEvent } from "./audit"

/** Only these roles may view or manage counts (PD-D2, exact R-6 rule). */
const COUNT_MANAGER_ROLES = ["OWNER", "MANAGER"] as const

/** Counts are numbered from 1001 per organization, like order numbers. */
const FIRST_COUNT_NUMBER = 1001

const NOT_FOUND_MESSAGE = "Stock count not found."
const UNAUTHORIZED_MESSAGE = "Unauthorized. Only Owners and Managers can manage stock counts."

type Membership = { role: string; allowedLocationIds: string[] }

/**
 * Reads the acting user's membership for the organization and enforces the
 * OWNER/MANAGER rule. A non-member and a STAFF member are indistinguishable to
 * the caller (same safe error, no existence details).
 */
async function requireCountManager(
  tx: Prisma.TransactionClient,
  orgId: string,
  actorId: string
): Promise<Membership> {
  const membership = await tx.membership.findFirst({
    where: { userId: actorId, organizationId: orgId },
    select: { role: true, allowedLocationIds: true },
  })
  if (!membership || !COUNT_MANAGER_ROLES.includes(membership.role as "OWNER" | "MANAGER")) {
    throw new DomainError("FORBIDDEN", UNAUTHORIZED_MESSAGE)
  }
  return membership
}

/**
 * Per-location authorization (E-11 semantics): a membership with a non-empty
 * `allowedLocationIds` list is restricted to those locations, regardless of
 * role. An empty list means unrestricted within the organization.
 */
function assertLocationAccess(membership: Membership, locationId: string): void {
  if (membership.allowedLocationIds.length === 0) return
  if (!membership.allowedLocationIds.includes(locationId)) {
    throw new DomainError("FORBIDDEN", "You are not authorized to manage stock counts at this location.")
  }
}

export type StockCountOpenResult = {
  id: string
  countNumber: number
  locationId: string
  lineCount: number
}

/**
 * Opens a count and auto-populates exactly one line per variant holding an
 * Inventory row at the location — including zero-quantity rows (R-4). Lines
 * snapshot `expectedQty` from the authoritative balance at opening; archived
 * products are excluded (R-9). There is no manual line-add path in P1-D.
 */
export async function openStockCount(
  orgId: string,
  actorId: string,
  locationId: string
): Promise<StockCountOpenResult> {
  return prisma.$transaction(async (tx) => {
    const membership = await requireCountManager(tx, orgId, actorId)
    assertLocationAccess(membership, locationId)

    // C-D20: counts open only on an ACTIVE location owned by this org.
    const location = await tx.location.findFirst({
      where: { id: locationId, store: { organizationId: orgId }, archivedAt: null },
      select: { id: true },
    })
    if (!location) {
      throw new DomainError(
        "FORBIDDEN",
        "This location is archived or does not belong to your business."
      )
    }

    // Org-scoped sequential allocation. The Organization row is the lock
    // anchor (the OrderCounter pattern without a second counter table), so two
    // concurrent openings serialize instead of colliding on the number.
    await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`
    const highest = await tx.stockCount.aggregate({
      where: { organizationId: orgId },
      _max: { countNumber: true },
    })
    const countNumber = (highest._max.countNumber ?? FIRST_COUNT_NUMBER - 1) + 1

    // Eligible lines: every Inventory row at the location whose product is
    // live (archived products are excluded — R-9).
    const eligible = await tx.inventory.findMany({
      where: {
        locationId,
        variant: { product: { organizationId: orgId, archivedAt: null } },
      },
      select: { variantId: true, quantity: true },
      orderBy: { variantId: "asc" },
    })

    const count = await tx.stockCount.create({
      data: { organizationId: orgId, locationId, countNumber, createdById: actorId },
      select: { id: true },
    })

    if (eligible.length > 0) {
      await tx.stockCountLine.createMany({
        data: eligible.map((row) => ({
          countId: count.id,
          variantId: row.variantId,
          expectedQty: row.quantity,
        })),
      })
    }

    await logAuditEvent(
      orgId,
      actorId,
      "STOCK_COUNT_START",
      count.id,
      {
        action: "STOCK_COUNT_START",
        countId: count.id,
        countNumber,
        locationId,
        lineCount: eligible.length,
      },
      tx
    )

    return { id: count.id, countNumber, locationId, lineCount: eligible.length }
  })
}

export type StockCountEntry = { lineId: string; countedQty: number | null }

/**
 * Records physical counts on an OPEN count. `null` clears an entry; otherwise
 * the value must be a non-negative whole number (a physical count cannot be
 * negative and there is no negative stock). `expectedQty` is never touched —
 * it stays the opening snapshot (PD-AC29).
 */
export async function enterStockCountLines(
  orgId: string,
  actorId: string,
  countId: string,
  entries: StockCountEntry[]
): Promise<{ updated: number }> {
  if (entries.length === 0) {
    throw new DomainError("VALIDATION", "No counted quantities were submitted.")
  }
  for (const entry of entries) {
    if (entry.countedQty !== null) {
      if (!Number.isInteger(entry.countedQty) || entry.countedQty < 0) {
        throw new DomainError("VALIDATION", "Counted quantities must be whole numbers of zero or more.")
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    const membership = await requireCountManager(tx, orgId, actorId)

    // Lock the count row: entry and approval serialize on it, so a count can
    // never be entered while it is being approved (and vice versa).
    const locked = await tx.$queryRaw<{ id: string; status: string; locationId: string }[]>`
      SELECT "id", "status"::text AS "status", "locationId"
      FROM "StockCount"
      WHERE "id" = ${countId} AND "organizationId" = ${orgId}
      FOR UPDATE
    `
    const count = locked[0]
    if (!count) throw new DomainError("NOT_FOUND", NOT_FOUND_MESSAGE)
    assertLocationAccess(membership, count.locationId)
    if (count.status !== "OPEN") {
      throw new DomainError("CONFLICT", "This stock count is no longer open.")
    }

    const lines = await tx.stockCountLine.findMany({
      where: { countId: count.id },
      select: { id: true },
    })
    const known = new Set(lines.map((line) => line.id))
    for (const entry of entries) {
      if (!known.has(entry.lineId)) {
        throw new DomainError("NOT_FOUND", "Count line not found.")
      }
    }

    for (const entry of entries) {
      await tx.stockCountLine.update({
        where: { id: entry.lineId },
        data: { countedQty: entry.countedQty },
      })
    }

    return { updated: entries.length }
  })
}

export type LockedInventoryRow = { id: string; variantId: string; quantity: number }

/**
 * Locks the affected Inventory rows inside the caller's transaction and
 * returns their authoritative quantities (approved PD-AC38 concurrency
 * decision).
 *
 * `ORDER BY "variantId" ASC` is the deadlock-avoidance contract: PostgreSQL
 * locks the rows in the order the locking plan produces them, so every
 * approval acquires overlapping locks in the same sequence and no lock cycle
 * can form. The returned array is re-sorted as defense in depth so callers
 * cannot depend on incidental database ordering.
 */
export async function lockInventoryRows(
  tx: Prisma.TransactionClient,
  locationId: string,
  variantIds: string[]
): Promise<LockedInventoryRow[]> {
  if (variantIds.length === 0) return []
  const rows = await tx.$queryRaw<LockedInventoryRow[]>`
    SELECT "id", "variantId", "quantity"
    FROM "Inventory"
    WHERE "locationId" = ${locationId}
      AND "variantId" IN (${Prisma.join(variantIds)})
    ORDER BY "variantId" ASC
    FOR UPDATE
  `
  return [...rows].sort((a, b) => a.variantId.localeCompare(b.variantId))
}

export type StockCountApproval = {
  id: string
  countNumber: number
  /** One entry per corrective movement written (empty when nothing changed). */
  movements: { variantId: string; delta: number; quantity: number }[]
  unchangedLines: number
}

/**
 * Approves an OPEN count: one corrective movement per non-zero-delta line, no
 * movement for a line whose counted quantity equals the current balance, and
 * the count flips to APPROVED in the same transaction (§6.3, PD-D4/PD-AC18).
 *
 * Concurrency: the conditional status update is both the double-approval
 * guard (PD-AC19) and the row lock that serializes approvals of this count;
 * the Inventory rows are then locked in variant order before any balance is
 * read, so a concurrent approval of a different count on the same variant
 * computes its delta against the balance it will actually modify.
 */
export async function approveStockCount(
  orgId: string,
  actorId: string,
  countId: string
): Promise<StockCountApproval> {
  return prisma.$transaction(async (tx) => {
    const membership = await requireCountManager(tx, orgId, actorId)

    const approvedAt = new Date()
    const claimed = await tx.stockCount.updateMany({
      where: { id: countId, organizationId: orgId, status: "OPEN" },
      data: { status: "APPROVED", approvedById: actorId, approvedAt },
    })
    if (claimed.count === 0) {
      const existing = await tx.stockCount.findFirst({
        where: { id: countId, organizationId: orgId },
        select: { status: true },
      })
      if (!existing) throw new DomainError("NOT_FOUND", NOT_FOUND_MESSAGE)
      throw new DomainError(
        "CONFLICT",
        existing.status === "APPROVED"
          ? "This stock count has already been approved."
          : "This stock count was cancelled and cannot be approved."
      )
    }

    const count = await tx.stockCount.findFirstOrThrow({
      where: { id: countId, organizationId: orgId },
      select: { id: true, countNumber: true, locationId: true },
    })
    assertLocationAccess(membership, count.locationId)

    // PD-AC17 (C-D20): approval requires the location to still be active.
    const location = await tx.location.findFirst({
      where: { id: count.locationId, store: { organizationId: orgId }, archivedAt: null },
      select: { id: true },
    })
    if (!location) {
      throw new DomainError(
        "VALIDATION",
        "This stock count's location is archived and the count cannot be approved."
      )
    }

    // Fresh read so the archived-product recheck (R-9/PD-AC32) sees current
    // state rather than what was true when the count was entered.
    const lines = await tx.stockCountLine.findMany({
      where: { countId: count.id },
      select: {
        variantId: true,
        countedQty: true,
        variant: { select: { product: { select: { archivedAt: true } } } },
      },
      orderBy: { variantId: "asc" },
    })
    if (lines.length === 0) {
      throw new DomainError("VALIDATION", "This stock count has no lines and cannot be approved.")
    }
    if (lines.some((line) => line.countedQty === null)) {
      throw new DomainError(
        "VALIDATION",
        "Enter a counted quantity for every line before approving this count."
      )
    }
    if (lines.some((line) => line.variant.product.archivedAt !== null)) {
      throw new DomainError(
        "VALIDATION",
        "A product in this count has been archived. Restore it before approving this count."
      )
    }

    // Locks first, balances second (approved concurrency decision).
    const lockedRows = await lockInventoryRows(
      tx,
      count.locationId,
      lines.map((line) => line.variantId)
    )
    const balances = new Map(lockedRows.map((row) => [row.variantId, row.quantity]))
    if (lines.some((line) => !balances.has(line.variantId))) {
      throw new DomainError(
        "VALIDATION",
        "Inventory was removed for one or more lines. This count cannot be approved."
      )
    }

    const movements: StockCountApproval["movements"] = []
    let unchangedLines = 0
    for (const line of lines) {
      const current = balances.get(line.variantId) as number
      const delta = (line.countedQty as number) - current
      if (delta === 0) {
        unchangedLines += 1
        continue
      }
      await mutateInventory(tx, {
        orgId,
        locationId: count.locationId,
        variantId: line.variantId,
        delta,
        type: delta > 0 ? "ADDED" : "REMOVED",
        actorId,
        referenceId: count.id,
        errors: {
          // Both are unreachable by construction (the balance was read under
          // the row lock); they exist so the helper never falls back to a
          // generic message if that invariant is ever broken.
          unauthorized: {
            code: "FORBIDDEN",
            message: "You are not authorized to approve this stock count.",
          },
          insufficient: {
            code: "VALIDATION",
            message: "Stock changed while this count was being approved. Please try again.",
          },
        },
      })
      movements.push({ variantId: line.variantId, delta, quantity: current + delta })
    }

    await logAuditEvent(
      orgId,
      actorId,
      "STOCK_COUNT_APPROVE",
      count.id,
      {
        action: "STOCK_COUNT_APPROVE",
        countId: count.id,
        countNumber: count.countNumber,
        locationId: count.locationId,
        lineCount: lines.length,
        correctedLines: movements.length,
        unchangedLines,
        movements,
      },
      tx
    )

    return { id: count.id, countNumber: count.countNumber, movements, unchangedLines }
  })
}

export type StockCountCancelResult = { id: string; countNumber: number }

/**
 * Cancels an OPEN count. No inventory change and no StockMovement (PD-AC30).
 * Retry-safe by the same conditional status guard as approval: a repeated
 * attempt hits a non-OPEN row and is rejected, so the cancel event can never
 * be duplicated (PD-AC31).
 *
 * Location state is deliberately NOT rechecked: a count on a since-archived
 * location must still be cancellable, otherwise it would stay OPEN forever.
 */
export async function cancelStockCount(
  orgId: string,
  actorId: string,
  countId: string
): Promise<StockCountCancelResult> {
  return prisma.$transaction(async (tx) => {
    const membership = await requireCountManager(tx, orgId, actorId)

    const claimed = await tx.stockCount.updateMany({
      where: { id: countId, organizationId: orgId, status: "OPEN" },
      data: { status: "CANCELLED", cancelledAt: new Date() },
    })
    if (claimed.count === 0) {
      const existing = await tx.stockCount.findFirst({
        where: { id: countId, organizationId: orgId },
        select: { status: true },
      })
      if (!existing) throw new DomainError("NOT_FOUND", NOT_FOUND_MESSAGE)
      throw new DomainError(
        "CONFLICT",
        existing.status === "CANCELLED"
          ? "This stock count has already been cancelled."
          : "This stock count has been approved and cannot be cancelled."
      )
    }

    const count = await tx.stockCount.findFirstOrThrow({
      where: { id: countId, organizationId: orgId },
      select: { id: true, countNumber: true, locationId: true },
    })
    assertLocationAccess(membership, count.locationId)

    await logAuditEvent(
      orgId,
      actorId,
      "STOCK_COUNT_CANCEL",
      count.id,
      {
        action: "STOCK_COUNT_CANCEL",
        countId: count.id,
        countNumber: count.countNumber,
        locationId: count.locationId,
      },
      tx
    )

    return { id: count.id, countNumber: count.countNumber }
  })
}
