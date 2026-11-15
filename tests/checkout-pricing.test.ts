// AC-3 — Server-authoritative pricing (E-1 regression tests).
// The server must compute totals from database prices; client-supplied price
// fields must be incapable of influencing recorded amounts.
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { processCheckout } from "@via-saas/core"
import { createOrganizationFixture, createProductFixture } from "./helpers"

describe("server-authoritative pricing (E-1)", () => {
  it("computes the order total from database prices, not client values", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { price: 5000, stock: 50 })

    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 2 }],
      "CASH"
    )

    expect(Number(order.totalAmount)).toBe(10000) // 2 × 5000
    expect(order.paymentStatus).toBe("PAID")
    expect(order.status).toBe("FULFILLED")

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(items).toHaveLength(1)
    expect(Number(items[0].unitPrice)).toBe(5000)
  })

  it("ignores any client-supplied price fields in the payload", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { price: 5000, stock: 50 })

    // Malicious/misbehaving client adds a price of 1 to the payload
    const maliciousItems = [
      { variantId: product.variantId, quantity: 2, price: 1 },
    ] as unknown as { variantId: string; quantity: number }[]

    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      maliciousItems,
      "CASH"
    )

    expect(Number(order.totalAmount)).toBe(10000)
  })

  it("rejects items belonging to another organization (cross-tenant cart)", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const productB = await createProductFixture(orgB.org.id, orgB.locations[0].id)

    await expect(
      processCheckout(
        orgA.org.id,
        orgA.locations[0].id,
        orgA.user.id,
        [{ variantId: productB.variantId, quantity: 1 }],
        "CASH"
      )
    ).rejects.toMatchObject({ code: "ITEM_UNAVAILABLE" })
  })

  it("rejects an empty cart and invalid quantities", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id)

    await expect(
      processCheckout(org.org.id, org.locations[0].id, org.user.id, [], "CASH")
    ).rejects.toMatchObject({ code: "EMPTY_CART" })

    await expect(
      processCheckout(org.org.id, org.locations[0].id, org.user.id, [
        { variantId: product.variantId, quantity: 0 },
      ], "CASH")
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("merges duplicate variant entries and deducts stock once per merged quantity", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 100 })

    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [
        { variantId: product.variantId, quantity: 2 },
        { variantId: product.variantId, quantity: 3 },
      ],
      "CASH"
    )

    expect(Number(order.totalAmount)).toBe(5000)

    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(95) // 100 - 5

    const movements = await prisma.stockMovement.findMany({ where: { referenceId: order.id } })
    expect(movements).toHaveLength(1)
    expect(movements[0].quantity).toBe(-5)
  })

  it("rejects unsupported payment methods", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id)

    await expect(
      processCheckout(
        org.org.id,
        org.locations[0].id,
        org.user.id,
        [{ variantId: product.variantId, quantity: 1 }],
        "CARD" as "CASH"
      )
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("records system-originated movements with a null actor (E-3)", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id)

    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      null, // storefront / system actor
      [{ variantId: product.variantId, quantity: 1 }],
      "TRANSFER"
    )

    const movements = await prisma.stockMovement.findMany({ where: { referenceId: order.id } })
    expect(movements).toHaveLength(1)
    expect(movements[0].actorId).toBeNull()
    expect(order.paymentStatus).toBe("UNPAID") // TRANSFER is not verified money
  })

  it("falls back to an ATTENTION order (no deduction) when any item lacks stock", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })

    // Second item the org owns but with no stock at this location
    const product2 = await createProductFixture(org.org.id, org.locations[0].id, { stock: 0 })

    // The designed fallback: the whole deduction transaction rolls back and the
    // order is re-created as ATTENTION (E-5 behavior) with server-computed total.
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [
        { variantId: product.variantId, quantity: 1 },
        { variantId: product2.variantId, quantity: 1 },
      ],
      "CASH"
    )

    expect(order.status).toBe("ATTENTION")

    // Rolled back: stock unchanged, no movements were written
    const orders = await prisma.order.findMany({ where: { organizationId: org.org.id } })
    expect(orders).toHaveLength(1)
    expect(orders[0].status).toBe("ATTENTION")
    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(1)
    const movements = await prisma.stockMovement.count({ where: { variantId: product.variantId } })
    expect(movements).toBe(0)
  })
})
