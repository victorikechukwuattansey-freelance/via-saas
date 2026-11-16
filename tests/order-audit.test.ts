// P1-B order-side audit coverage (X-2) — B-AC1..5, B-AC19/20, B-AC31.
//
// Covers: exactly-once audit per action (both checkout branches), actor
// attribution per path, the B-AC31 null-actor attribution matrix (including
// spoof rejection and the helper's null-actor rejections), transactional
// atomicity failure paths (forced audit failure → rollback; forced mutation
// failure → no orphan audit row), CHECK-constraint behavior on the
// fresh-migrated test database, and the D-9 pricing guarantees (B-AC19/20).
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { prisma } from "@via-saas/database"
import { AuditAction } from "@prisma/client"
import {
  processCheckout,
  resolveAttentionOrder,
  cancelOrder,
  recordPaymentReceived,
  logAuditEvent,
  STOREFRONT_API_SOURCE,
} from "@via-saas/core"
import { buildApp } from "../apps/api/src/app"
import { createOrganizationFixture, createProductFixture, type OrgFixture, type VariantFixture } from "./helpers"

const app = buildApp()

let org: OrgFixture
let product: VariantFixture
let transferProduct: VariantFixture

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS p1b_fail_audit_insert() CASCADE`)
  await app.ready()
  org = await createOrganizationFixture({ locationCount: 1 })
  product = await createProductFixture(org.org.id, org.locations[0].id, { price: 5000, stock: 100 })
  transferProduct = await createProductFixture(org.org.id, org.locations[0].id, { price: 2000, stock: 50 })
})

afterAll(async () => {
  await app.close()
})

/** Counts audit rows for one order target. */
async function auditRowsFor(orderId: string, action?: AuditAction) {
  return prisma.auditLog.findMany({
    where: { targetId: orderId, ...(action ? { action } : {}) },
  })
}

describe("B-AC1 — exactly one CREATE_ORDER audit per order (both branches)", () => {
  it("success branch: exactly one CREATE_ORDER event, transaction-bound, with the metadata contract", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 2 }],
      "CASH"
    )

    const rows = await auditRowsFor(order.id, "CREATE_ORDER")
    expect(rows).toHaveLength(1)

    const row = rows[0]
    expect(row.organizationId).toBe(org.org.id)
    expect(row.action).toBe("CREATE_ORDER")
    // Metadata contract: TOP-LEVEL source key + order facts (R4).
    const metadata = row.metadata as Record<string, unknown>
    expect(metadata.source).toBe("DASHBOARD")
    expect(metadata.orderNumber).toBe(order.orderNumber)
    expect(metadata.paymentMethod).toBe("CASH")
    expect(metadata.itemCount).toBe(2)
    expect(metadata.total).toBe(10000)
  })

  it("ATTENTION branch: exactly one CREATE_ORDER event too", async () => {
    const attentionProduct = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 1 })
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "CASH"
    )
    expect(order.status).toBe("ATTENTION")

    const rows = await auditRowsFor(order.id, "CREATE_ORDER")
    expect(rows).toHaveLength(1)
    expect(((rows[0].metadata as Record<string, unknown>).source)).toBe("DASHBOARD")
  })
})

describe("B-AC2 — actor attribution per checkout path", () => {
  it("dashboard checkout attributes the event to the authenticated merchant actor", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH"
    )
    const rows = await auditRowsFor(order.id, "CREATE_ORDER")
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(org.user.id)
  })

  it("public API checkout attributes the event to system origin (null actor, STOREFRONT_API source)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        storeSlug: org.store.slug,
        items: [{ variantId: product.variantId, quantity: 1 }],
        customer: { name: "Ada Public", phone: "08099990001" },
        paymentMethod: "TRANSFER",
        cartToken: "tok_audit_public",
      },
    })
    expect(res.statusCode).toBe(200)

    const orderNumber = res.json().orderNumber as string
    const order = await prisma.order.findFirst({
      where: { organizationId: org.org.id, orderNumber },
    })
    expect(order).not.toBeNull()

    const rows = await auditRowsFor(order!.id, "CREATE_ORDER")
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBeNull()
    const metadata = rows[0].metadata as Record<string, unknown>
    expect(metadata.source).toBe(STOREFRONT_API_SOURCE)
  })
})

describe("B-AC3 — ATTENTION resolution audit behavior", () => {
  it("CANCEL writes exactly one CANCEL_ORDER; FULFILL writes exactly one RESOLVE_ORDER", async () => {
    const attentionProduct = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 1 })

    const cancelOrderRow = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "CASH"
    )
    await resolveAttentionOrder(org.org.id, org.user.id, cancelOrderRow.id, "CANCEL")

    const cancels = await auditRowsFor(cancelOrderRow.id, "CANCEL_ORDER")
    expect(cancels).toHaveLength(1)
    expect(cancels[0].actorId).toBe(org.user.id)
    expect(await auditRowsFor(cancelOrderRow.id, "RESOLVE_ORDER")).toHaveLength(0)

    const fulfillOrder = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "CASH"
    )
    // ATTENTION FULFILL assumes the merchant restocked the physical shelf
    // (M1 semantics): restock before resolving.
    await prisma.inventory.updateMany({
      where: { locationId: org.locations[0].id, variantId: attentionProduct.variantId },
      data: { quantity: 10 },
    })
    await resolveAttentionOrder(org.org.id, org.user.id, fulfillOrder.id, "FULFILL")

    const resolves = await auditRowsFor(fulfillOrder.id, "RESOLVE_ORDER")
    expect(resolves).toHaveLength(1)
    expect(resolves[0].actorId).toBe(org.user.id)
  })
})

describe("B-AC4 — atomicity failure paths", () => {
  /** Creates a trigger that fails AuditLog inserts for THIS test org's
   *  CREATE_ORDER events (scoped so parallel test files are unaffected). */
  async function installAuditKillTrigger() {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION p1b_fail_audit_insert() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced audit failure (test trigger)';
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER p1b_kill_audit_create_order
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW
      WHEN (NEW."organizationId" = '${org.org.id}' AND NEW."action" = 'CREATE_ORDER')
      EXECUTE FUNCTION p1b_fail_audit_insert();
    `)
  }

 const dropAuditKillTrigger = async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS p1b_kill_audit_create_order ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS p1b_kill_audit_cancel ON "AuditLog"`)  // ← add this
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS p1b_fail_audit_insert() CASCADE`)       // ← add CASCADE
}

  it("forced audit failure rolls back the checkout — no order, no movements, no audit row", async () => {
    const invBefore = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    const ordersBefore = await prisma.order.count({ where: { organizationId: org.org.id } })
    const auditsBefore = await prisma.auditLog.count({
      where: { organizationId: org.org.id, action: "CREATE_ORDER" },
    })
    const movementsBefore = await prisma.stockMovement.count({
      where: { locationId: org.locations[0].id },
    })

    await installAuditKillTrigger()
    try {
      await expect(
        processCheckout(
          org.org.id,
          org.locations[0].id,
          org.user.id,
          [{ variantId: product.variantId, quantity: 1 }],
          "CASH"
        )
      ).rejects.toThrow(/forced audit failure/)

      // NOTHING persisted: stock, orders, audit rows and movements are all
      // exactly as before the failed call (full rollback).
      const invAfter = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
      expect(invAfter?.quantity).toBe(invBefore?.quantity)
      expect(await prisma.order.count({ where: { organizationId: org.org.id } })).toBe(ordersBefore)
      expect(
        await prisma.auditLog.count({ where: { organizationId: org.org.id, action: "CREATE_ORDER" } })
      ).toBe(auditsBefore)
      expect(await prisma.stockMovement.count({ where: { locationId: org.locations[0].id } })).toBe(
        movementsBefore
      )
    } finally {
      await dropAuditKillTrigger()
    }
  })

  it("forced audit failure rolls back the cancellation — status, stock, movements and audit all revert", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 2 }],
      "TRANSFER"
    )
    expect(order.status).toBe("FULFILLED")

    const stockBeforeCancel = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })

    await installAuditKillTrigger()
    try {
      // The trigger fails CREATE_ORDER inserts; the CANCEL_ORDER insert in
      // cancelOrder needs its own kill trigger scoped to this order.
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER p1b_kill_audit_cancel
        BEFORE INSERT ON "AuditLog"
        FOR EACH ROW
        WHEN (NEW."targetId" = '${order.id}' AND NEW."action" = 'CANCEL_ORDER')
        EXECUTE FUNCTION p1b_fail_audit_insert();
      `)
      await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow(
        /forced audit failure/
      )

      // Order still FULFILLED + UNPAID (status transition rolled back).
      const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
      expect(reloaded?.status).toBe("FULFILLED")
      expect(reloaded?.paymentStatus).toBe("UNPAID")

      // No RETURN movement was written.
      const returns = await prisma.stockMovement.findMany({
        where: { referenceId: order.id, type: "RETURN" },
      })
      expect(returns).toHaveLength(0)

      // Stock was NOT restored.
      const stockAfter = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
      expect(stockAfter?.quantity).toBe(stockBeforeCancel?.quantity)
    } finally {
      await dropAuditKillTrigger()
    }
  })

  it("forced mutation failure leaves no orphan audit row (cancellation with missing inventory)", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "TRANSFER"
    )

    // Sabotage the mutation: remove the inventory row so restoration fails
    // AFTER the guarded status transition but BEFORE the audit write.
    await prisma.inventory.delete({ where: { id: product.inventoryId } })
    try {
      await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow()

      // The status transition rolled back with the rest.
      const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
      expect(reloaded?.status).toBe("FULFILLED")

      // NO audit row for the failed cancellation (no orphan audit record).
      const cancels = await auditRowsFor(order.id, "CANCEL_ORDER")
      expect(cancels).toHaveLength(0)
    } finally {
      // Recreate a minimal inventory row so later teardown/queries are safe.
      await prisma.inventory.create({
        data: { locationId: org.locations[0].id, variantId: product.variantId, quantity: 0 },
      })
    }
  })
})

describe("B-AC19/B-AC20 — server-authoritative pricing (D-9) re-assertion", () => {
  it("extra client-supplied price fields cannot alter the recorded total (B-AC19)", async () => {
    // The payload type carries NO price fields; a hostile client spreading
    // extra properties still cannot influence them (they are dropped).
    const hostileItems = [{ variantId: product.variantId, quantity: 2, unitPrice: 1, total: 2 },
    ] as unknown as {
      variantId: string
      quantity: number
    }[]

    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      hostileItems,
      "CASH"
    )
    expect(Number(order.totalAmount)).toBe(10000) // 2 × 5000 from the DB
  })

  it("editing a variant price after checkout does not change the historical OrderItem.unitPrice (B-AC20)", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH"
    )
    const itemBefore = await prisma.orderItem.findFirst({ where: { orderId: order.id } })
    expect(Number(itemBefore?.unitPrice)).toBe(5000)

    await prisma.productVariant.update({
      where: { id: product.variantId },
      data: { sellingPrice: 9999 },
    })

    const itemAfter = await prisma.orderItem.findFirst({ where: { orderId: order.id } })
    expect(Number(itemAfter?.unitPrice)).toBe(5000)
  })
})

describe("B-AC31 — null-actor attribution invariant (D-G)", () => {
  it("(b) helper rejects a null actor for CANCEL_ORDER / RESOLVE_ORDER / PAYMENT_RECORDED and for CREATE_ORDER without the exact source", async () => {
    await expect(
      logAuditEvent(org.org.id, null, "CANCEL_ORDER", "t1")
    ).rejects.toThrow("Audit events require an authenticated actor.")

    await expect(
      logAuditEvent(org.org.id, null, "RESOLVE_ORDER", "t1")
    ).rejects.toThrow("Audit events require an authenticated actor.")

    await expect(
      logAuditEvent(org.org.id, null, "PAYMENT_RECORDED", "t1")
    ).rejects.toThrow("Audit events require an authenticated actor.")

    // CREATE_ORDER but missing source → reject.
    await expect(
      logAuditEvent(org.org.id, null, "CREATE_ORDER", "t1", { orderNumber: "ORD-X" })
    ).rejects.toThrow("Audit events require an authenticated actor.")

    // CREATE_ORDER but wrong source → reject.
    await expect(
      logAuditEvent(org.org.id, null, "CREATE_ORDER", "t1", { source: "DASHBOARD" })
    ).rejects.toThrow("Audit events require an authenticated actor.")

    // CREATE_ORDER but NESTED source (not top-level) → reject.
    await expect(
      logAuditEvent(org.org.id, null, "CREATE_ORDER", "t1", { meta: { source: STOREFRONT_API_SOURCE } })
    ).rejects.toThrow("Audit events require an authenticated actor.")
  })

  it("(b) helper ACCEPTS a null actor only for CREATE_ORDER + top-level STOREFRONT_API source", async () => {
    await logAuditEvent(org.org.id, null, "CREATE_ORDER", "t-null-actor", {
      source: STOREFRONT_API_SOURCE,
      orderNumber: "ORD-NULL",
    })

    const row = await prisma.auditLog.findFirst({ where: { targetId: "t-null-actor" } })
    expect(row).not.toBeNull()
    expect(row?.actorId).toBeNull()
    expect(row?.action).toBe("CREATE_ORDER")
    expect(((row?.metadata as Record<string, unknown>).source)).toBe(STOREFRONT_API_SOURCE)
  })

  it("(c) merchant-authenticated callers cannot spoof the STOREFRONT_API source", async () => {
    await expect(
      logAuditEvent(org.org.id, org.user.id, "CREATE_ORDER", "t-spoof", { source: STOREFRONT_API_SOURCE })
    ).rejects.toThrow("System-origin attribution cannot be claimed by an authenticated actor.")

    // Nothing was written.
    expect(await prisma.auditLog.findFirst({ where: { targetId: "t-spoof" } })).toBeNull()
  })

  it("(f) CHECK constraint on the fresh-migrated test database: structural matrix", async () => {
    // Accept: null actor + CREATE_ORDER + top-level STOREFRONT_API source.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action", "metadata")
         VALUES ('chk-matrix-ok', '${org.org.id}', NULL, 'CREATE_ORDER', '{"source":"STOREFRONT_API"}')`
      )
    ).resolves.toBe(1)

    // Reject: null actor + CANCEL_ORDER.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action")
         VALUES ('chk-matrix-c1', '${org.org.id}', NULL, 'CANCEL_ORDER')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

    // Reject: null actor + CREATE_ORDER without metadata.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action")
         VALUES ('chk-matrix-c2', '${org.org.id}', NULL, 'CREATE_ORDER')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

    // Reject: null actor + CREATE_ORDER, source absent.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action", "metadata")
         VALUES ('chk-matrix-c3', '${org.org.id}', NULL, 'CREATE_ORDER', '{"orderNumber":"ORD-1"}')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

    // Reject: null actor + CREATE_ORDER, NESTED source.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action", "metadata")
         VALUES ('chk-matrix-c4', '${org.org.id}', NULL, 'CREATE_ORDER', '{"meta":{"source":"STOREFRONT_API"}}')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

    // Reject: null actor + CREATE_ORDER, wrong source.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action", "metadata")
         VALUES ('chk-matrix-c5', '${org.org.id}', NULL, 'CREATE_ORDER', '{"source":"DASHBOARD"}')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)
  })
})

describe("B-AC5 — additive enum widening", () => {
  it("all five legacy audit actions remain writable after the widening", async () => {
    const legacyActions = ["CREATE_PRODUCT", "UPDATE_PRODUCT", "INVITE_STAFF", "RESOLVE_ORDER", "UPDATE_SETTINGS"] as const

    for (const action of legacyActions) {
      const targetId = `legacy-${action}`
      await prisma.auditLog.create({
        data: { organizationId: org.org.id, actorId: org.user.id, action, targetId },
      })
      const row = await prisma.auditLog.findFirst({ where: { targetId } })
      expect(row?.action).toBe(action)
    }
  })
})

describe("B-AC17 support — payment recording attribution (core level)", () => {
  it("records the authenticated actor and transitions UNPAID → PAID", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: transferProduct.variantId, quantity: 1 }],
      "TRANSFER"
    )
    expect(order.paymentStatus).toBe("UNPAID")
    expect(order.paymentMethod).toBe("TRANSFER")

    const updated = await recordPaymentReceived(org.org.id, org.user.id, order.id)
    expect(updated.paymentStatus).toBe("PAID")

    const rows = await auditRowsFor(order.id, "PAYMENT_RECORDED")
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(org.user.id)
    expect(rows[0].createdAt).toBeInstanceOf(Date)
  })
})
