// P1-C location lifecycle (C-AC21..C-AC30, C-AC43, C-AC44, C-AC53, C-AC54, C-AC56, C-AC59).
// Create/rename/archive/restore with OWNER gates, archived-location
// exclusion across every plane (session context, checkout, FULFILL,
// adjustments, storefront), history preservation, RETURN-after-archive
// exactness, and audit/concurrency guarantees.
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest"
import { randomBytes } from "node:crypto"
import { vi } from "vitest"
import { prisma } from "@via-saas/database"
import {
  createLocation,
  renameLocation,
  archiveLocation,
  listLocations,
  processCheckout,
  resolveAttentionOrder,
  cancelOrder,
  adjustInventory,
  logAuditEvent,
} from "@via-saas/core"
import { createProductFixture, createOrganizationFixture, type OrgFixture } from "./helpers"
import { buildApp } from "../apps/api/src/app"
import { getSessionContext } from "../apps/merchant-dashboard/lib/auth-helpers"

// getSessionContext reads the session cookie — supply it via a hoisted mock.
const cookieMock = vi.hoisted(() => ({ token: null as string | null }))
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (key: string) =>
      key === "session_token" && cookieMock.token ? { value: cookieMock.token } : undefined,
    set: () => {},
    delete: () => {},
  }),
}))

async function loginAs(token: string) {
  cookieMock.token = token
}

/** Creates a session row for a user and returns its token. */
async function createSession(userId: string) {
  const token = randomBytes(16).toString("hex")
  await prisma.session.create({
    data: { userId, token, expiresAt: new Date(Date.now() + 3_600_000) },
  })
  return token
}

function auditRowsFor(orgId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { organizationId: orgId, action: action as never },
    orderBy: { createdAt: "asc" },
  })
}

// --- C-AC44 forced-audit-failure machinery (fixture-org-scoped, unique names) ---
const AUDIT_FN = "p1c_fail_audit_location"
const KILL_CREATE = "p1c_kill_create_location"
const KILL_UPDATE = "p1c_kill_update_location"
const KILL_ARCHIVE = "p1c_kill_archive_location"

async function installAuditKillTrigger(orgId: string, action: string, trigger: string) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${AUDIT_FN}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced audit failure (location-file test)';
    END;
    $$ LANGUAGE plpgsql;
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${trigger}
    BEFORE INSERT ON "AuditLog"
    FOR EACH ROW
    WHEN (NEW."organizationId" = '${orgId}' AND NEW."action" = '${action}')
    EXECUTE FUNCTION ${AUDIT_FN}();
  `)
}

afterEach(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${KILL_CREATE} ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${KILL_UPDATE} ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${KILL_ARCHIVE} ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FN}() CASCADE`)
})

// --- Storefront harness (same pattern as api-storefront.test.ts) ---
const app = buildApp()
beforeAll(async () => {
  await app.ready()
})
afterAll(async () => {
  await app.close()
})

describe("P1-16 location creation and renaming (C-AC21, C-AC22, C-AC29)", () => {
  it("C-AC21: OWNER creates a location; names are trimmed, non-empty, unique per store", async () => {
    const org = await createOrganizationFixture()

    const created = await createLocation(org.org.id, org.user.id, { name: "  Downtown  " })
    expect(created.name).toBe("Downtown")
    expect(created.archivedAt).toBeNull()

    // Duplicate name in the same store is rejected (exact-case comparison:
    // the DB unique index and application check are case-sensitive).
    await expect(
      createLocation(org.org.id, org.user.id, { name: "Downtown" })
    ).rejects.toThrow(/already exists/)

    // Empty names rejected.
    await expect(createLocation(org.org.id, org.user.id, { name: "   " })).rejects.toThrow(
      /name is required/
    )

    // Listing shows active locations deterministically.
    const list = await listLocations(org.org.id)
    expect(list.map((l) => l.name)).toEqual([org.locations[0].name, "Downtown"])
  })

  it("C-AC21: a cross-org storeId fails closed (uniform error)", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await expect(
      createLocation(a.org.id, a.user.id, { name: "Steal", storeId: b.store.id })
    ).rejects.toThrow(/Invalid store for this business./)
    expect(await auditRowsFor(a.org.id, "CREATE_LOCATION")).toHaveLength(0)
  })

  it("C-AC22: rename validates identically (uniqueness excluding self) and requires org ownership", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })

    // Rename to a sibling's name is rejected.
    await expect(
      renameLocation(org.org.id, org.user.id, org.locations[0].id, org.locations[1].name)
    ).rejects.toThrow(/already exists/)

    // Renaming to its own current name is fine (excludes self).
    const renamed = await renameLocation(
      org.org.id,
      org.user.id,
      org.locations[0].id,
      `  ${org.locations[0].name} `
    )
    expect(renamed.name).toBe(org.locations[0].name)

    // Cross-org location id → uniform no-leak miss.
    const other = await createOrganizationFixture()
    await expect(
      renameLocation(org.org.id, org.user.id, other.locations[0].id, "Hijack")
    ).rejects.toThrow("Location not found.")
  })

  it("C-AC29: cross-org create/rename/archive all fail closed", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture({ locationCount: 2 })

    await expect(
      createLocation(b.org.id, a.user.id, { name: "Nope" })
    ).rejects.toThrow(/Only Owners|not authorized/)
    await expect(
      renameLocation(b.org.id, a.user.id, b.locations[0].id, "Nope")
    ).rejects.toThrow(/Only Owners|not authorized/)
    await expect(
      archiveLocation(b.org.id, a.user.id, b.locations[0].id)
    ).rejects.toThrow(/Only Owners|not authorized/)

    // No audits in either org; B's locations untouched.
    expect(await auditRowsFor(a.org.id, "CREATE_LOCATION")).toHaveLength(0)
    expect(await auditRowsFor(b.org.id, "ARCHIVE_LOCATION")).toHaveLength(0)
    expect(
      await prisma.location.count({ where: { storeId: b.store.id, archivedAt: null } })
    ).toBe(2)
  })
})

describe("P1-16 archive/restore transitions (C-AC23, C-AC30, C-AC59)", () => {
  it("C-AC23: archive sets archivedAt; restore clears it; double transitions rejected (conditional single-winner)", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })

    const archived = await archiveLocation(org.org.id, org.user.id, org.locations[1].id)
    expect(archived.archivedAt).not.toBeNull()

    // Double archive rejected.
    await expect(
      archiveLocation(org.org.id, org.user.id, org.locations[1].id)
    ).rejects.toThrow(/already archived/)

    // Restore clears the field.
    const restored = await archiveLocation(org.org.id, org.user.id, org.locations[1].id, {
      restore: true,
    })
    expect(restored.archivedAt).toBeNull()

    // Restoring a non-archived location is rejected.
    await expect(
      archiveLocation(org.org.id, org.user.id, org.locations[1].id, { restore: true })
    ).rejects.toThrow(/not archived/)
  })

  it("C-AC30: exactly one audit per operation with archive/restore distinguished in metadata", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })

    await archiveLocation(org.org.id, org.user.id, org.locations[1].id)
    await archiveLocation(org.org.id, org.user.id, org.locations[1].id, { restore: true })

    const audits = await auditRowsFor(org.org.id, "ARCHIVE_LOCATION")
    expect(audits).toHaveLength(2)
    expect(audits[0].actorId).toBe(org.user.id)
    expect((audits[0].metadata as Record<string, unknown>).action).toBe("ARCHIVE")
    expect((audits[1].metadata as Record<string, unknown>).action).toBe("RESTORE")
  })

  it("C-AC30: archiving the LAST ACTIVE location is rejected (state unchanged)", async () => {
    const org = await createOrganizationFixture()

    await expect(
      archiveLocation(org.org.id, org.user.id, org.locations[0].id)
    ).rejects.toThrow(/Cannot archive the last active location/)

    const row = await prisma.location.findUniqueOrThrow({ where: { id: org.locations[0].id } })
    expect(row.archivedAt).toBeNull()
    expect(await auditRowsFor(org.org.id, "ARCHIVE_LOCATION")).toHaveLength(0)
  })

  it("C-AC59: concurrent archive of the last two active locations — exactly one succeeds", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })

    const results = await Promise.allSettled([
      archiveLocation(org.org.id, org.user.id, org.locations[0].id),
      archiveLocation(org.org.id, org.user.id, org.locations[1].id),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)

    const active = await prisma.location.count({
      where: { store: { organizationId: org.org.id }, archivedAt: null },
    })
    expect(active).toBeGreaterThanOrEqual(1)
  })
})

describe("P1-16 archived locations are excluded everywhere (C-AC24, C-AC25, C-AC26)", () => {
  it("C-AC24: archived locations vanish from the session context in BOTH expansion modes", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const token = await createSession(org.user.id)
    await loginAs(token)

    // Unrestricted OWNER: both locations accessible before archive.
    const before = await getSessionContext()
    expect(before!.accessibleLocationIds).toHaveLength(2)

    await archiveLocation(org.org.id, org.user.id, org.locations[1].id)

    const after = await getSessionContext()
    expect(after!.accessibleLocationIds).toEqual([org.locations[0].id])
    expect(after!.locationId).toBe(org.locations[0].id)

    // Restricted mode: a membership scoped ONLY to the archived location
    // resolves to NO context (ineligible).
    await prisma.membership.update({
      where: { id: org.membership.id },
      data: { allowedLocationIds: [org.locations[1].id] },
    })
    const restricted = await getSessionContext()
    expect(restricted).toBeNull()

    // Restoring makes the only-restricted location accessible again.
    await archiveLocation(org.org.id, org.user.id, org.locations[1].id, { restore: true })
    const restored = await getSessionContext()
    expect(restored).not.toBeNull()
    expect(restored!.locationId).toBe(org.locations[1].id) // sole accessible location
  })

  it("C-AC25: POS checkout against an archived location is rejected (pre-check)", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const product = await createProductFixture(org.org.id, org.locations[1].id, { stock: 10 })
    // Archiving one of TWO locations — the last-active guard does not fire.
    await archiveLocation(org.org.id, org.user.id, org.locations[1].id)

    await expect(
      processCheckout(org.org.id, org.locations[1].id, org.user.id, [
        { variantId: product.variantId, quantity: 1 },
      ], "CASH")
    ).rejects.toThrow(/Invalid checkout location./)

    // Nothing was deducted, no order created.
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: product.inventoryId } })
    expect(inv.quantity).toBe(10)
    expect(await prisma.order.count({ where: { organizationId: org.org.id } })).toBe(0)
  })

  it("C-AC25 (in-tx re-check): FULFILL against an archived location is rejected INSIDE the transaction", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const product = await createProductFixture(org.org.id, org.locations[1].id, { stock: 5 })

    // Insufficient stock at checkout → ATTENTION order (no deduction).
    const attention = await processCheckout(
      org.org.id, org.locations[1].id, org.user.id,
      [{ variantId: product.variantId, quantity: 105 }], "CASH"
    )
    expect(attention.status).toBe("ATTENTION")

    // Archive AFTER the order exists (one of two — guard allows it): FULFILL's
    // archived check is the in-transaction re-check itself (no pre-check on
    // this path).
    await archiveLocation(org.org.id, org.user.id, org.locations[1].id)

    await expect(
      resolveAttentionOrder(org.org.id, org.user.id, attention.id, "FULFILL")
    ).rejects.toThrow(/archived and cannot be fulfilled/)

    // The order stays ATTENTION and nothing was deducted.
    const still = await prisma.order.findUniqueOrThrow({ where: { id: attention.id } })
    expect(still.status).toBe("ATTENTION")
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: product.inventoryId } })
    expect(inv.quantity).toBe(5)
  })
  it("C-AC26: storefront resolution never selects an archived location; zero active locations fail closed; selection is deterministic", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    // Archive the FIRST-created location (one of two — guard allows it);
    // resolution must use the survivor.
    await archiveLocation(org.org.id, org.user.id, org.locations[0].id)

    const first = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        storeSlug: org.store.slug,
        cartToken: randomBytes(16).toString("hex"),
        customer: { name: "C-AC26", phone: "08000000001" },
        paymentMethod: "CASH",
        items: [{ variantId: product.variantId, quantity: 1 }],
      },
    })
    expect(first.statusCode).toBe(200)
    expect(first.json().success).toBe(true)
    const order = await prisma.order.findFirstOrThrow({
      where: { organizationId: org.org.id },
      orderBy: { createdAt: "desc" },
    })
    expect(order.locationId).toBe(org.locations[1].id) // NOT the archived one

    // Deterministic: a second checkout resolves the SAME location.
    await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        storeSlug: org.store.slug,
        cartToken: randomBytes(16).toString("hex"),
        customer: { name: "C-AC26b", phone: "08000000002" },
        paymentMethod: "CASH",
        items: [{ variantId: product.variantId, quantity: 1 }],
      },
    })
    const orders = await prisma.order.findMany({
      where: { organizationId: org.org.id },
      orderBy: { createdAt: "desc" },
      take: 2,
    })
    expect(orders[1].locationId).toBe(org.locations[1].id)
    expect(orders[0].locationId).toBe(org.locations[1].id)

    // Zero ACTIVE locations → resolution fails like a locationless store.
    // (This state is UNREACHABLE through the lifecycle API by design — the
    // C-D10a guard always keeps ≥1 active location — so it is scaffolded
    // directly to verify the fail-closed behavior for legacy/manual data.)
    await prisma.location.update({
      where: { id: org.locations[1].id },
      data: { archivedAt: new Date() },
    })
    const res = await app.inject({
      method: "GET",
      url: `/api/stores/${org.store.slug}/products`,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "Store not found." })

    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        storeSlug: org.store.slug,
        cartToken: randomBytes(16).toString("hex"),
        customer: { name: "C-AC26c", phone: "08000000003" },
        paymentMethod: "CASH",
        items: [{ variantId: product.variantId, quantity: 1 }],
      },
    })
    expect(checkoutRes.statusCode).toBe(404)
  })
})

describe("P1-16 archive preserves history; RETURN exactness (C-AC27, C-AC53, C-AC54)", () => {
  it("C-AC27: archiving preserves ALL historical data untouched", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const product = await createProductFixture(org.org.id, org.locations[1].id, { stock: 10 })
    const order = await processCheckout(
      org.org.id, org.locations[1].id, org.user.id,
      [{ variantId: product.variantId, quantity: 2 }], "CASH"
    )
    await adjustInventory(org.org.id, org.user.id, org.locations[1].id, product.variantId, 5, "restock")

    const before = {
      orders: await prisma.order.count({ where: { locationId: org.locations[1].id } }),
      items: await prisma.orderItem.count({ where: { orderId: order.id } }),
      movements: await prisma.stockMovement.count({ where: { locationId: org.locations[1].id } }),
      inventory: await prisma.inventory.findUniqueOrThrow({ where: { id: product.inventoryId } }),
      carts: await prisma.cart.count({ where: { locationId: org.locations[1].id } }),
    }

    await archiveLocation(org.org.id, org.user.id, org.locations[1].id)

    expect(await prisma.order.count({ where: { locationId: org.locations[1].id } })).toBe(before.orders)
    expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(before.items)
    expect(await prisma.stockMovement.count({ where: { locationId: org.locations[1].id } })).toBe(before.movements)
    const invAfter = await prisma.inventory.findUniqueOrThrow({ where: { id: product.inventoryId } })
    expect(invAfter.quantity).toBe(before.inventory.quantity)
    expect(await prisma.cart.count({ where: { locationId: org.locations[1].id } })).toBe(before.carts)
  })

  it("C-AC53: cancel-after-archive succeeds; the RETURN lands on the ORIGINAL location, exact and unredirected", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const product = await createProductFixture(org.org.id, org.locations[1].id, { stock: 10 })

    // TRANSFER → FULFILLED + UNPAID (cancellable); CASH would settle to PAID
    // and be rejected by the cancellation gate.
    const order = await processCheckout(
      org.org.id, org.locations[1].id, org.user.id,
      [{ variantId: product.variantId, quantity: 3 }], "TRANSFER"
    )
    expect(order.status).toBe("FULFILLED")

    // Archive the order's location (one of two — guard allows it), then cancel.
    await archiveLocation(org.org.id, org.user.id, org.locations[1].id)
    const cancelled = await cancelOrder(org.org.id, org.user.id, order.id, { reason: "customer changed mind" })
    expect(cancelled.status).toBe("CANCELLED")

    // RETURN movement written to the ORIGINAL (archived) location, exact quantity.
    const returns = await prisma.stockMovement.findMany({
      where: { referenceId: order.id, type: "RETURN" },
    })
    expect(returns).toHaveLength(1)
    expect(returns[0].locationId).toBe(org.locations[1].id)
    expect(returns[0].variantId).toBe(product.variantId)
    expect(returns[0].quantity).toBe(3)

    // The stock was restored on the original location's rows.
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: product.inventoryId } })
    expect(inv.quantity).toBe(10)
  })

  it("C-AC54: stock adjustment at an archived location is rejected; active-location adjustment unaffected", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const p1 = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })
    const p2 = await createProductFixture(org.org.id, org.locations[1].id, { stock: 10 })

    await archiveLocation(org.org.id, org.user.id, org.locations[0].id)

    await expect(
      adjustInventory(org.org.id, org.user.id, org.locations[0].id, p1.variantId, 5, "should fail")
    ).rejects.toThrow(/not authorized to adjust this inventory/)

    // Active location unaffected (M1 behavior preserved).
    await adjustInventory(org.org.id, org.user.id, org.locations[1].id, p2.variantId, 5, "restock")
    const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: p2.inventoryId } })
    expect(inv.quantity).toBe(15)
  })
})

describe("P1-C audit invariants (C-AC43, C-AC44 — location events)", () => {
  it("C-AC43: the three location events reject null actors (D-G matrix)", async () => {
    const org = await createOrganizationFixture()
    await expect(
      logAuditEvent(org.org.id, null, "CREATE_LOCATION", "t", {})
    ).rejects.toThrow("Audit events require an authenticated actor.")
    await expect(
      logAuditEvent(org.org.id, null, "UPDATE_LOCATION", "t", {})
    ).rejects.toThrow("Audit events require an authenticated actor.")
    await expect(
      logAuditEvent(org.org.id, null, "ARCHIVE_LOCATION", "t", {})
    ).rejects.toThrow("Audit events require an authenticated actor.")
  })

  it("C-AC44: forced audit failure rolls back CREATE_LOCATION — no location, no audit", async () => {
    const org = await createOrganizationFixture()
    await installAuditKillTrigger(org.org.id, "CREATE_LOCATION", KILL_CREATE)

    await expect(
      createLocation(org.org.id, org.user.id, { name: "Doomed" })
    ).rejects.toThrow(/forced audit failure/)

    expect(
      await prisma.location.findFirst({ where: { name: "Doomed", storeId: org.store.id } })
    ).toBeNull()
    expect(await auditRowsFor(org.org.id, "CREATE_LOCATION")).toHaveLength(0)
  })

  it("C-AC44: forced audit failure rolls back UPDATE_LOCATION — name unchanged, no audit", async () => {
    const org = await createOrganizationFixture()
    await installAuditKillTrigger(org.org.id, "UPDATE_LOCATION", KILL_UPDATE)

    await expect(
      renameLocation(org.org.id, org.user.id, org.locations[0].id, "New Name")
    ).rejects.toThrow(/forced audit failure/)

    const row = await prisma.location.findUniqueOrThrow({ where: { id: org.locations[0].id } })
    expect(row.name).toBe(org.locations[0].name)
    expect(await auditRowsFor(org.org.id, "UPDATE_LOCATION")).toHaveLength(0)
  })

  it("C-AC44: forced audit failure rolls back ARCHIVE_LOCATION — still active, no audit", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    await installAuditKillTrigger(org.org.id, "ARCHIVE_LOCATION", KILL_ARCHIVE)

    await expect(
      archiveLocation(org.org.id, org.user.id, org.locations[1].id)
    ).rejects.toThrow(/forced audit failure/)

    const row = await prisma.location.findUniqueOrThrow({ where: { id: org.locations[1].id } })
    expect(row.archivedAt).toBeNull()
    expect(await auditRowsFor(org.org.id, "ARCHIVE_LOCATION")).toHaveLength(0)
  })
})

describe("P1-16 deterministic ordering (C-AC56 — context.locationId stability)", () => {
  it("context.locationId is stable for a stable org/location set (createdAt, then id)", async () => {
    const org = await createOrganizationFixture({ locationCount: 3 })
    const token = await createSession(org.user.id)
    await loginAs(token)

    const first = await getSessionContext()
    const second = await getSessionContext()
    expect(first!.locationId).toBe(second!.locationId)
    // The earliest-created ACTIVE location is selected (fixture created them in order).
    expect(first!.locationId).toBe(org.locations[0].id)
    expect(first!.accessibleLocationIds).toEqual(org.locations.map((l) => l.id))
  })
})
