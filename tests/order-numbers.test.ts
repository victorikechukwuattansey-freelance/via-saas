// E-14/E-15 — Order numbers: DB-unique, sequential, collision-safe.
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { processCheckout } from "@via-saas/core"
import { createOrganizationFixture, createProductFixture } from "./helpers"

describe("order number allocation (E-14/E-15)", () => {
  it("allocates sequential numbers starting at ORD-1001", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 100 })

    const first = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH"
    )
    const second = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH"
    )

    expect(first.orderNumber).toBe("ORD-1001")
    expect(second.orderNumber).toBe("ORD-1002")
  })

  it("keeps numbers unique under parallel checkout load", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 100 })

    const orders = await Promise.all(
      Array.from({ length: 8 }, () =>
        processCheckout(
          org.org.id,
          org.locations[0].id,
          org.user.id,
          [{ variantId: product.variantId, quantity: 1 }],
          "CASH"
        )
      )
    )

    const numbers = orders.map((order) => order.orderNumber)
    expect(new Set(numbers).size).toBe(8)

    const allOrders = await prisma.order.findMany({
      where: { organizationId: org.org.id },
      select: { orderNumber: true },
    })
    expect(allOrders).toHaveLength(8)
    expect(new Set(allOrders.map((o) => o.orderNumber)).size).toBe(8)

    // Stock deducted exactly once per order
    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(92)
  })

  it("separates counters per organization (same prefix, independent sequences)", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const productA = await createProductFixture(orgA.org.id, orgA.locations[0].id)
    const productB = await createProductFixture(orgB.org.id, orgB.locations[0].id)

    await processCheckout(orgA.org.id, orgA.locations[0].id, orgA.user.id, [
      { variantId: productA.variantId, quantity: 1 },
    ], "CASH")

    const orderB = await processCheckout(orgB.org.id, orgB.locations[0].id, orgB.user.id, [
      { variantId: productB.variantId, quantity: 1 },
    ], "CASH")

    // Each organization starts at its own 1001
    expect(orderB.orderNumber).toBe("ORD-1001")
  })

  it("the database enforces (organizationId, orderNumber) uniqueness", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id)

    // Directly attempt the collision the old random generator could produce
    await expect(
      prisma.order.create({
        data: {
          organizationId: org.org.id,
          locationId: org.locations[0].id,
          orderNumber: "ORD-1001",
          status: "FULFILLED",
          paymentStatus: "PAID",
          totalAmount: 1,
        },
      })
    ).resolves.toBeTruthy()

    await expect(
      prisma.order.create({
        data: {
          organizationId: org.org.id,
          locationId: org.locations[0].id,
          orderNumber: "ORD-1001",
          status: "FULFILLED",
          paymentStatus: "PAID",
          totalAmount: 1,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" })
  })
})
