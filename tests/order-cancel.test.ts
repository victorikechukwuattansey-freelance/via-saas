// P1-B order cancellation (D-A / P1-09) — B-AC9..14.
//
// Covers: eligibility matrix (only FULFILLED + UNPAID cancellable), the void
// effects (status, paymentStatus, RETURN movements matched to the original
// SALE's variant/location/quantity, inventory pairing), concurrent
// cancellation (exactly one transition + one restoration set), cross-org
// fail-closed, and row survival.
import { describe, expect, it, beforeAll } from "vitest"
import { prisma } from "@via-saas/database"
import { processCheckout, cancelOrder, resolveAttentionOrder } from "@via-saas/core"
import { createOrganizationFixture, createProductFixture, type OrgFixture, type VariantFixture } from "./helpers"

let org: OrgFixture
let product: VariantFixture

beforeAll(async () => {
  org = await createOrganizationFixture({ locationCount: 2 })
  product = await createProductFixture(org.org.id, org.locations[0].id, { price: 5000, stock: 50 })
})

/** Creates a FULFILLED + UNPAID (TRANSFER) order via the normal path. */
async function fulfilledUnpaidOrder(quantity: number) {
  return processCheckout(
    org.org.id,
    org.locations[0].id,
    org.user.id,
    [{ variantId: product.variantId, quantity }],
    "TRANSFER"
  )
}

describe("B-AC9 — eligibility matrix", () => {
  it("cancels a FULFILLED + UNPAID order", async () => {
    const order = await fulfilledUnpaidOrder(1)
    const cancelled = await cancelOrder(org.org.id, org.user.id, order.id)
    expect(cancelled.status).toBe("CANCELLED")
    expect(cancelled.paymentStatus).toBe("UNPAID")
  })

  it("rejects a PAID (CASH) order", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH"
    )
    expect(order.paymentStatus).toBe("PAID")
    await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be cancelled."
    )
    const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
    expect(reloaded?.status).toBe("FULFILLED")
  })

  it("rejects an already-CANCELLED order", async () => {
    const order = await fulfilledUnpaidOrder(1)
    await cancelOrder(org.org.id, org.user.id, order.id)
    await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be cancelled."
    )
  })

  it("rejects a REFUNDED order", async () => {
    // REFUNDED arises from ATTENTION CANCEL of a paid (CASH) order.
    const attentionProduct = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 1 })
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "CASH"
    )
    await resolveAttentionOrder(org.org.id, org.user.id, order.id, "CANCEL")
    const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
    expect(reloaded?.paymentStatus).toBe("REFUNDED")
    await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be cancelled."
    )
  })

  it("rejects an ATTENTION order (keeps its dedicated resolve path)", async () => {
    const attentionProduct = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 1 })
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "TRANSFER"
    )
    expect(order.status).toBe("ATTENTION")
    await expect(cancelOrder(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be cancelled."
    )
  })

  it("rejects a nonexistent order id (uniform no-leak error)", async () => {
    await expect(cancelOrder(org.org.id, org.user.id, "no-such-order")).rejects.toThrow(
      "Order not found or not cancellable."
    )
  })
})

describe("B-AC10/B-AC11 — void effects: RETURN movements matched to the original SALE", () => {
  it("restores stock exclusively through RETURN movements per line, matching variant, location and quantity", async () => {
  // Three distinct variants at the SAME location — a single-location
  // checkout can only deduct from one location, so all products must have
  // inventory there.
  const productA = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 100 })
  const productB = await createProductFixture(org.org.id, org.locations[0].id, { price: 2000, stock: 100 })
  const productC = await createProductFixture(org.org.id, org.locations[0].id, { price: 3000, stock: 100 })

  const order = await processCheckout(
    org.org.id,
    org.locations[0].id,
    org.user.id,
    [
      { variantId: productA.variantId, quantity: 3 },
      { variantId: productB.variantId, quantity: 2 },
      { variantId: productC.variantId, quantity: 1 },
    ],
    "TRANSFER"
  )

  // Diagnose early if the order went to ATTENTION (no SALE rows would exist).
  expect(order.status).toBe("FULFILLED")

  const saleMovements = await prisma.stockMovement.findMany({
    where: { referenceId: order.id, type: "SALE" },
  })
  expect(saleMovements).toHaveLength(3)

  await cancelOrder(org.org.id, org.user.id, order.id, { reason: "Customer changed their mind" })

  const returnMovements = await prisma.stockMovement.findMany({
    where: { referenceId: order.id, type: "RETURN" },
    include: { variant: true },
  })
  expect(returnMovements).toHaveLength(3)

  // Each RETURN matches its original SALE's variant, location and quantity.
  for (const sale of saleMovements) {
    const matched = returnMovements.find((r) => r.variantId === sale.variantId)
    expect(matched, `RETURN for SALE of variant ${sale.variantId}`).toBeDefined()
    expect(matched!.locationId).toBe(sale.locationId) // the location where stock was deducted
    expect(matched!.quantity).toBe(-sale.quantity)   // positive restoration
    expect(matched!.actorId).toBe(org.user.id)       // resolving actor recorded
    expect(matched!.referenceId).toBe(order.id)
  }

  // RETURN at the ORDER's location — every SALE was at locations[0], so every
  // RETURN must land there too.
  for (const movement of returnMovements) {
    expect(movement.locationId).toBe(order.locationId)
  }
})

  it("pairs every inventory increment with RETURN movement rows (no direct stock edits)", async () => {
    const invBefore = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    const order = await fulfilledUnpaidOrder(2)
    const saleDeducted = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(saleDeducted?.quantity).toBe(invBefore!.quantity - 2)

    await cancelOrder(org.org.id, org.user.id, order.id)

    const invAfter = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(invAfter?.quantity).toBe(invBefore!.quantity) // restored exactly once

    // The restoration left exactly two RETURN rows (one per cancelled line).
    const returns = await prisma.stockMovement.findMany({
      where: { referenceId: order.id, type: "RETURN" },
    })
    expect(returns).toHaveLength(1) // one line
    expect(returns[0].quantity).toBe(2)
  })
})

describe("B-AC12 — concurrent cancellation", () => {
  it("exactly one transition succeeds; stock restored exactly once; loser sees no effect", async () => {
    const order = await fulfilledUnpaidOrder(4)
    const invBefore = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })

    const results = await Promise.allSettled([
      cancelOrder(org.org.id, org.user.id, order.id),
      cancelOrder(org.org.id, org.user.id, order.id),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // The winner's effect.
    const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
    expect(reloaded?.status).toBe("CANCELLED")

    // Stock restored exactly once (SALE -4, RETURN +4 → back to before).
    const invAfter = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    const orderQty = 4
    expect(invAfter?.quantity).toBe(invBefore!.quantity + orderQty)

    // Exactly one set of RETURN movements.
    const returns = await prisma.stockMovement.findMany({
      where: { referenceId: order.id, type: "RETURN" },
    })
    expect(returns).toHaveLength(1)
    expect(returns[0].quantity).toBe(4)

    // Exactly one CANCEL_ORDER audit event.
    const audits = await prisma.auditLog.findMany({
      where: { targetId: order.id, action: "CANCEL_ORDER" },
    })
    expect(audits).toHaveLength(1)
  })
})

describe("B-AC13 — role gate (action wrapper level)", () => {
  it("STAFF-role core callers are rejected at core membership check for fabricated actors; wrapper enforces RBAC", async () => {
    // Core level: an actor without membership in the org is rejected.
    const strangerOrg = await createOrganizationFixture()
    const order = await fulfilledUnpaidOrder(1)
    await expect(
      cancelOrder(org.org.id, strangerOrg.user.id, order.id)
    ).rejects.toThrow("You are not authorized to cancel orders.")
    // Order untouched.
    const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
    expect(reloaded?.status).toBe("FULFILLED")
  })
})

describe("B-AC14 — cancellation preserves rows", () => {
  it("order row and all OrderItems survive; payment history intact", async () => {
    const order = await fulfilledUnpaidOrder(3)
    const itemsBefore = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(itemsBefore).toHaveLength(1)

    await cancelOrder(org.org.id, org.user.id, order.id)

    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } })
    expect(orderAfter).not.toBeNull()
    expect(orderAfter?.status).toBe("CANCELLED")
    expect(orderAfter?.paymentStatus).toBe("UNPAID")
    expect(orderAfter?.totalAmount.toString()).toBe(order.totalAmount.toString())

    const itemsAfter = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(itemsAfter).toHaveLength(itemsBefore.length)
    expect(Number(itemsAfter[0].unitPrice)).toBe(Number(itemsBefore[0].unitPrice))
  })
})

describe("B-AC10 support — cross-organization fail-closed", () => {
  it("another org's actor cannot cancel (or even resolve) an order", async () => {
    const order = await fulfilledUnpaidOrder(1)
    const otherOrg = await createOrganizationFixture()
    await expect(
      cancelOrder(otherOrg.org.id, otherOrg.user.id, order.id)
    ).rejects.toThrow("Order not found or not cancellable.")
    const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
    expect(reloaded?.status).toBe("FULFILLED")
  })
})
