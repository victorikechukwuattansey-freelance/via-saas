// AC-5 — ATTENTION order lifecycle and StockMovement actor integrity (E-3/E-5).
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { processCheckout, resolveAttentionOrder } from "@via-saas/core"
import { createOrganizationFixture, createProductFixture } from "./helpers"

describe("ATTENTION orders (stock conflicts)", () => {
  it("creates an ATTENTION order without deducting stock when inventory is insufficient", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })

    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 5 }],
      "CASH"
    )

    expect(order.status).toBe("ATTENTION")
    expect(Number(order.totalAmount)).toBe(25000) // server-priced

    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(1) // unchanged

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(5)
    expect(Number(items[0].unitPrice)).toBe(5000)

    // No stock movements were written for the unfulfilled sale
    const movements = await prisma.stockMovement.count({ where: { referenceId: order.id } })
    expect(movements).toBe(0)
  })

  it("FULFILL deducts stock, writes movements with the REAL resolving actor, and flips status", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })

    const attention = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 5 }],
      "CASH"
    )

    // Merchant restocks the shelf
    await prisma.inventory.update({
      where: { id: product.inventoryId },
      data: { quantity: 10 },
    })

    const fulfilled = await resolveAttentionOrder(org.org.id, org.user.id, attention.id, "FULFILL")
    expect(fulfilled.status).toBe("FULFILLED")

    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(5) // 10 - 5

    const movements = await prisma.stockMovement.findMany({ where: { referenceId: attention.id } })
    expect(movements).toHaveLength(1)
    // AC-5: the movement references the actual resolving User (never "SYSTEM")
    expect(movements[0].actorId).toBe(org.user.id)
    expect(movements[0].quantity).toBe(-5)
    expect(movements[0].type).toBe("SALE")

    const audit = await prisma.auditLog.findFirst({
      where: { action: "RESOLVE_ORDER", targetId: attention.id },
    })
    expect(audit).not.toBeNull()
    expect(audit?.actorId).toBe(org.user.id)
  })

  it("FULFILL fails safely when stock is still insufficient (order stays ATTENTION)", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })

    const attention = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 5 }],
      "CASH"
    )

    await expect(
      resolveAttentionOrder(org.org.id, org.user.id, attention.id, "FULFILL")
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" })

    const still = await prisma.order.findUnique({ where: { id: attention.id } })
    expect(still?.status).toBe("ATTENTION")

    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(1) // unchanged
    const movements = await prisma.stockMovement.count({ where: { referenceId: attention.id } })
    expect(movements).toBe(0)
  })

  it("CANCEL flips a paid ATTENTION order to CANCELLED/REFUNDED without touching stock", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    const attention = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 50 }],
      "CASH" // paid
    )
    expect(attention.status).toBe("ATTENTION")

    const cancelled = await resolveAttentionOrder(org.org.id, org.user.id, attention.id, "CANCEL")
    expect(cancelled.status).toBe("CANCELLED")
    expect(cancelled.paymentStatus).toBe("REFUNDED")

    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(10) // unchanged
  })
})
