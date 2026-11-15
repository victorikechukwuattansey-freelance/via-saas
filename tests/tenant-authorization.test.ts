// AC-4 — Tenant and location authorization matrix (E-4, E-5, E-11).
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import {
  adjustInventory,
  processCheckout,
  resolveAttentionOrder,
} from "@via-saas/core"
import { createOrganizationFixture, createProductFixture } from "./helpers"

async function createAttentionOrder(orgId: string, locationId: string, userId: string, variantId: string) {
  // Force an ATTENTION order by ordering more than available stock.
  await prisma.inventory.updateMany({
    where: { locationId, variantId },
    data: { quantity: 0 },
  })
  const order = await processCheckout(
    orgId,
    locationId,
    userId,
    [{ variantId, quantity: 1 }],
    "CASH"
  )
  await prisma.inventory.updateMany({
    where: { locationId, variantId },
    data: { quantity: 10 },
  })
  return order
}

describe("tenant authorization matrix (E-4/E-5)", () => {
  it("allows resolving an ATTENTION order within the same organization", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id)
    const order = await createAttentionOrder(org.org.id, org.locations[0].id, org.user.id, product.variantId)

    const resolved = await resolveAttentionOrder(org.org.id, org.user.id, order.id, "FULFILL")
    expect(resolved.status).toBe("FULFILLED")
  })

  it("DENIES resolving another organization's order (cross-org write)", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const productA = await createProductFixture(orgA.org.id, orgA.locations[0].id)
    const orderA = await createAttentionOrder(orgA.org.id, orgA.locations[0].id, orgA.user.id, productA.variantId)

    await expect(
      resolveAttentionOrder(orgB.org.id, orgB.user.id, orderA.id, "FULFILL")
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" })

    // The order must be untouched
    const untouched = await prisma.order.findUnique({ where: { id: orderA.id } })
    expect(untouched?.status).toBe("ATTENTION")
  })

  it("DENIES resolution by a non-member actor", async () => {
    const orgA = await createOrganizationFixture()
    const stranger = await createOrganizationFixture()
    const productA = await createProductFixture(orgA.org.id, orgA.locations[0].id)
    const orderA = await createAttentionOrder(orgA.org.id, orgA.locations[0].id, orgA.user.id, productA.variantId)

    await expect(
      resolveAttentionOrder(orgA.org.id, stranger.user.id, orderA.id, "FULFILL")
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("DENIES checkout into another organization's location", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const productA = await createProductFixture(orgA.org.id, orgA.locations[0].id)

    await expect(
      processCheckout(
        orgA.org.id,
        orgB.locations[0].id, // location owned by org B
        orgA.user.id,
        [{ variantId: productA.variantId, quantity: 1 }],
        "CASH"
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("DENIES adjusting inventory of another organization's variant", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const productB = await createProductFixture(orgB.org.id, orgB.locations[0].id)

    await expect(
      adjustInventory(
        orgA.org.id,
        orgA.user.id,
        orgA.locations[0].id,
        productB.variantId,
        5,
        "restock"
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    const inventory = await prisma.inventory.findUnique({ where: { id: productB.inventoryId } })
    expect(inventory?.quantity).toBe(100) // unchanged
  })

  it("DENIES adjusting inventory at another organization's location", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const productA = await createProductFixture(orgA.org.id, orgA.locations[0].id)

    await expect(
      adjustInventory(
        orgA.org.id,
        orgA.user.id,
        orgB.locations[0].id, // location owned by org B
        productA.variantId,
        5,
        "restock"
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    const inventory = await prisma.inventory.findUnique({ where: { id: productA.inventoryId } })
    expect(inventory?.quantity).toBe(100) // unchanged
  })

  it("allows same-organization adjustments across that org's own locations", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const product = await createProductFixture(org.org.id, org.locations[0].id)

    // Seed an inventory row at the second location (same org)
    const inventory2 = await prisma.inventory.create({
      data: { locationId: org.locations[1].id, variantId: product.variantId, quantity: 0 },
    })

    const result = await adjustInventory(
      org.org.id,
      org.user.id,
      org.locations[1].id, // same org, different location — authorized
      product.variantId,
      5,
      "restock"
    )
    expect(result.success).toBe(true)

    const updated = await prisma.inventory.findUnique({ where: { id: inventory2.id } })
    expect(updated?.quantity).toBe(5)
  })
})

describe("inventory transaction behavior (regression)", () => {
  it("blocks removals below zero and leaves stock unchanged", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id, { stock: 5 })

    await expect(
      adjustInventory(org.org.id, org.user.id, org.locations[0].id, product.variantId, -10, "shrinkage")
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" })

    const inventory = await prisma.inventory.findUnique({ where: { id: product.inventoryId } })
    expect(inventory?.quantity).toBe(5)
  })

  it("records valid adjustment movements with the real actor", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id)

    await adjustInventory(org.org.id, org.user.id, org.locations[0].id, product.variantId, 7, "delivery")

    const movement = await prisma.stockMovement.findFirst({
      where: { variantId: product.variantId, type: "ADDED" },
    })
    expect(movement?.actorId).toBe(org.user.id)
    expect(movement?.quantity).toBe(7)
  })

  it("rejects zero adjustments and missing reasons", async () => {
    const org = await createOrganizationFixture()
    const product = await createProductFixture(org.org.id, org.locations[0].id)

    await expect(
      adjustInventory(org.org.id, org.user.id, org.locations[0].id, product.variantId, 0, "no-op")
    ).rejects.toMatchObject({ code: "VALIDATION" })

    await expect(
      adjustInventory(org.org.id, org.user.id, org.locations[0].id, product.variantId, 1, "  ")
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })
})
