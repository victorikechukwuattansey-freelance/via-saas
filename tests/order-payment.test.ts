// P1-B payment recording (D-B/D-D / P1-10) — B-AC15..18.
//
// Covers: eligibility matrix (only TRANSFER + UNPAID + FULFILLED transitions
// to PAID), concurrency (exactly one transition + one audit event),
// actor/timestamp recording, merchant-confirmation semantics (no money
// movement, no verification), and paymentMethod persistence incl. legacy NULL.
import { describe, expect, it, beforeAll } from "vitest"
import { prisma } from "@via-saas/database"
import { processCheckout, recordPaymentReceived, cancelOrder, resolveAttentionOrder } from "@via-saas/core"
import { createOrganizationFixture, createProductFixture, type OrgFixture, type VariantFixture } from "./helpers"

let org: OrgFixture
let product: VariantFixture

beforeAll(async () => {
  org = await createOrganizationFixture()
  product = await createProductFixture(org.org.id, org.locations[0].id, { price: 2000, stock: 50 })
})

async function transferOrder(quantity = 1) {
  return processCheckout(
    org.org.id,
    org.locations[0].id,
    org.user.id,
    [{ variantId: product.variantId, quantity }],
    "TRANSFER"
  )
}

describe("B-AC15 — eligibility matrix", () => {
  it("transitions a TRANSFER + UNPAID + FULFILLED order to PAID", async () => {
    const order = await transferOrder()
    expect(order.paymentMethod).toBe("TRANSFER")
    expect(order.paymentStatus).toBe("UNPAID")
    expect(order.status).toBe("FULFILLED")

    const updated = await recordPaymentReceived(org.org.id, org.user.id, order.id)
    expect(updated.paymentStatus).toBe("PAID")
    expect(updated.status).toBe("FULFILLED")
  })

  it("rejects an ATTENTION order (even unpaid)", async () => {
    const attentionProduct = await createProductFixture(org.org.id, org.locations[0].id, { price: 1000, stock: 1 })
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "TRANSFER"
    )
    expect(order.status).toBe("ATTENTION")
    await expect(recordPaymentReceived(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be marked as paid."
    )
  })

  it("rejects a CANCELLED order", async () => {
    const order = await transferOrder()
    await cancelOrder(org.org.id, org.user.id, order.id)
    await expect(recordPaymentReceived(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be marked as paid."
    )
  })

  it("rejects an already-PAID order", async () => {
    const order = await transferOrder()
    await recordPaymentReceived(org.org.id, org.user.id, order.id)
    await expect(recordPaymentReceived(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be marked as paid."
    )
    // Exactly one audit event despite the rejected retry.
    const audits = await prisma.auditLog.findMany({
      where: { targetId: order.id, action: "PAYMENT_RECORDED" },
    })
    expect(audits).toHaveLength(1)
  })

  it("rejects a REFUNDED order", async () => {
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
    await expect(recordPaymentReceived(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be marked as paid."
    )
  })

  it("rejects a CASH order (already PAID at creation)", async () => {
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH"
    )
    expect(order.paymentStatus).toBe("PAID")
    await expect(recordPaymentReceived(org.org.id, org.user.id, order.id)).rejects.toThrow(
      "Only unpaid fulfilled orders can be marked as paid."
    )
  })

  it("rejects a nonexistent order id (uniform no-leak error)", async () => {
    await expect(recordPaymentReceived(org.org.id, org.user.id, "no-such-order")).rejects.toThrow(
      "Order not found or not payable."
    )
  })
})

describe("B-AC16 — concurrent payment recording", () => {
  it("exactly one successful transition and exactly one PAYMENT_RECORDED audit event", async () => {
    const order = await transferOrder(2)

    const results = await Promise.allSettled([
      recordPaymentReceived(org.org.id, org.user.id, order.id),
      recordPaymentReceived(org.org.id, org.user.id, order.id),
    ])

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)

    const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
    expect(reloaded?.paymentStatus).toBe("PAID")

    const audits = await prisma.auditLog.findMany({
      where: { targetId: order.id, action: "PAYMENT_RECORDED" },
    })
    expect(audits).toHaveLength(1)
  })
})

describe("B-AC17 — actor + timestamp recorded; confirmation semantics", () => {
  it("records the authenticated actor; the audit metadata claims no verification or money movement", async () => {
    const order = await transferOrder()
    const before = await prisma.order.findUnique({ where: { id: order.id } })

    const updated = await recordPaymentReceived(org.org.id, org.user.id, order.id)
    expect(updated.paymentStatus).toBe("PAID")
    // Timestamp effect: updatedAt advanced (D-B persistence requirement).
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime())

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: order.id, action: "PAYMENT_RECORDED" },
    })
    expect(audit?.actorId).toBe(org.user.id)
    expect(audit?.organizationId).toBe(org.org.id)
    const metadata = audit?.metadata as Record<string, unknown>
    expect(metadata.orderNumber).toBe(order.orderNumber)
    // The metadata records the method ONLY — no provider/bank verification
    // claim, no money-movement claim.
    expect(JSON.stringify(metadata)).not.toMatch(/verif|provider|bank|charge|capture/i)
  })

  it("an actor outside the organization is rejected (no-leak)", async () => {
    const order = await transferOrder()
    const otherOrg = await createOrganizationFixture()
    await expect(
      recordPaymentReceived(otherOrg.org.id, otherOrg.user.id, order.id)
    ).rejects.toThrow("Order not found or not payable.")
    const reloaded = await prisma.order.findUnique({ where: { id: order.id } })
    expect(reloaded?.paymentStatus).toBe("UNPAID")
  })
})

describe("B-AC18 — paymentMethod persistence", () => {
  it("records CASH/TRANSFER at creation (D-D)", async () => {
    const cash = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH"
    )
    expect(cash.paymentMethod).toBe("CASH")

    const transfer = await transferOrder()
    expect(transfer.paymentMethod).toBe("TRANSFER")
  })

  it("legacy NULL paymentMethod orders remain eligible (state-based condition)", async () => {
    const order = await transferOrder()
    // Simulate a pre-P1-B order: paymentMethod unknown (NULL).
    await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: null } })

    const updated = await recordPaymentReceived(org.org.id, org.user.id, order.id)
    expect(updated.paymentStatus).toBe("PAID")
  })
})
