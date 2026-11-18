// P1-D / P1-20: inventory history loader tests (plan §6.5, §12).
//
// Covers the PD-2 acceptance criteria:
// - PD-AC9/AC11: typed reference display (order links, legacy reason text,
//   "Initial stock") and safe fallbacks for null/legacy/unknown references.
// - PD-AC35: deterministic ordering (createdAt DESC, id tiebreak), bounded
//   cursor pagination with a fixed maximum page size, batched reference
//   resolution (ONE findMany({ id: { in } }) per page — never per-row), and
//   authorization on BOTH query stages.
// - PD-AC7: tenant isolation (cross-org variants/locations/movements invisible).
// - PD-AC8/AC10: accessible-location constraint server-side.
import { describe, expect, it, vi, afterEach } from "vitest"
import { prisma } from "@via-saas/database"
import {
  loadInventoryHistoryPage,
  parseHistoryCursor,
  parseHistoryPageSizeParam,
  encodeHistoryCursor,
  INVENTORY_HISTORY_PAGE_SIZE,
  INVENTORY_HISTORY_MAX_PAGE_SIZE,
} from "../apps/merchant-dashboard/lib/inventory-history"
import { processCheckout, adjustInventory, cancelOrder, openStockCount, enterStockCountLines, approveStockCount } from "@via-saas/core"
import { createOrganizationFixture, createProductFixture, type OrgFixture } from "./helpers"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("PD-AC9/AC11 — typed reference display and movement fields", () => {
  it("resolves SALE/RETURN to order links and renders all approved fields", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 10 })

    // TRANSFER = UNPAID at creation → cancellable (CASH settles PAID).
    const order = await processCheckout(org.org.id, org.locations[0].id, org.user.id, [
      { variantId: p.variantId, quantity: 3 },
    ], "TRANSFER")
    await adjustInventory(org.org.id, org.user.id, org.locations[0].id, p.variantId, 4, "restock")
    await cancelOrder(org.org.id, org.user.id, order.id)

    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
    })

    const sale = result.rows.find((r) => r.type === "SALE")!
    expect(sale.quantity).toBe(-3)
    expect(sale.actorName).toBeTruthy() // the real acting user's name
    expect(sale.variantName).toBeTruthy()
    expect(sale.productName).toBeTruthy()
    expect(sale.locationName).toBe(org.locations[0].name)
    expect(sale.createdAt).toBeInstanceOf(Date)
    expect(sale.reference).toEqual({
      kind: "order",
      label: `Order ${order.orderNumber}`,
      href: `/orders/${order.id}`,
    })

    const returned = result.rows.find((r) => r.type === "RETURN")!
    expect(returned.quantity).toBe(3)
    expect(returned.reference).toEqual({
      kind: "order",
      label: `Order ${order.orderNumber}`,
      href: `/orders/${order.id}`,
    })

    const reasonRow = result.rows.find((r) => r.type === "ADDED" && r.quantity === 4)!
    expect(reasonRow.reference).toEqual({ kind: "reason", label: "restock" })

    // PD-AC11: the initial-creation movement displays as "Initial stock"
    // and carries the creating actor.
    const initial = result.rows.find((r) => r.reference.kind === "initial")!
    expect(initial.reference).toEqual({ kind: "initial", label: "Initial stock" })
    expect(initial.type).toBe("ADDED")
    expect(initial.quantity).toBe(10)
    expect(initial.actorName).toBeTruthy()
  })
})

describe("PD-AC35 — batched reference resolution (no per-row lookups)", () => {
  it("resolves a full page of order references with exactly ONE findMany", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 100 })

    // Three real orders → three SALE movements on one page.
    const orders = []
    for (let i = 0; i < 3; i++) {
      orders.push(await processCheckout(org.org.id, org.locations[0].id, org.user.id, [
        { variantId: p.variantId, quantity: 1 },
      ], "CASH"))
    }

    const spy = vi.spyOn(prisma.order, "findMany")
    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
    })

    // Exactly one batched resolution query for the whole page — never per row.
    expect(spy).toHaveBeenCalledTimes(1)
    const resolvedWhere = spy.mock.calls[0][0].where
    expect(resolvedWhere).toMatchObject({
      organizationId: org.org.id,
      locationId: { in: org.locations.map((l) => l.id) },
    })
    // The batch carries ALL of the page's order ids (as a set — the in-list
    // order follows page-display order, not checkout order).
    const inList = (resolvedWhere as { id: { in: string[] } }).id.in
    expect(inList).toHaveLength(3)
    expect(inList).toEqual(expect.arrayContaining(orders.map((o) => o.id)))

    const orderRefs = result.rows.filter((r) => r.reference.kind === "order")
    expect(orderRefs).toHaveLength(3)
    for (const order of orders) {
      expect(orderRefs.some((r) => r.reference.label === `Order ${order.orderNumber}`)).toBe(true)
    }
  })

  it("performs NO resolution query when the page holds no resolvable references", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })
    await adjustInventory(org.org.id, org.user.id, org.locations[0].id, p.variantId, 2, "delivery")

    const spy = vi.spyOn(prisma.order, "findMany")
    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
    })

    expect(result.rows.length).toBeGreaterThanOrEqual(2) // initial + adjustment
    expect(spy).not.toHaveBeenCalled()
    for (const row of result.rows) {
      expect(["initial", "reason"]).toContain(row.reference.kind)
    }
  })
})

describe("PD-AC9 — safe fallbacks (null, legacy, unknown, unresolved)", () => {
  it("falls back to plain text for a SALE referencing a nonexistent order", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 5 })

    await prisma.stockMovement.create({
      data: {
        locationId: org.locations[0].id,
        variantId: p.variantId,
        actorId: org.user.id,
        type: "SALE",
        quantity: -1,
        referenceId: "deleted-or-never-existed-order-id",
      },
    })

    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
    })

    const row = result.rows.find((r) => r.type === "SALE")!
    expect(row.reference).toEqual({ kind: "unresolved", label: "deleted-or-never-existed-order-id" })
  })

  it("does not leak a CROSS-ORG order through resolution (cross-tenant negative)", async () => {
    const orgA = await createOrganizationFixture({ locationCount: 1 })
    const orgB = await createOrganizationFixture({ locationCount: 1 })
    const pA = await createProductFixture(orgA.org.id, orgA.locations[0].id, { stock: 5 })
    const pB = await createProductFixture(orgB.org.id, orgB.locations[0].id, { stock: 5 })
    const orderB = await processCheckout(orgB.org.id, orgB.locations[0].id, orgB.user.id, [
      { variantId: pB.variantId, quantity: 1 },
    ], "CASH")

    // A movement in org A referencing org B's order id.
    await prisma.stockMovement.create({
      data: {
        locationId: orgA.locations[0].id,
        variantId: pA.variantId,
        actorId: orgA.user.id,
        type: "SALE",
        quantity: -1,
        referenceId: orderB.id,
      },
    })

    const result = await loadInventoryHistoryPage({
      orgId: orgA.org.id,
      accessibleLocationIds: orgA.locations.map((l) => l.id),
      variantParam: pA.variantId,
    })

    const row = result.rows.find((r) => r.type === "SALE")!
    // The org-scoped resolution query cannot see org B's order → safe
    // fallback with no existence leak (no order number, no link).
    expect(row.reference.kind).toBe("unresolved")
    expect(row.reference.label).toBe(orderB.id)
  })

  it("renders legacy null-reference SALE and REMOVED rows with a neutral fallback", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 5 })

    await prisma.stockMovement.createMany({
      data: [
        {
          locationId: org.locations[0].id,
          variantId: p.variantId,
          actorId: null,
          type: "SALE",
          quantity: -1,
          referenceId: null,
        },
        {
          locationId: org.locations[0].id,
          variantId: p.variantId,
          actorId: null,
          type: "REMOVED",
          quantity: -2,
          referenceId: null,
        },
      ],
    })

    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
    })

    // Only the fixture's initial ADDED movement uses "Initial stock"; legacy
    // null references on other types get the neutral fallback.
    const legacy = result.rows.filter(
      (r) => r.reference.kind === "unresolved" && r.reference.label === "—"
    )
    expect(legacy).toHaveLength(2)
    expect(legacy.every((r) => r.actorName === null)).toBe(true)
  })
})

describe("PD-AC7 — tenant isolation (movement query and variant filter)", () => {
  it("shows nothing from another org: movements, locations, and variants", async () => {
    const orgA = await createOrganizationFixture({ locationCount: 1 })
    const orgB = await createOrganizationFixture({ locationCount: 1 })
    const pA = await createProductFixture(orgA.org.id, orgA.locations[0].id, { stock: 10 })
    const pB = await createProductFixture(orgB.org.id, orgB.locations[0].id, { stock: 10 })
    await processCheckout(orgB.org.id, orgB.locations[0].id, orgB.user.id, [
      { variantId: pB.variantId, quantity: 2 },
    ], "CASH")

    const result = await loadInventoryHistoryPage({
      orgId: orgA.org.id,
      accessibleLocationIds: orgA.locations.map((l) => l.id),
    })

    // Org A sees only its own rows; org B's movements are invisible.
    const orgBMovementIds = (
      await prisma.stockMovement.findMany({
        where: { locationId: { in: orgB.locations.map((l) => l.id) } },
        select: { id: true },
      })
    ).map((m) => m.id)
    expect(orgBMovementIds.length).toBeGreaterThan(0) // org B really has rows
    expect(result.rows.every((r) => !orgBMovementIds.includes(r.id))).toBe(true)
    expect(result.rows.length).toBeGreaterThan(0) // org A still sees its own history

    // Cross-org variant filter fails closed (no existence leak).
    const crossVariant = await loadInventoryHistoryPage({
      orgId: orgA.org.id,
      accessibleLocationIds: orgA.locations.map((l) => l.id),
      variantParam: pB.variantId,
    })
    expect(crossVariant.rows).toHaveLength(0)
    expect(crossVariant.invalidVariant).toBe(true)
    expect(crossVariant.variant).toBeNull()

    // Cross-org location filter fails closed.
    const crossLocation = await loadInventoryHistoryPage({
      orgId: orgA.org.id,
      accessibleLocationIds: orgA.locations.map((l) => l.id),
      locationParam: orgB.locations[0].id,
    })
    expect(crossLocation.rows).toHaveLength(0)
    expect(crossLocation.unauthorizedLocation).toBe(true)
  })

  // F4 closure (defense in depth): the movement query carries an explicit
  // location → store → organization predicate, so a caller that (by defect or
  // tampering) hands in another organization's location id still reads
  // nothing from that organization. The accessible-location restriction is
  // unchanged — this predicate only narrows it.
  it("a foreign-org location id in the accessible list exposes no movements", async () => {
    const orgA = await createOrganizationFixture({ locationCount: 1 })
    const orgB = await createOrganizationFixture({ locationCount: 1 })
    const pA = await createProductFixture(orgA.org.id, orgA.locations[0].id, { stock: 10 })
    const pB = await createProductFixture(orgB.org.id, orgB.locations[0].id, { stock: 10 })
    await processCheckout(orgB.org.id, orgB.locations[0].id, orgB.user.id, [
      { variantId: pB.variantId, quantity: 2 },
    ], "CASH")

    const orgBMovementIds = (
      await prisma.stockMovement.findMany({
        where: { locationId: orgB.locations[0].id },
        select: { id: true },
      })
    ).map((m) => m.id)
    expect(orgBMovementIds.length).toBeGreaterThanOrEqual(2) // initial + SALE

    const spy = vi.spyOn(prisma.stockMovement, "findMany")

    // Forged/buggy scope: org A's context plus org B's location id.
    const result = await loadInventoryHistoryPage({
      orgId: orgA.org.id,
      accessibleLocationIds: [orgA.locations[0].id, orgB.locations[0].id],
    })

    // The org-chain predicate is actually present in the movement query.
    const movementWhere = spy.mock.calls[0][0].where as Record<string, unknown>
    expect(movementWhere).toMatchObject({
      location: { store: { organizationId: orgA.org.id } },
    })

    // No org B row leaks, and org A's own history is still visible.
    expect(result.rows.every((r) => !orgBMovementIds.includes(r.id))).toBe(true)
    expect(result.rows.some((r) => r.reference.kind === "initial")).toBe(true) // org A's fixture ledger
    expect(pA.variantId).toBeTruthy()
  })
})

describe("PD-AC8/AC10 — accessible-location authorization on both query stages", () => {
  it("STAFF scope: movements at inaccessible locations are invisible", async () => {
    const staffOrg = await createOrganizationFixture({
      locationCount: 2,
      role: "STAFF",
    })
    // Simulate the session's accessibility resolution for a restricted
    // membership: only locations[0] is accessible.
    const accessible = [staffOrg.locations[0].id]
    // A product at the ACCESSIBLE location → its initial movement is visible.
    const p0 = await createProductFixture(staffOrg.org.id, staffOrg.locations[0].id, { stock: 5 })
    // A product at the INACCESSIBLE location + a real SALE there → invisible.
    const p1 = await createProductFixture(staffOrg.org.id, staffOrg.locations[1].id, { stock: 5 })
    await processCheckout(staffOrg.org.id, staffOrg.locations[1].id, staffOrg.user.id, [
      { variantId: p1.variantId, quantity: 1 },
    ], "CASH")

    const loc1MovementIds = (
      await prisma.stockMovement.findMany({
        where: { locationId: staffOrg.locations[1].id },
        select: { id: true },
      })
    ).map((m) => m.id)
    expect(loc1MovementIds.length).toBeGreaterThanOrEqual(2) // initial + SALE

    const result = await loadInventoryHistoryPage({
      orgId: staffOrg.org.id,
      accessibleLocationIds: accessible,
    })

    // Non-empty page at the accessible location...
    expect(result.rows.length).toBeGreaterThanOrEqual(1)
    expect(result.rows.every((r) => r.locationName !== staffOrg.locations[1].name)).toBe(true)
    // ...and none of the inaccessible-location rows leak.
    expect(result.rows.every((r) => !loc1MovementIds.includes(r.id))).toBe(true)

    // Same org, broad context (MANAGER/OWNER semantics): the inaccessible
    // location's rows appear once the accessible set includes it.
    const broad = await loadInventoryHistoryPage({
      orgId: staffOrg.org.id,
      accessibleLocationIds: staffOrg.locations.map((l) => l.id),
      variantParam: p1.variantId,
    })
    expect(broad.rows.some((r) => r.type === "SALE")).toBe(true)
    expect(p0.variantId).toBeTruthy() // sanity
  })

  it("a tampered location filter outside the accessible set fails closed", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 5 })
    await processCheckout(org.org.id, org.locations[0].id, org.user.id, [
      { variantId: p.variantId, quantity: 1 },
    ], "CASH")

    // Accessible set = locations[0] only; ?location=locations[1] is in-org
    // but NOT accessible → empty, flagged, no rows.
    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: [org.locations[0].id],
      locationParam: org.locations[1].id,
    })
    expect(result.rows).toHaveLength(0)
    expect(result.unauthorizedLocation).toBe(true)
    expect(result.nextCursor).toBeNull()
  })

  it("resolution is location-constrained: an order at an inaccessible location stays unresolved", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 5 })

    // A real order at the INACCESSIBLE location (loc1).
    const hiddenOrder = await prisma.order.create({
      data: {
        organizationId: org.org.id,
        locationId: org.locations[1].id,
        orderNumber: `TEST-HIST-${Date.now()}`,
        status: "FULFILLED",
        paymentStatus: "PAID",
        totalAmount: 100,
      },
    })
    // A movement at the ACCESSIBLE location referencing it.
    await prisma.stockMovement.create({
      data: {
        locationId: org.locations[0].id,
        variantId: p.variantId,
        actorId: org.user.id,
        type: "SALE",
        quantity: -1,
        referenceId: hiddenOrder.id,
      },
    })

    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: [org.locations[0].id],
      variantParam: p.variantId,
    })

    const row = result.rows.find((r) => r.type === "SALE")!
    expect(row.reference.kind).toBe("unresolved")
    expect(row.reference.label).toBe(hiddenOrder.id)

    // Broad access resolves the same reference to an order link.
    const broad = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
    })
    const broadRow = broad.rows.find((r) => r.type === "SALE")!
    expect(broadRow.reference).toEqual({
      kind: "order",
      label: `Order ${hiddenOrder.orderNumber}`,
      href: `/orders/${hiddenOrder.id}`,
    })
  })
})

describe("PD-AC35 — deterministic ordering (createdAt DESC, id tiebreak)", () => {
  it("equal-timestamp rows are ordered by id DESC and stay stable across pages", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 0 })

    // 30 movements with IDENTICAL createdAt → the id tiebreak decides order.
    const stamp = new Date("2026-11-18T09:00:00.000Z")
    const rows = Array.from({ length: 30 }, () => ({
      locationId: org.locations[0].id,
      variantId: p.variantId,
      actorId: org.user.id,
      type: "ADDED" as const,
      quantity: 1,
      referenceId: null,
      createdAt: stamp,
    }))
    await prisma.stockMovement.createMany({ data: rows })

    // Collect the full traversal across cursor pages.
    const allIds: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const result = await loadInventoryHistoryPage({
        orgId: org.org.id,
        accessibleLocationIds: org.locations.map((l) => l.id),
        variantParam: p.variantId,
        cursorParam: cursor,
      })
      allIds.push(...result.rows.map((r) => r.id))
      cursor = result.nextCursor
      if (cursor === null) break
    }

    expect(allIds).toHaveLength(30)
    expect(new Set(allIds).size).toBe(30) // no duplicates across pages
    // id DESC tiebreak: the collected sequence equals the descending sort.
    expect([...allIds].sort().reverse()).toEqual(allIds)
  })

  it("matches the canonical reference ordering across a multi-timestamp dataset", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 0 })

    const rows = []
    for (let i = 0; i < 12; i++) {
      rows.push({
        locationId: org.locations[0].id,
        variantId: p.variantId,
        actorId: org.user.id,
        type: "ADDED" as const,
        quantity: 1,
        referenceId: null,
        createdAt: new Date(Date.UTC(2026, 10, 18, 9, 0, i % 4)), // ties present
      })
    }
    await prisma.stockMovement.createMany({ data: rows })

    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
    })
    const reference = await prisma.stockMovement.findMany({
      where: { variantId: p.variantId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    })
    expect(result.rows.map((r) => r.id)).toEqual(reference.map((r) => r.id))
  })
})

describe("PD-AC35 — bounded cursor pagination, page bounds, invalid cursor", () => {
  const setupThirty = async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 0 })
    const rows = Array.from({ length: 30 }, (_, i) => ({
      locationId: org.locations[0].id,
      variantId: p.variantId,
      actorId: org.user.id,
      type: "ADDED" as const,
      quantity: 1,
      referenceId: null,
      createdAt: new Date(Date.UTC(2026, 10, 18, 10, 0, i)), // distinct stamps
    }))
    await prisma.stockMovement.createMany({ data: rows })
    return { org, p }
  }

  it("default page size is bounded and cursor traversal yields exactly all rows once", async () => {
    const { org, p } = await setupThirty()

    const page1 = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
    })
    expect(page1.rows).toHaveLength(INVENTORY_HISTORY_PAGE_SIZE)
    expect(page1.nextCursor).not.toBeNull()

    const page2 = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
      cursorParam: page1.nextCursor,
    })
    expect(page2.rows).toHaveLength(30 - INVENTORY_HISTORY_PAGE_SIZE)
    expect(page2.nextCursor).toBeNull() // last page

    const union = [...page1.rows, ...page2.rows].map((r) => r.id)
    expect(new Set(union).size).toBe(30) // no overlap, no duplicates
  })

  it("requested page size is clamped to the fixed maximum; junk falls back to default", () => {
    expect(parseHistoryPageSizeParam(undefined)).toBe(INVENTORY_HISTORY_PAGE_SIZE)
    expect(parseHistoryPageSizeParam(null)).toBe(INVENTORY_HISTORY_PAGE_SIZE)
    expect(parseHistoryPageSizeParam("")).toBe(INVENTORY_HISTORY_PAGE_SIZE)
    expect(parseHistoryPageSizeParam("abc")).toBe(INVENTORY_HISTORY_PAGE_SIZE)
    expect(parseHistoryPageSizeParam("0")).toBe(INVENTORY_HISTORY_PAGE_SIZE)
    expect(parseHistoryPageSizeParam("-5")).toBe(INVENTORY_HISTORY_PAGE_SIZE)
    expect(parseHistoryPageSizeParam("10")).toBe(10)
    expect(parseHistoryPageSizeParam("9999")).toBe(INVENTORY_HISTORY_MAX_PAGE_SIZE)
  })

  it("an explicit bounded page size is honored", async () => {
    const { org, p } = await setupThirty()

    const page = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
      pageSizeParam: "10",
    })
    expect(page.rows).toHaveLength(10)
    expect(page.pageSize).toBe(10)
    expect(page.nextCursor).not.toBeNull()
  })

  it("an absurd page size is clamped server-side (never unbounded)", async () => {
    const { org, p } = await setupThirty()

    const page = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      variantParam: p.variantId,
      pageSizeParam: "9999",
    })
    expect(page.pageSize).toBe(INVENTORY_HISTORY_MAX_PAGE_SIZE)
    expect(page.rows).toHaveLength(30) // clamped take cannot exceed the data
    expect(page.nextCursor).toBeNull()
  })

  it("invalid cursors fail closed to an empty page instead of erroring", async () => {
    const { org, p } = await setupThirty()

    for (const bad of ["garbage", "____", "2026-01-01T00:00:00.000Z__", "x__y__z__tail"]) {
      const result = await loadInventoryHistoryPage({
        orgId: org.org.id,
        accessibleLocationIds: org.locations.map((l) => l.id),
        variantParam: p.variantId,
        cursorParam: bad,
      })
      expect(result.rows).toHaveLength(0)
      expect(result.invalidCursor).toBe(true)
      expect(result.nextCursor).toBeNull()
    }
  })

  it("cursor parsing round-trips and rejects malformed input", () => {
    const stamp = new Date("2026-11-18T09:00:00.000Z")
    const encoded = encodeHistoryCursor({ createdAt: stamp, id: "cmov_abc123" })
    expect(parseHistoryCursor(encoded)).toEqual({ createdAt: stamp, id: "cmov_abc123" })
    expect(parseHistoryCursor(undefined)).toBeNull()
    expect(parseHistoryCursor(null)).toBeNull()
    expect(parseHistoryCursor("")).toBeNull()
    expect(parseHistoryCursor("not-a-cursor")).toBeNull()
    expect(parseHistoryCursor(`${stamp.toISOString()}__`)).toBeNull()
    expect(parseHistoryCursor("not-a-date__someid")).toBeNull()
  })
})

describe("PD-AC9 — empty history", () => {
  it("an org with no movements renders an empty page with no resolution query", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })

    const spy = vi.spyOn(prisma.order, "findMany")
    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
    })

    expect(result.rows).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
    expect(result.unauthorizedLocation).toBe(false)
    expect(result.invalidVariant).toBe(false)
    expect(result.invalidCursor).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("PD-AC24 — stock count references (P1-22)", () => {
  it("links a corrective count movement to the count detail", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const p = await createProductFixture(org.org.id, locationId, { stock: 5 })

    const count = await openStockCount(org.org.id, org.user.id, locationId)
    const line = await prisma.stockCountLine.findFirstOrThrow({ where: { countId: count.id } })
    await enterStockCountLines(org.org.id, org.user.id, count.id, [
      { lineId: line.id, countedQty: 12 },
    ])
    await approveStockCount(org.org.id, org.user.id, count.id)

    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: [locationId],
      variantParam: p.variantId,
    })

    const corrective = result.rows.find((row) => row.reference.kind === "count")
    expect(corrective?.type).toBe("ADDED")
    expect(corrective?.reference).toEqual({
      kind: "count",
      label: `Stock count #${count.countNumber}`,
      href: `/stock-counts/${count.id}`,
    })

    // The initial-creation movement keeps its own neutral label.
    const initial = result.rows.find((row) => row.reference.kind === "initial")
    expect(initial?.reference).toEqual({ kind: "initial", label: "Initial stock" })
  })

  it("resolves every count reference on a page with exactly ONE batched probe", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const first = await createProductFixture(org.org.id, locationId, { stock: 2 })
    const second = await createProductFixture(org.org.id, locationId, { stock: 2 })

    const countIds: string[] = []
    for (const [index] of [first, second].entries()) {
      const count = await openStockCount(org.org.id, org.user.id, locationId)
      const lines = await prisma.stockCountLine.findMany({ where: { countId: count.id } })
      const targetVariantId = index === 0 ? first.variantId : second.variantId
      await enterStockCountLines(
        org.org.id,
        org.user.id,
        count.id,
        lines.map((line) => ({
          lineId: line.id,
          // Only the target variant differs → exactly one corrective movement.
          countedQty: line.variantId === targetVariantId ? 5 + index : line.expectedQty,
        }))
      )
      await approveStockCount(org.org.id, org.user.id, count.id)
      countIds.push(count.id)
    }

    const spy = vi.spyOn(prisma.stockCount, "findMany")
    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: [locationId],
    })

    expect(spy).toHaveBeenCalledTimes(1)
    const where = spy.mock.calls[0][0].where as Record<string, unknown>
    expect(where.organizationId).toBe(org.org.id)
    expect(where.locationId).toEqual({ in: [locationId] })

    const countLinks = result.rows.filter((row) => row.reference.kind === "count")
    expect(countLinks).toHaveLength(2)
    const hrefs = countLinks.map((row) => (row.reference.kind === "count" ? row.reference.href : ""))
    expect(new Set(hrefs)).toEqual(new Set(countIds.map((id) => `/stock-counts/${id}`)))
  })

  it("never resolves a cross-organization count reference, even when the id is truthful", async () => {
    const org = await createOrganizationFixture({ locationCount: 1 })
    const locationId = org.locations[0].id
    const p = await createProductFixture(org.org.id, locationId, { stock: 0 })
    const foreign = await createOrganizationFixture({ locationCount: 1 })
    const foreignCount = await openStockCount(
      foreign.org.id,
      foreign.user.id,
      foreign.locations[0].id
    )

    await prisma.stockMovement.create({
      data: {
        locationId,
        variantId: p.variantId,
        type: "ADDED",
        quantity: 1,
        actorId: org.user.id,
        referenceId: foreignCount.id,
      },
    })

    const result = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: [locationId],
      variantParam: p.variantId,
    })

    // Unresolvable → the raw reference renders as plain text (safe fallback).
    expect(
      result.rows.some(
        (row) => row.reference.kind === "count" || row.reference.kind === "order"
      )
    ).toBe(false)
    const row = result.rows.find((entry) => entry.reference.label === foreignCount.id)
    expect(row?.reference).toEqual({ kind: "reason", label: foreignCount.id })
  })

  it("does not resolve a count that sits outside the caller's accessible locations", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const [visible, hidden] = org.locations
    const p = await createProductFixture(org.org.id, hidden.id, { stock: 3 })

    const count = await openStockCount(org.org.id, org.user.id, hidden.id)
    const line = await prisma.stockCountLine.findFirstOrThrow({ where: { countId: count.id } })
    await enterStockCountLines(org.org.id, org.user.id, count.id, [{ lineId: line.id, countedQty: 7 }])
    await approveStockCount(org.org.id, org.user.id, count.id)

    // A movement the restricted viewer CAN see (visible location) referencing
    // a count that belongs to the hidden location: the reference must not
    // resolve into a link to an inaccessible record.
    await prisma.stockMovement.create({
      data: {
        locationId: visible.id,
        variantId: p.variantId,
        type: "ADDED",
        quantity: 1,
        actorId: org.user.id,
        referenceId: count.id,
      },
    })

    const restricted = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: [visible.id],
    })
    const restrictedRow = restricted.rows.find((row) => row.reference.label === count.id)
    expect(restrictedRow?.reference).toEqual({ kind: "reason", label: count.id })

    // The unrestricted viewer sees the same movement resolved to a count link.
    const broad = await loadInventoryHistoryPage({
      orgId: org.org.id,
      accessibleLocationIds: [visible.id, hidden.id],
    })
    const linked = broad.rows.find(
      (row) => row.reference.kind === "count" && row.reference.href === `/stock-counts/${count.id}`
    )
    expect(linked).toBeTruthy()
  })
})
