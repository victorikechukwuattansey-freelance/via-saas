import { prisma } from "@via-saas/database"
import { logAuditEvent } from "./audit"

export async function getProductsByOrg(orgId: string) {
  return prisma.product.findMany({
    where: { organizationId: orgId },
    include: {
      variants: {
        include: { inventory: true }
      }
    }
  })
}

export async function createProduct(orgId: string, actorId: string, locationId: string, data: { name: string, sku?: string, price: number, stock: number }) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: { name: data.name, organizationId: orgId, status: "PUBLISHED" }
    })

    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        sku: data.sku || undefined,
        name: "Default",
        sellingPrice: data.price,
        costPrice: data.price * 0.5,
      }
    })

    await tx.inventory.create({
      data: { locationId, variantId: variant.id, quantity: data.stock }
    })

    // ADD AUDIT LOG
    await logAuditEvent(orgId, actorId, "CREATE_PRODUCT", product.id, { name: data.name, price: data.price })

    return product
  })
}


export async function adjustInventory(
  orgId: string,
  actorId: string,
  locationId: string,
  variantId: string,
  adjustment: number, // Positive for ADDED, negative for REMOVED
  reason: string
) {
  return prisma.$transaction(async (tx) => {
    // 1. Atomically update inventory (prevent negative stock)
    const updateResult = await tx.inventory.updateMany({
      where: { 
        locationId, 
        variantId, 
        quantity: adjustment < 0 ? { gte: Math.abs(adjustment) } : undefined 
      },
      data: { quantity: { increment: adjustment } }
    })

    if (updateResult.count === 0) {
      throw new Error("Insufficient stock to remove this quantity.")
    }

    // 2. Log the Stock Movement
    await tx.stockMovement.create({
      data: {
        locationId,
        variantId,
        actorId,
        type: adjustment > 0 ? "ADDED" : "REMOVED",
        quantity: adjustment,
        referenceId: reason // Using referenceId to store the manual reason
      }
    })

    // 3. Log the Audit Event
    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", variantId, { 
      action: "INVENTORY_ADJUSTMENT", 
      adjustment, 
      reason 
    })

    return { success: true }
  })
}
