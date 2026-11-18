// P1-D / P1-22: StockCount lifecycle tests (plan §6.3, §7, §12).
//
// REAL PostgreSQL only — the harness (tests/global-setup.ts) recreates the
// disposable `via_saas_test` database and replays every migration before the
// suite runs, so the schema/constraint/concurrency assertions below exercise
// the same engine as production. No mocks, no SQLite.
//
// Coverage map:
// - Schema: D2/D3 migration replay, enum values, indexes, unique constraints.
// - PD-AC16: OWNER/MANAGER only (open/enter/approve/cancel + view), STAFF
//   denied server-side, cross-org/inaccessible rejection without leaks.
// - PD-AC17: archived location cannot open or approve (but can be cancelled).
// - PD-AC18/AC20/AC29: auto-population, expectedQty snapshot, approval deltas
//   computed from the approval-time balance.
// - PD-AC19/AC28/AC32: double approval, duplicate lines, atomic rollback+retry.
// - PD-AC21/AC27: safe, indistinguishable errors.
// - PD-AC23/AC30/AC31: audit events and cancellation semantics.
// - PD-AC24/AC35: count links in the history loader (in the PD-2 suite, which
//   owns that loader; the count-reference case is added there).
// - PD-AC38: real overlap latch on the Inventory row locks.
import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import type { AuditAction } from "@prisma/client"
import {
  adjustInventory,
  approveStockCount,
  archiveProduct,
  cancelStockCount,
  enterStockCountLines,
  lockInventoryRows,
  openStockCount,
  restoreProduct,
} from "@via-saas/core"
import * as stockCountModule from "../packages/core/src/stock-counts"
import {
  loadStockCountDetail,
  loadStockCountsPage,
  parseCountsCursor,
  parseCountsPageSizeParam,
  parseCountsStatusParam,
  encodeCountsCursor,
  STOCK_COUNTS_MAX_PAGE_SIZE,
  STOCK_COUNTS_PAGE_SIZE,
} from "../apps/merchant-dashboard/lib/stock-counts"
import { createOrganizationFixture, createProductFixture, type OrgFixture } from "./helpers"

// ---------------------------------------------------------------- helpers

/**
 * Adds an extra member to an existing organization (the shared fixtures only
 * create one member per org). Used for the MANAGER/STAFF negative matrix.
 */
async function addMember(
  orgId: string,
  role: "MANAGER" | "STAFF",
  allowedLocationIds: string[] = []
) {
  const suffix = randomBytes(4).toString("hex")
  const user = await prisma.user.create({
    data: {
      name: `${role} ${suffix}`,
      email: `${role.toLowerCase()}-${suffix}@via.test`,
      // Core lifecycle calls never authenticate; only sessions hash.
      passwordHash: "fixture-not-a-real-hash",
    },
  })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, allowedLocationIds },
  })
  return { userId: user.id, membershipId: membership.id }
}

/** Opens a count and returns it with its (variant-ordered) lines. */
async function openCount(org: OrgFixture, locationId: string, actorId?: string) {
  const count = await openStockCount(org.org.id, actorId ?? org.user.id, locationId)
  const lines = await prisma.stockCountLine.findMany({
    where: { countId: count.id },
    orderBy: { variantId: "asc" },
  })
  return { count, lines }
}

/** Enters one counted quantity per line, keyed by variant id. */
async function countAll(
  orgId: string,
  actorId: string,
  countId: string,
  lines: { id: string; variantId: string }[],
  byVariant: Record<string, number>
) {
  await enterStockCountLines(
    orgId,
    actorId,
    countId,
    lines.map((line) => ({ lineId: line.id, countedQty: byVariant[line.variantId] }))
  )
}

async function quantityAt(locationId: string, variantId: string): Promise<number> {
  const row = await prisma.inventory.findFirstOrThrow({ where: { locationId, variantId } })
  return row.quantity
}

async function ledgerSum(locationId: string, variantId: string): Promise<number> {
  const aggregate = await prisma.stockMovement.aggregate({
    where: { locationId, variantId },
    _sum: { quantity: true },
  })
  return aggregate._sum.quantity ?? 0
}

async function movementsFor(referenceId: string) {
  return prisma.stockMovement.findMany({ where: { referenceId }, orderBy: { createdAt: "asc" } })
}

async function auditFor(organizationId: string, action: string, targetId?: string) {
  return prisma.auditLog.findMany({
    where: { organizationId, action: action as AuditAction, ...(targetId ? { targetId } : {}) },
    orderBy: { createdAt: "asc" },
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * PD-AC38 overlap latch — CONDITION-based, not sleep-based.
 *
 * The approvals under test are blocked on the Inventory row lock held by a
 * gate transaction. This helper polls PostgreSQL's own `pg_stat_activity`
 * until it observes `minimum` approval statements genuinely waiting on a Lock,
 * then returns; on timeout it fails loudly instead of silently proceeding
 * without overlap. The short interval is a poll cadence only — no assertion
 * depends on how long the wait took.
 */
async function waitForBlockedApprovalLocks(minimum: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let observed = 0
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ blocked: number }[]>`
      SELECT COUNT(*)::int AS "blocked"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%FROM "Inventory"%'
        AND query ILIKE '%FOR UPDATE%'
    `
    observed = rows[0]?.blocked ?? 0
    if (observed >= minimum) return observed
    await sleep(25)
  }
  throw new Error(
    `PD-AC38 latch not reached: observed ${observed} blocked approval statement(s), expected ${minimum}.`
  )
}

// ------------------------------------------------------------ schema (D2/D3)

describe("Schema and migrations (D2/D3)", () => {
  it("replays both P1-D migrations on the disposable database", async () => {
    const applied = await prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at
      FROM _prisma_migrations
      WHERE migration_name IN (
        '20261118120000_p1d_stock_counts',
        '20261118120001_p1d_audit_actions'
      )
    `
    expect(applied).toHaveLength(2)
    for (const migration of applied) {
      expect(migration.finished_at).not.toBeNull()
    }
  })

  it("exposes the approved enums: 3 count statuses and the 4 new audit actions", async () => {
    const statuses = await prisma.$queryRaw<{ value: string }[]>`
      SELECT unnest(enum_range(NULL::"StockCountStatus"))::text AS value
    `
    expect(statuses.map((row) => row.value).sort()).toEqual(["APPROVED", "CANCELLED", "OPEN"])

    const actions = await prisma.$queryRaw<{ value: string }[]>`
      SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
    `
    expect(actions.map((row) => row.value)).toEqual(
      expect.arrayContaining([
        "ADJUST_INVENTORY",
        "STOCK_COUNT_START",
        "STOCK_COUNT_APPROVE",
        "STOCK_COUNT_CANCEL",
      ])
    )
  })

  it("creates the required indexes and unique constraints", async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename IN ('StockCount', 'StockCountLine')
    `
    const names = indexes.map((row) => row.indexname)
    expect(names).toEqual(
      expect.arrayContaining([
        "StockCount_organizationId_idx",
        "StockCount_locationId_idx",
        "StockCount_status_idx",
        "StockCount_organizationId_countNumber_key",
        "StockCountLine_countId_idx",
        "StockCountLine_countId_variantId_key",
      ])
    )

    const foreignKeys = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'f' AND conname LIKE 'StockCount%'
    `
    expect(foreignKeys.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "StockCount_organizationId_fkey",
        "StockCount_locationId_fkey",
        "StockCount_createdById_fkey",
        "StockCount_approvedById_fkey",
        "StockCountLine_countId_fkey",
        "StockCountLine_variantId_fkey",
      ])
    )
  })

  it("rejects a second line for the same (countId, variantId), even when inserted directly", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 4 })
    const { count, lines } = await openCount(org, org.locations[0].id)

    expect(lines).toHaveLength(1)
    await expect(
      prisma.stockCountLine.create({
        data: { countId: count.id, variantId: product.variantId, expectedQty: 4 },
      })
    ).rejects.toMatchObject({ code: "P2002" })

    // The unique constraint is what guarantees one corrective movement at most.
    expect(
      await prisma.stockCountLine.count({ where: { countId: count.id, variantId: product.variantId } })
    ).toBe(1)
  })

  it("rejects a duplicate (organizationId, countNumber) pair", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const first = await openStockCount(org.org.id, org.user.id, org.locations[0].id)
    await expect(
      prisma.stockCount.create({
        data: {
          organizationId: org.org.id,
          locationId: org.locations[0].id,
          countNumber: first.countNumber,
          createdById: org.user.id,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" })
  })
})

// -------------------------------------------------------------- permissions

describe("PD-AC16 — permissions (OWNER/MANAGER only)", () => {
  it("lets a MANAGER open, enter and approve a count", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const manager = await addMember(org.org.id, "MANAGER")
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 2 })

    const { count, lines } = await openCount(org, org.locations[0].id, manager.userId)
    await countAll(org.org.id, manager.userId, count.id, lines, { [product.variantId]: 7 })
    const approval = await approveStockCount(org.org.id, manager.userId, count.id)

    expect(approval.movements).toEqual([
      { variantId: product.variantId, delta: 5, quantity: 7 },
    ])
    expect(await quantityAt(org.locations[0].id, product.variantId)).toBe(7)
  })

  it("denies every STAFF lifecycle operation with the safe error and writes nothing", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 3 })
    const staff = await addMember(org.org.id, "STAFF")

    const unauthorized = { code: "FORBIDDEN", message: "Unauthorized. Only Owners and Managers can manage stock counts." }

    await expect(
      openStockCount(org.org.id, staff.userId, org.locations[0].id)
    ).rejects.toMatchObject(unauthorized)
    expect(await prisma.stockCount.count({ where: { organizationId: org.org.id } })).toBe(0)

    // An existing count opened by the OWNER is still off-limits to STAFF.
    const { count, lines } = await openCount(org, org.locations[0].id)
    await expect(
      enterStockCountLines(org.org.id, staff.userId, count.id, [
        { lineId: lines[0].id, countedQty: 1 },
      ])
    ).rejects.toMatchObject(unauthorized)
    await expect(
      approveStockCount(org.org.id, staff.userId, count.id)
    ).rejects.toMatchObject(unauthorized)
    await expect(
      cancelStockCount(org.org.id, staff.userId, count.id)
    ).rejects.toMatchObject(unauthorized)

    // Nothing was counted, approved, cancelled or moved.
    const reloaded = await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })
    expect(reloaded.status).toBe("OPEN")
    expect((await prisma.stockCountLine.findFirstOrThrow({ where: { id: lines[0].id } })).countedQty).toBeNull()
    expect(await prisma.stockMovement.count({ where: { referenceId: count.id } })).toBe(0)
    expect(await quantityAt(org.locations[0].id, product.variantId)).toBe(3)
  })

  it("rejects a non-member of the organization as an unknown count would be", async () => {
    const ownerOrg = await createOrganizationFixture({ locationCount: 1 })
    const other = await createOrganizationFixture({ locationCount: 1 })
    await createProductFixture(ownerOrg.org.id, ownerOrg.locations[0].id, { stock: 1 })
    const { count } = await openCount(ownerOrg, ownerOrg.locations[0].id)

    // Cross-org actor: same safe error as a random (nonexistent) count id.
    await expect(
      approveStockCount(other.org.id, other.user.id, count.id)
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Stock count not found." })
    await expect(
      cancelStockCount(other.org.id, other.user.id, count.id)
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Stock count not found." })

    const reloaded = await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })
    expect(reloaded.status).toBe("OPEN")
  })

  it("enforces the membership's location restriction for restricted managers", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const [allowed, blocked] = org.locations
    await createProductFixture(org.org.id, allowed.id, { stock: 1 })
    const manager = await addMember(org.org.id, "MANAGER", [allowed.id])

    // Allowed location: permitted.
    await expect(
      openStockCount(org.org.id, manager.userId, allowed.id)
    ).resolves.toMatchObject({ locationId: allowed.id })

    // Out-of-scope location: safe FORBIDDEN, no count created.
    await expect(
      openStockCount(org.org.id, manager.userId, blocked.id)
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You are not authorized to manage stock counts at this location.",
    })
    expect(
      await prisma.stockCount.count({ where: { organizationId: org.org.id, locationId: blocked.id } })
    ).toBe(0)
  })

  it("rejects a forged location id from another organization at open", async () => {
    const mine = await createOrganizationFixture({ locationCount: 1 })
    const theirs = await createOrganizationFixture({ locationCount: 1 })

    await expect(
      openStockCount(mine.org.id, mine.user.id, theirs.locations[0].id)
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(
      await prisma.stockCount.count({ where: { locationId: theirs.locations[0].id } })
    ).toBe(0)
  })
})

describe("PD-AC16 — view permissions (loaders)", () => {
  it("gives STAFF no list rows and no count detail", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    await createProductFixture(org.org.id, org.locations[0].id, { stock: 2 })
    const { count } = await openCount(org, org.locations[0].id)
    const staff = await addMember(org.org.id, "STAFF")

    const list = await loadStockCountsPage({ orgId: org.org.id, actorId: staff.userId })
    expect(list.authorized).toBe(false)
    expect(list.rows).toEqual([])
    expect(list.openableLocations).toEqual([])
    expect(list.filterLocations).toEqual([])

    const detail = await loadStockCountDetail({
      orgId: org.org.id,
      actorId: staff.userId,
      countId: count.id,
    })
    expect(detail).toBeNull()
  })

  it("hides cross-organization and inaccessible-location counts from the detail loader", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const [counted, other] = org.locations
    await createProductFixture(org.org.id, counted.id, { stock: 2 })
    const { count } = await openCount(org, counted.id)

    const foreign = await createOrganizationFixture({ locationCount: 1 })
    expect(
      await loadStockCountDetail({
        orgId: foreign.org.id,
        actorId: foreign.user.id,
        countId: count.id,
      })
    ).toBeNull()

    const manager = await addMember(org.org.id, "MANAGER", [other.id])
    expect(
      await loadStockCountDetail({
        orgId: org.org.id,
        actorId: manager.userId,
        countId: count.id,
      })
    ).toBeNull()
    expect(
      await loadStockCountDetail({
        orgId: org.org.id,
        actorId: manager.userId,
        countId: "does-not-exist",
      })
    ).toBeNull()

    // The OWNER still sees it.
    const ownerView = await loadStockCountDetail({
      orgId: org.org.id,
      actorId: org.user.id,
      countId: count.id,
    })
    expect(ownerView?.count.id).toBe(count.id)
    expect(ownerView?.lines).toHaveLength(1)
    expect(ownerView?.lines[0].currentQty).toBe(2)
  })
})

// ------------------------------------------------------------------ opening

describe("PD-AC29 — opening and auto-population", () => {
  it("creates exactly one line per inventory row, including zero quantities", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const stocked = await createProductFixture(org.org.id, locationId, { stock: 5 })
    const empty = await createProductFixture(org.org.id, locationId, { stock: 0 })

    const { count, lines } = await openCount(org, locationId)

    expect(count.lineCount).toBe(2)
    expect(lines).toHaveLength(2)
    const byVariant = new Map(lines.map((line) => [line.variantId, line]))
    expect(byVariant.get(stocked.variantId)?.expectedQty).toBe(5)
    expect(byVariant.get(empty.variantId)?.expectedQty).toBe(0)
    expect(byVariant.get(empty.variantId)?.countedQty).toBeNull()
    expect(count.countNumber).toBe(1001)
  })

  it("excludes archived products and their variants", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const live = await createProductFixture(org.org.id, locationId, { stock: 3 })
    const archived = await createProductFixture(org.org.id, locationId, { stock: 9 })
    await archiveProduct(org.org.id, org.user.id, archived.productId)

    const { lines } = await openCount(org, locationId)
    expect(lines.map((line) => line.variantId)).toEqual([live.variantId])
  })

  it("excludes inventory that belongs to another location", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const [first, second] = org.locations
    const atFirst = await createProductFixture(org.org.id, first.id, { stock: 1 })
    await createProductFixture(org.org.id, second.id, { stock: 1 })

    const { lines } = await openCount(org, first.id)
    expect(lines.map((line) => line.variantId)).toEqual([atFirst.variantId])
  })

  it("allocates sequential count numbers per organization", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })

    const first = await openStockCount(org.org.id, org.user.id, org.locations[0].id)
    const second = await openStockCount(org.org.id, org.user.id, org.locations[0].id)
    expect(first.countNumber).toBe(1001)
    expect(second.countNumber).toBe(1002)

    // Numbers are per organization, so another org starts at 1001 again.
    const other = await createOrganizationFixture({ locationCount: 1 })
    await createProductFixture(other.org.id, other.locations[0].id, { stock: 1 })
    const otherCount = await openStockCount(other.org.id, other.user.id, other.locations[0].id)
    expect(otherCount.countNumber).toBe(1001)
  })

  it("writes exactly one STOCK_COUNT_START audit event with the acting user", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })

    const { count } = await openCount(org, org.locations[0].id)
    const events = await auditFor(org.org.id, "STOCK_COUNT_START", count.id)
    expect(events).toHaveLength(1)
    expect(events[0].actorId).toBe(org.user.id)
    expect(events[0].metadata).toMatchObject({
      countId: count.id,
      countNumber: count.countNumber,
      locationId: org.locations[0].id,
      lineCount: 1,
    })
  })

  it("exposes no manual line-add API in the lifecycle module", async () => {
    expect(Object.keys(stockCountModule).sort()).toEqual([
      "approveStockCount",
      "cancelStockCount",
      "enterStockCountLines",
      "lockInventoryRows",
      "openStockCount",
    ])
  })
})

// ----------------------------------------------------------------- counting

describe("Counting", () => {
  it("records whole, non-negative counted quantities and keeps expectedQty frozen", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 8 })
    const { count, lines } = await openCount(org, locationId)

    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 6 })

    const line = await prisma.stockCountLine.findFirstOrThrow({ where: { countId: count.id } })
    expect(line.countedQty).toBe(6)
    expect(line.expectedQty).toBe(8) // opening snapshot, untouched
    expect(await quantityAt(locationId, product.variantId)).toBe(8) // entry never moves stock

    // A later adjustment changes the balance but never expectedQty.
    await adjustInventory(org.org.id, org.user.id, locationId, product.variantId, 4, "restock")
    const after = await prisma.stockCountLine.findFirstOrThrow({ where: { countId: count.id } })
    expect(after.expectedQty).toBe(8)
  })

  it("rejects negative, fractional and non-numeric quantities", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 2 })
    const { count, lines } = await openCount(org, org.locations[0].id)

    const invalid = {
      code: "VALIDATION",
      message: "Counted quantities must be whole numbers of zero or more.",
    }
    await expect(
      enterStockCountLines(org.org.id, org.user.id, count.id, [
        { lineId: lines[0].id, countedQty: -1 },
      ])
    ).rejects.toMatchObject(invalid)
    await expect(
      enterStockCountLines(org.org.id, org.user.id, count.id, [
        { lineId: lines[0].id, countedQty: 1.5 },
      ])
    ).rejects.toMatchObject(invalid)
    await expect(
      enterStockCountLines(org.org.id, org.user.id, count.id, [
        { lineId: lines[0].id, countedQty: Number.NaN },
      ])
    ).rejects.toMatchObject(invalid)
    await expect(
      enterStockCountLines(org.org.id, org.user.id, count.id, [])
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "No counted quantities were submitted.",
    })

    expect(
      (await prisma.stockCountLine.findFirstOrThrow({ where: { id: lines[0].id } })).countedQty
    ).toBeNull()
    // No stock movement was produced by any rejected entry.
    expect(await quantityAt(org.locations[0].id, product.variantId)).toBe(2)
  })

  it("rejects a line id that belongs to another count or does not exist", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    await createProductFixture(org.org.id, org.locations[0].id, { stock: 2 })
    const first = await openCount(org, org.locations[0].id)
    const second = await openCount(org, org.locations[0].id)

    await expect(
      enterStockCountLines(org.org.id, org.user.id, second.count.id, [
        { lineId: first.lines[0].id, countedQty: 1 },
      ])
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Count line not found." })
    await expect(
      enterStockCountLines(org.org.id, org.user.id, second.count.id, [
        { lineId: "not-a-line", countedQty: 1 },
      ])
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Count line not found." })
  })

  it("rejects entry on an approved or cancelled count", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 4 })

    const approvedRun = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, approvedRun.count.id, approvedRun.lines, {
      [product.variantId]: 4,
    })
    await approveStockCount(org.org.id, org.user.id, approvedRun.count.id)
    await expect(
      enterStockCountLines(org.org.id, org.user.id, approvedRun.count.id, [
        { lineId: approvedRun.lines[0].id, countedQty: 2 },
      ])
    ).rejects.toMatchObject({ code: "CONFLICT", message: "This stock count is no longer open." })

    const cancelledRun = await openCount(org, locationId)
    await cancelStockCount(org.org.id, org.user.id, cancelledRun.count.id)
    await expect(
      enterStockCountLines(org.org.id, org.user.id, cancelledRun.count.id, [
        { lineId: cancelledRun.lines[0].id, countedQty: 2 },
      ])
    ).rejects.toMatchObject({ code: "CONFLICT", message: "This stock count is no longer open." })
  })
})

// ----------------------------------------------------------------- approval

describe("PD-AC18/AC20 — approval deltas", () => {
  it("applies a positive delta as one ADDED movement referencing the count", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 10 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 15 })

    const approval = await approveStockCount(org.org.id, org.user.id, count.id)

    expect(await quantityAt(locationId, product.variantId)).toBe(15)
    const movements = await movementsFor(count.id)
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({
      type: "ADDED",
      quantity: 5,
      variantId: product.variantId,
      locationId,
      actorId: org.user.id,
      referenceId: count.id,
    })
    expect(approval.movements).toHaveLength(1)
    expect(approval.unchangedLines).toBe(0)
  })

  it("applies a negative delta as one REMOVED movement", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 10 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 4 })

    await approveStockCount(org.org.id, org.user.id, count.id)

    expect(await quantityAt(locationId, product.variantId)).toBe(4)
    const movements = await movementsFor(count.id)
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({ type: "REMOVED", quantity: -6, actorId: org.user.id })
  })

  it("writes nothing for zero-delta lines and exactly one movement per non-zero line", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const up = await createProductFixture(org.org.id, locationId, { stock: 5 })
    const same = await createProductFixture(org.org.id, locationId, { stock: 5 })
    const down = await createProductFixture(org.org.id, locationId, { stock: 5 })

    const { count, lines } = await openCount(org, locationId)
    expect(lines).toHaveLength(3)
    await countAll(org.org.id, org.user.id, count.id, lines, {
      [up.variantId]: 9,
      [same.variantId]: 5,
      [down.variantId]: 2,
    })

    const approval = await approveStockCount(org.org.id, org.user.id, count.id)

    expect(approval.movements).toHaveLength(2)
    expect(approval.unchangedLines).toBe(1)
    const movements = await movementsFor(count.id)
    expect(movements).toHaveLength(2)
    expect(movements.filter((m) => m.variantId === same.variantId)).toHaveLength(0)
    expect(await quantityAt(locationId, up.variantId)).toBe(9)
    expect(await quantityAt(locationId, same.variantId)).toBe(5)
    expect(await quantityAt(locationId, down.variantId)).toBe(2)

    // Ledger reconciliation for every line (PD-AC6/AC18).
    for (const variantId of [up.variantId, same.variantId, down.variantId]) {
      expect(await ledgerSum(locationId, variantId)).toBe(
        await quantityAt(locationId, variantId)
      )
    }
  })

  it("approves a count with no corrective movements when every line matches", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 7 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 7 })

    const approval = await approveStockCount(org.org.id, org.user.id, count.id)
    expect(approval.movements).toEqual([])
    expect(await movementsFor(count.id)).toHaveLength(0)
    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("APPROVED")
  })

  it("uses the approval-time balance, not the entry-time expectation (PD-AC20)", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 10 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 10 })

    // A sale/adjustment between entry and approval moves the balance to 13.
    await adjustInventory(org.org.id, org.user.id, locationId, product.variantId, 3, "restock")
    expect(await quantityAt(locationId, product.variantId)).toBe(13)

    await approveStockCount(org.org.id, org.user.id, count.id)

    // Final balance is the counted quantity, so the delta is -3 (not stale 0).
    expect(await quantityAt(locationId, product.variantId)).toBe(10)
    const movements = await movementsFor(count.id)
    expect(movements).toHaveLength(1)
    expect(movements[0]).toMatchObject({ type: "REMOVED", quantity: -3 })
  })

  it("rejects approval while any line is uncounted, leaving the count OPEN", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const first = await createProductFixture(org.org.id, locationId, { stock: 3 })
    const second = await createProductFixture(org.org.id, locationId, { stock: 3 })
    const { count, lines } = await openCount(org, locationId)

    const byVariant = new Map(lines.map((line) => [line.variantId, line]))
    await enterStockCountLines(org.org.id, org.user.id, count.id, [
      { lineId: byVariant.get(first.variantId)!.id, countedQty: 5 },
    ])

    await expect(approveStockCount(org.org.id, org.user.id, count.id)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Enter a counted quantity for every line before approving this count.",
    })

    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("OPEN")
    expect(await movementsFor(count.id)).toHaveLength(0)
    expect(await quantityAt(locationId, first.variantId)).toBe(3)
    expect(await quantityAt(locationId, second.variantId)).toBe(3)
  })

  it("refuses to approve a count that has no lines", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const { count } = await openCount(org, org.locations[0].id)
    expect(count.lineCount).toBe(0)

    await expect(approveStockCount(org.org.id, org.user.id, count.id)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "This stock count has no lines and cannot be approved.",
    })
    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("OPEN")
  })

  it("records exactly one STOCK_COUNT_APPROVE audit event with the approver", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 2 })
    const manager = await addMember(org.org.id, "MANAGER")
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 6 })

    await approveStockCount(org.org.id, manager.userId, count.id)

    const events = await auditFor(org.org.id, "STOCK_COUNT_APPROVE", count.id)
    expect(events).toHaveLength(1)
    expect(events[0].actorId).toBe(manager.userId)
    expect(events[0].metadata).toMatchObject({
      countId: count.id,
      countNumber: count.countNumber,
      correctedLines: 1,
      unchangedLines: 0,
    })
    const stored = await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })
    expect(stored.approvedById).toBe(manager.userId)
    expect(stored.approvedAt).not.toBeNull()
  })

  it("is not double-approvable and never duplicates corrective movements (PD-AC19)", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 3 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 8 })

    await approveStockCount(org.org.id, org.user.id, count.id)
    await expect(approveStockCount(org.org.id, org.user.id, count.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This stock count has already been approved.",
    })

    expect(await movementsFor(count.id)).toHaveLength(1)
    expect(await quantityAt(locationId, product.variantId)).toBe(8)
    expect(await auditFor(org.org.id, "STOCK_COUNT_APPROVE", count.id)).toHaveLength(1)
  })

  it("rolls back atomically when a product was archived after entry, and retries cleanly (PD-AC32)", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const first = await createProductFixture(org.org.id, locationId, { stock: 4 })
    const second = await createProductFixture(org.org.id, locationId, { stock: 4 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, {
      [first.variantId]: 10,
      [second.variantId]: 1,
    })

    await archiveProduct(org.org.id, org.user.id, first.productId)
    await expect(approveStockCount(org.org.id, org.user.id, count.id)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "A product in this count has been archived. Restore it before approving this count.",
    })

    // Full rollback: OPEN, no movements, no quantity change anywhere.
    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("OPEN")
    expect(await movementsFor(count.id)).toHaveLength(0)
    expect(await quantityAt(locationId, first.variantId)).toBe(4)
    expect(await quantityAt(locationId, second.variantId)).toBe(4)

    // After the correction, the same count approves successfully.
    await restoreProduct(org.org.id, org.user.id, first.productId)
    const approval = await approveStockCount(org.org.id, org.user.id, count.id)
    expect(approval.movements).toHaveLength(2)
    expect(await quantityAt(locationId, first.variantId)).toBe(10)
    expect(await quantityAt(locationId, second.variantId)).toBe(1)
  })

  it("rolls back when an inventory row was removed after opening (PD-AC32)", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 5 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 9 })

    await prisma.inventory.delete({ where: { id: product.inventoryId } })

    await expect(approveStockCount(org.org.id, org.user.id, count.id)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Inventory was removed for one or more lines. This count cannot be approved.",
    })
    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("OPEN")
    expect(await movementsFor(count.id)).toHaveLength(0)
  })
})

// ------------------------------------------------------------------- guards

describe("PD-AC17 — location state", () => {
  it("rejects opening a count at an archived location", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    await createProductFixture(org.org.id, locationId, { stock: 1 })
    await prisma.location.update({ where: { id: locationId }, data: { archivedAt: new Date() } })

    await expect(openStockCount(org.org.id, org.user.id, locationId)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "This location is archived or does not belong to your business.",
    })
    expect(await prisma.stockCount.count({ where: { organizationId: org.org.id } })).toBe(0)
  })

  it("rejects approval once the location is archived but still allows cancellation", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 5 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 8 })

    await prisma.location.update({ where: { id: locationId }, data: { archivedAt: new Date() } })

    await expect(approveStockCount(org.org.id, org.user.id, count.id)).rejects.toMatchObject({
      code: "VALIDATION",
      message: "This stock count's location is archived and the count cannot be approved.",
    })
    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("OPEN")
    expect(await quantityAt(locationId, product.variantId)).toBe(5)

    // Cancellation must remain possible, otherwise the count is stuck OPEN.
    await expect(cancelStockCount(org.org.id, org.user.id, count.id)).resolves.toMatchObject({
      countNumber: count.countNumber,
    })
    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("CANCELLED")
  })
})

// -------------------------------------------------------------- cancellation

describe("PD-AC30/AC31 — cancellation", () => {
  it("cancels an OPEN count with one cancel event and no stock effect", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 6 })
    const { count, lines } = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.id, lines, { [product.variantId]: 2 })

    const before = await prisma.stockMovement.count({ where: { locationId } })
    await cancelStockCount(org.org.id, org.user.id, count.id)

    const stored = await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })
    expect(stored.status).toBe("CANCELLED")
    expect(stored.cancelledAt).not.toBeNull()
    expect(stored.approvedAt).toBeNull()
    expect(await movementsFor(count.id)).toHaveLength(0)
    expect(await prisma.stockMovement.count({ where: { locationId } })).toBe(before)
    expect(await quantityAt(locationId, product.variantId)).toBe(6)

    const events = await auditFor(org.org.id, "STOCK_COUNT_CANCEL", count.id)
    expect(events).toHaveLength(1)
    expect(events[0].actorId).toBe(org.user.id)
  })

  it("is retry-safe: a repeated cancellation changes nothing and duplicates no event", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    await createProductFixture(org.org.id, locationId, { stock: 2 })
    const { count } = await openCount(org, locationId)

    await cancelStockCount(org.org.id, org.user.id, count.id)
    const firstCancelAt = (
      await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })
    ).cancelledAt

    await expect(cancelStockCount(org.org.id, org.user.id, count.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This stock count has already been cancelled.",
    })

    const stored = await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })
    expect(stored.status).toBe("CANCELLED")
    expect(stored.cancelledAt?.toISOString()).toBe(firstCancelAt?.toISOString())
    expect(await auditFor(org.org.id, "STOCK_COUNT_CANCEL", count.id)).toHaveLength(1)
  })

  it("rejects cancelling an approved count and approving a cancelled one", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 3 })

    const approved = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, approved.count.id, approved.lines, {
      [product.variantId]: 3,
    })
    await approveStockCount(org.org.id, org.user.id, approved.count.id)
    await expect(cancelStockCount(org.org.id, org.user.id, approved.count.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This stock count has been approved and cannot be cancelled.",
    })

    const cancelled = await openCount(org, locationId)
    await cancelStockCount(org.org.id, org.user.id, cancelled.count.id)
    await expect(approveStockCount(org.org.id, org.user.id, cancelled.count.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This stock count was cancelled and cannot be approved.",
    })
    expect(await auditFor(org.org.id, "STOCK_COUNT_APPROVE", cancelled.count.id)).toHaveLength(0)
  })

  it("rejects cancellation by a manager restricted to another location", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const [counted, other] = org.locations
    await createProductFixture(org.org.id, counted.id, { stock: 1 })
    const { count } = await openCount(org, counted.id)
    const manager = await addMember(org.org.id, "MANAGER", [other.id])

    await expect(cancelStockCount(org.org.id, manager.userId, count.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "You are not authorized to manage stock counts at this location.",
    })
    expect(
      (await prisma.stockCount.findFirstOrThrow({ where: { id: count.id } })).status
    ).toBe("OPEN")
  })
})

// -------------------------------------------------------------- audit (D3)

describe("PD-AC23 — adjustment audit migration (PD-D5)", () => {
  it("writes ADJUST_INVENTORY with the unchanged metadata payload", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 2 })

    await adjustInventory(org.org.id, org.user.id, locationId, product.variantId, 5, "restock")

    const events = await auditFor(org.org.id, "ADJUST_INVENTORY", product.variantId)
    expect(events).toHaveLength(1)
    expect(events[0].actorId).toBe(org.user.id)
    expect(events[0].metadata).toEqual({
      action: "INVENTORY_ADJUSTMENT",
      adjustment: 5,
      reason: "restock",
    })
  })
})

// --------------------------------------------------------- PD-AC38 concurrency

describe("PD-AC38 — concurrent approvals serialize on the Inventory row lock", () => {
  it("lockInventoryRows locks in ascending variant order and returns locked balances", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const first = await createProductFixture(org.org.id, locationId, { stock: 4 })
    const second = await createProductFixture(org.org.id, locationId, { stock: 9 })

    const locked = await prisma.$transaction(async (tx) =>
      // Deliberately reversed input order: the contract returns variant order.
      lockInventoryRows(tx, locationId, [second.variantId, first.variantId])
    )

    expect(locked.map((row) => row.variantId)).toEqual(
      [first.variantId, second.variantId].sort((a, b) => a.localeCompare(b))
    )
    expect(new Map(locked.map((row) => [row.variantId, row.quantity]))).toEqual(
      new Map([
        [first.variantId, 4],
        [second.variantId, 9],
      ])
    )
  })

  it("two approvals of the same variant overlapping on the lock keep every invariant", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 5 })

    // Two OPEN counts over the same variant with different counted values.
    const countA = await openCount(org, locationId)
    const countB = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, countA.count.id, countA.lines, {
      [product.variantId]: 10,
    })
    await countAll(org.org.id, org.user.id, countB.count.id, countB.lines, {
      [product.variantId]: 20,
    })

    // ---- explicit overlap latch (no timing luck) -------------------------
    // A gate transaction holds the Inventory row lock. Both approvals are
    // started while it is held, so both must be inside their transaction and
    // queued on the same row before either can read a balance.
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let gateHoldsLock!: () => void
    const lockHeld = new Promise<void>((resolve) => {
      gateHoldsLock = resolve
    })

    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "Inventory" WHERE "id" = ${product.inventoryId} FOR UPDATE
        `
        gateHoldsLock()
        await gate
      },
      { timeout: 20_000, maxWait: 20_000 }
    )

    await lockHeld

    const approvals = [
      approveStockCount(org.org.id, org.user.id, countA.count.id),
      approveStockCount(org.org.id, org.user.id, countB.count.id),
    ]

    const blocked = await waitForBlockedApprovalLocks(2)
    expect(blocked).toBeGreaterThanOrEqual(2)

    releaseGate()
    const results = await Promise.allSettled(approvals)
    await blocker

    // Both approvals must succeed (different counts, no conflicting locks
    // beyond the single serialized inventory row).
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])

    // ---- invariants only; never which approval wins ----------------------
    const finalQuantity = await quantityAt(locationId, product.variantId)
    expect(finalQuantity).toBeGreaterThanOrEqual(0)
    // Serialized approvals: the surviving balance is one count's counted value.
    expect([10, 20]).toContain(finalQuantity)
    // Ledger reconciles with the surviving quantity (no lost/duplicated write).
    expect(await ledgerSum(locationId, product.variantId)).toBe(finalQuantity)

    // Exactly one corrective movement per non-zero-delta line, no duplicates.
    expect(await movementsFor(countA.count.id)).toHaveLength(1)
    expect(await movementsFor(countB.count.id)).toHaveLength(1)

    const states = await prisma.stockCount.findMany({
      where: { id: { in: [countA.count.id, countB.count.id] } },
      select: { status: true, approvedAt: true },
    })
    expect(states.map((state) => state.status)).toEqual(["APPROVED", "APPROVED"])
    for (const state of states) expect(state.approvedAt).not.toBeNull()
  })

  it("concurrent approval and adjustment on the same variant stay safe (PD-AC22)", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const product = await createProductFixture(org.org.id, locationId, { stock: 10 })

    const count = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, count.count.id, count.lines, {
      [product.variantId]: 4,
    })

    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let gateHoldsLock!: () => void
    const lockHeld = new Promise<void>((resolve) => {
      gateHoldsLock = resolve
    })

    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "Inventory" WHERE "id" = ${product.inventoryId} FOR UPDATE
        `
        gateHoldsLock()
        await gate
      },
      { timeout: 20_000, maxWait: 20_000 }
    )
    await lockHeld

    // Adjustment and approval both block on the guarded row; the adjustment
    // is an addition, so it can never be rejected by the negative-stock guard.
    const approval = approveStockCount(org.org.id, org.user.id, count.count.id)
    const adjustment = adjustInventory(
      org.org.id,
      org.user.id,
      locationId,
      product.variantId,
      5,
      "delivery"
    )
    await waitForBlockedApprovalLocks(1)
    releaseGate()

    const results = await Promise.allSettled([approval, adjustment])
    await blocker

    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])

    // The documented residual class (§6.3): both orderings are legal — the
    // count may correct the pre- or post-adjustment balance — but the result
    // is always one of the two serialized outcomes, never negative, and the
    // ledger reconciles with the surviving quantity.
    const finalQuantity = await quantityAt(locationId, product.variantId)
    expect([4, 9]).toContain(finalQuantity)
    expect(finalQuantity).toBeGreaterThanOrEqual(0)
    expect(await ledgerSum(locationId, product.variantId)).toBe(finalQuantity)
  })

  it("concurrent approvals across two variants keep the ledger consistent (deadlock-tolerant)", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const first = await createProductFixture(org.org.id, locationId, { stock: 4 })
    const second = await createProductFixture(org.org.id, locationId, { stock: 6 })

    const countA = await openCount(org, locationId)
    const countB = await openCount(org, locationId)
    await countAll(org.org.id, org.user.id, countA.count.id, countA.lines, {
      [first.variantId]: 9,
      [second.variantId]: 1,
    })
    await countAll(org.org.id, org.user.id, countB.count.id, countB.lines, {
      [first.variantId]: 2,
      [second.variantId]: 11,
    })

    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let gateHoldsLocks!: () => void
    const locksHeld = new Promise<void>((resolve) => {
      gateHoldsLocks = resolve
    })

    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "Inventory"
          WHERE "locationId" = ${locationId}
          ORDER BY "variantId" ASC
          FOR UPDATE
        `
        gateHoldsLocks()
        await gate
      },
      { timeout: 20_000, maxWait: 20_000 }
    )

    await locksHeld
    const approvals = [
      approveStockCount(org.org.id, org.user.id, countA.count.id),
      approveStockCount(org.org.id, org.user.id, countB.count.id),
    ]
    await waitForBlockedApprovalLocks(2)
    releaseGate()

    const results = await Promise.allSettled(approvals)
    await blocker

    // A deadlock is a legal outcome here; it must be SAFE: the count stays
    // OPEN with zero movements and a retry then succeeds. A success must
    // leave the ledger consistent. Which side wins is never asserted.
    const retries: string[] = []
    for (const [index, result] of results.entries()) {
      const countId = index === 0 ? countA.count.id : countB.count.id
      if (result.status === "rejected") {
        const stored = await prisma.stockCount.findFirstOrThrow({ where: { id: countId } })
        expect(stored.status).toBe("OPEN")
        expect(await movementsFor(countId)).toHaveLength(0)
        retries.push(countId)
      }
    }
    for (const countId of retries) {
      await approveStockCount(org.org.id, org.user.id, countId)
    }

    for (const variantId of [first.variantId, second.variantId]) {
      const quantity = await quantityAt(locationId, variantId)
      expect(quantity).toBeGreaterThanOrEqual(0)
      expect(await ledgerSum(locationId, variantId)).toBe(quantity)
    }
    const states = await prisma.stockCount.findMany({
      where: { id: { in: [countA.count.id, countB.count.id] } },
      select: { status: true },
    })
    expect(states.map((state) => state.status)).toEqual(["APPROVED", "APPROVED"])
    for (const countId of [countA.count.id, countB.count.id]) {
      expect(await movementsFor(countId)).toHaveLength(2)
    }
  })

    it("two concurrent approvals of the SAME count: exactly one winner, no duplicate movement or audit", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 5 })
    const count = await openStockCount(org.org.id, org.user.id, org.locations[0].id)
    const line = await prisma.stockCountLine.findFirstOrThrow({
      where: { countId: count.id, variantId: product.variantId },
    })
    await enterStockCountLines(org.org.id, org.user.id, count.id, [
      { lineId: line.id, countedQty: 10 },
    ])

    // Latch: hold FOR UPDATE on the StockCount row from a separate connection.
    // Both approve calls will block at their conditional status claim, so the
    // overlap is deterministic rather than incidental.
    let releaseLatch!: () => void
    const latchReleased = new Promise<void>((r) => { releaseLatch = r })
    let latchHeld!: () => void
    const latchHeldSignal = new Promise<void>((r) => { latchHeld = r })

    const latchTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "StockCount" WHERE id = ${count.id} FOR UPDATE`
      latchHeld()
      await latchReleased
    }, { timeout: 30_000 })

    await latchHeldSignal

    const approvalsPromise = Promise.allSettled([
      approveStockCount(org.org.id, org.user.id, count.id),
      approveStockCount(org.org.id, org.user.id, count.id),
    ])

    // Bounded poll — fail loudly if the two approvals never overlap.
    const deadline = Date.now() + 5_000
    let waiters = 0
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active'
      `
      waiters = Number(rows[0]?.count ?? 0n)
      if (waiters >= 2) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(waiters).toBeGreaterThanOrEqual(2)

    releaseLatch()
    await latchTx
    const outcomes = await approvalsPromise

    const successes = outcomes.filter((r) => r.status === "fulfilled")
    const failures = outcomes.filter((r) => r.status === "rejected")
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    const movements = await prisma.stockMovement.findMany({
      where: { referenceId: count.id, type: "ADDED" },
    })
    expect(movements).toHaveLength(1)
    expect(movements[0].quantity).toBe(5)

    expect(await auditFor(org.org.id, "STOCK_COUNT_APPROVE", count.id)).toHaveLength(1)

    const reloaded = await prisma.stockCount.findUniqueOrThrow({ where: { id: count.id } })
    expect(reloaded.status).toBe("APPROVED")

    const inv = await prisma.inventory.findFirstOrThrow({
      where: { locationId: org.locations[0].id, variantId: product.variantId },
    })
    expect(inv.quantity).toBe(10)
  })

  it("failed approval (archived product) leaves NO STOCK_COUNT_APPROVE audit row and no movement", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 5 })
    const count = await openStockCount(org.org.id, org.user.id, org.locations[0].id)
    const line = await prisma.stockCountLine.findFirstOrThrow({
      where: { countId: count.id, variantId: product.variantId },
    })
    await enterStockCountLines(org.org.id, org.user.id, count.id, [
      { lineId: line.id, countedQty: 10 },
    ])

    await prisma.product.update({
      where: { id: product.productId },
      data: { archivedAt: new Date() },
    })

    await expect(
      approveStockCount(org.org.id, org.user.id, count.id)
    ).rejects.toThrow()

    const reloaded = await prisma.stockCount.findUniqueOrThrow({ where: { id: count.id } })
    expect(reloaded.status).toBe("OPEN")

    expect(
      await prisma.stockMovement.findMany({ where: { referenceId: count.id } })
    ).toHaveLength(0)

    // The critical assertion the audit found missing:
    expect(await auditFor(org.org.id, "STOCK_COUNT_APPROVE", count.id)).toHaveLength(0)
  })
})

// ------------------------------------------------------------------ loaders

describe("List loader — pagination, filters, scoping", () => {
  it("defaults and clamps the page size; rejects malformed cursors and statuses", () => {
    expect(parseCountsPageSizeParam(null)).toBe(STOCK_COUNTS_PAGE_SIZE)
    expect(parseCountsPageSizeParam("0")).toBe(STOCK_COUNTS_PAGE_SIZE)
    expect(parseCountsPageSizeParam("abc")).toBe(STOCK_COUNTS_PAGE_SIZE)
    expect(parseCountsPageSizeParam("1000")).toBe(STOCK_COUNTS_MAX_PAGE_SIZE)

    expect(parseCountsStatusParam("OPEN")).toEqual({ status: "OPEN", invalid: false })
    expect(parseCountsStatusParam("open")).toEqual({ status: null, invalid: true })
    expect(parseCountsStatusParam(null)).toEqual({ status: null, invalid: false })

    const cursor = encodeCountsCursor({ openedAt: new Date("2026-11-18T10:00:00.000Z"), id: "count-1" })
    expect(parseCountsCursor(cursor)).toEqual({
      openedAt: new Date("2026-11-18T10:00:00.000Z"),
      id: "count-1",
    })
    expect(parseCountsCursor("garbage")).toBeNull()
    expect(parseCountsCursor("2026-11-18T10:00:00.000Z__")).toBeNull()
  })

  it("pages deterministically and reports counted/line totals", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    await createProductFixture(org.org.id, locationId, { stock: 3 })

    const stamps = [
      new Date("2026-11-18T08:00:00.000Z"),
      new Date("2026-11-18T09:00:00.000Z"),
      new Date("2026-11-18T10:00:00.000Z"),
    ]
    const opened = [
      await openCount(org, locationId),
      await openCount(org, locationId),
      await openCount(org, locationId),
    ]
    for (const [index, openedAt] of stamps.entries()) {
      await prisma.stockCount.update({ where: { id: opened[index].count.id }, data: { openedAt } })
    }

    const firstPage = await loadStockCountsPage({
      orgId: org.org.id,
      actorId: org.user.id,
      pageSizeParam: "2",
    })
    expect(firstPage.authorized).toBe(true)
    expect(firstPage.rows.map((row) => row.countNumber)).toEqual([1003, 1002])
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.rows[0]).toMatchObject({ lineCount: 1, countedLines: 0 })
    expect(firstPage.rows[0].locationName).toBe(org.locations[0].name)

    const secondPage = await loadStockCountsPage({
      orgId: org.org.id,
      actorId: org.user.id,
      pageSizeParam: "2",
      cursorParam: firstPage.nextCursor,
    })
    expect(secondPage.rows.map((row) => row.countNumber)).toEqual([1001])
    expect(secondPage.nextCursor).toBeNull()

    // Status filter and the hostile-parameter fallbacks.
    const approvedOnly = await loadStockCountsPage({
      orgId: org.org.id,
      actorId: org.user.id,
      statusParam: "APPROVED",
    })
    expect(approvedOnly.rows).toEqual([])

    const badStatus = await loadStockCountsPage({
      orgId: org.org.id,
      actorId: org.user.id,
      statusParam: "SOLD",
    })
    expect(badStatus.invalidStatus).toBe(true)
    expect(badStatus.rows).toEqual([])

    const foreignLocation = await createOrganizationFixture({ locationCount: 1 })
    const tampered = await loadStockCountsPage({
      orgId: org.org.id,
      actorId: org.user.id,
      locationParam: foreignLocation.locations[0].id,
    })
    expect(tampered.unauthorizedLocation).toBe(true)
    expect(tampered.rows).toEqual([])
  })
})
