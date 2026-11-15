import { prisma } from "@via-saas/database"
import { logAuditEvent } from "./audit"
import { DomainError } from "./errors"

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
  if (!data.name?.trim()) {
    throw new DomainError("VALIDATION", "Product name is required.")
  }
  if (!Number.isFinite(data.price) || data.price <= 0) {
    throw new DomainError("VALIDATION", "Price must be a positive number.")
  }
  if (!Number.isInteger(data.stock) || data.stock < 0) {
    throw new DomainError("VALIDATION", "Initial stock must be a non-negative whole number.")
  }

  return prisma.$transaction(async (tx) => {
    // TENANT AUTHORIZATION: the target location must belong to the organization.
    const location = await tx.location.findFirst({
      where: { id: locationId, store: { organizationId: orgId } },
      select: { id: true },
    })
    if (!location) {
      throw new DomainError("FORBIDDEN", "Invalid location for this business.")
    }

    const product = await tx.product.create({
      data: { name: data.name, organizationId: orgId, status: "PUBLISHED" }
    })

    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        sku: data.sku?.trim() || undefined,
        name: "Default",
        sellingPrice: data.price,
        // NOTE: costPrice defaults remain unchanged in M1 (E-21, priority P1 —
        // explicit cost input is scheduled with catalogue management).
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
  if (!Number.isInteger(adjustment) || adjustment === 0) {
    throw new DomainError("VALIDATION", "Adjustment must be a non-zero whole number.")
  }
  if (!reason?.trim()) {
    throw new DomainError("VALIDATION", "A reason is required for stock adjustments.")
  }

  return prisma.$transaction(async (tx) => {
    // TENANT AUTHORIZATION: variant and location must both belong to the
    // caller's organization before any inventory change is possible.
    const [variant, location] = await Promise.all([
      tx.productVariant.findFirst({
        where: { id: variantId, product: { organizationId: orgId } },
        select: { id: true },
      }),
      tx.location.findFirst({
        where: { id: locationId, store: { organizationId: orgId } },
        select: { id: true },
      }),
    ])
    if (!variant || !location) {
      throw new DomainError("FORBIDDEN", "You are not authorized to adjust this inventory.")
    }

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
      throw new DomainError("INSUFFICIENT_STOCK", "Insufficient stock to remove this quantity.")
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
