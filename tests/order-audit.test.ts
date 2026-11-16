// P1-B order-side audit coverage (X-2) — B-AC1..5, B-AC19/20, B-AC31.
//
// Covers: exactly-once audit per action (both checkout branches), actor
// attribution per path, the B-AC31 null-actor attribution matrix (including
// spoof rejection and the helper's null-actor rejections), transactional
// atomicity failure paths (forced audit failure → rollback; forced mutation
// failure → no orphan audit row), CHECK-constraint behavior on the
// fresh-migrated test database, and the D-9 pricing guarantees (B-AC19/20).
//
// PARALLEL-SAFE: all trigger/function names are file-scoped and predicates
// are scoped to this file's own org, so this file cannot interfere with
// other test files running concurrently under Vitest's parallel workers.
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

// ── File-scoped trigger identifiers (never shared with other test files) ──
const AUDIT_FN = "p1b_fail_audit_auditfile"
const AUDIT_TRG_CREATE = "p1b_kill_audit_auditfile_create"
const AUDIT_TRG_CANCEL = "p1b_kill_audit_auditfile_cancel"

let org: OrgFixture
let product: VariantFixture
let transferProduct: VariantFixture

beforeAll(async () => {
  // Drop only THIS file's own stale function (never another file's)
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FN}() CASCADE`)
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
  /**
   * Creates a trigger that fails AuditLog inserts for THIS test org's
   * CREATE_ORDER events. Scoped by organizationId so parallel test files
   * (which use different orgs) are unaffected.
   */
  async function installAuditKillTrigger() {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION ${AUDIT_FN}() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced audit failure (audit-file test)';
      END;
      $$ LANGUAGE plpgsql;
    `)
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${AUDIT_TRG_CREATE}
      BEFORE INSERT ON "AuditLog"
      FOR EACH ROW
      WHEN (NEW."organizationId" = '${org.org.id}' AND NEW."action" = 'CREATE_ORDER')
      EXECUTE FUNCTION ${AUDIT_FN}();
    `)
  }

  const dropAuditKillTrigger = async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${AUDIT_TRG_CREATE} ON "AuditLog"`)
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${AUDIT_TRG_CANCEL} ON "AuditLog"`)
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FN}() CASCADE`)
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
      // Scope the cancel trigger to THIS specific order (targetId is globally
      // unique across orgs, so this is race-safe).
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER ${AUDIT_TRG_CANCEL}
        BEFORE INSERT ON "AuditLog"
        FOR EACH ROW
        WHEN (NEW."targetId" = '${order.id}' AND NEW."action" = 'CANCEL_ORDER')
        EXECUTE FUNCTION ${AUDIT_FN}();
      `)
      await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow(
        /forced audit failure/
      )

      const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
      expect(reloaded?.status).toBe("FULFILLED")
      expect(reloaded?.paymentStatus).toBe("UNPAID")

      const returns = await prisma.stockMovement.findMany({
        where: { referenceId: order.id, type: "RETURN" },
      })
      expect(returns).toHaveLength(0)

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

    await prisma.inventory.delete({ where: { id: product.inventoryId } })
    try {
      await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow()

      const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
      expect(reloaded?.status).toBe("FULFILLED")

      const cancels = await auditRowsFor(order.id, "CANCEL_ORDER")
      expect(cancels).toHaveLength(0)
    } finally {
      await prisma.inventory.create({
        data: { locationId: org.locations[0].id, variantId: product.variantId, quantity: 0 },
      })
    }
  })
})

describe("B-AC19/B-AC20 — server-authoritative pricing (D-9) re-assertion", () => {
  it("extra client-supplied price fields cannot alter the recorded total (B-AC19)", async () => {
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
    expect(Number(order.totalAmount)).toBe(10000)
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

    await expect(
      logAuditEvent(org.org.id, null, "CREATE_ORDER", "t1", { orderNumber: "ORD-X" })
    ).rejects.toThrow("Audit events require an authenticated actor.")

    await expect(
      logAuditEvent(org.org.id, null, "CREATE_ORDER", "t1", { source: "DASHBOARD" })
    ).rejects.toThrow("Audit events require an authenticated actor.")

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

    expect(await prisma.auditLog.findFirst({ where: { targetId: "t-spoof" } })).toBeNull()
  })

  it("(f) CHECK constraint on the fresh-migrated test database: structural matrix", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action", "metadata")
         VALUES ('chk-matrix-ok', '${org.org.id}', NULL, 'CREATE_ORDER', '{"source":"STOREFRONT_API"}')`
      )
    ).resolves.toBe(1)

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action")
         VALUES ('chk-matrix-c1', '${org.org.id}', NULL, 'CANCEL_ORDER')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action")
         VALUES ('chk-matrix-c2', '${org.org.id}', NULL, 'CREATE_ORDER')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action", "metadata")
         VALUES ('chk-matrix-c3', '${org.org.id}', NULL, 'CREATE_ORDER', '{"orderNumber":"ORD-1"}')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AuditLog" ("id", "organizationId", "actorId", "action", "metadata")
         VALUES ('chk-matrix-c4', '${org.org.id}', NULL, 'CREATE_ORDER', '{"meta":{"source":"STOREFRONT_API"}}')`
      )
    ).rejects.toThrow(/auditlog_actorid_null_only_public_checkout/)

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
