import { prisma } from "@via-saas/database"
import { Prisma } from "@prisma/client"
import { logAuditEvent } from "./audit"
import { DomainError } from "./errors"

const PRODUCT_STATUSES = ["DRAFT", "PUBLISHED"] as const
type ProductStatus = (typeof PRODUCT_STATUSES)[number]

function isProductStatus(value: unknown): value is ProductStatus {
  return typeof value === "string" && (PRODUCT_STATUSES as readonly string[]).includes(value)
}

function validatePositivePrice(price: number, label: string) {
  if (!Number.isFinite(price) || price <= 0) {
    throw new DomainError("VALIDATION", `${label} must be a positive number.`)
  }
}

function validateUrl(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DomainError("VALIDATION", "Image must be a valid URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DomainError("VALIDATION", "Image URL must start with http:// or https://.")
  }
}

/**
 * Maps the per-organization unique-violation fallback (race between the
 * pre-check below and a concurrent insert) onto a safe domain error.
 */
function mapUniqueViolation(error: unknown, label: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new DomainError("CONFLICT", `${label} is already in use by another product in your business.`)
  }
  throw error as never
}

export async function getProductsByOrg(orgId: string) {
  return prisma.product.findMany({
    where: { organizationId: orgId },
    include: {
      variants: {
        include: { inventory: true }
      },
      images: true,
      category: true,
    },
  })
}

/**
 * Storefront contract (P1-A, AC-A6): only PUBLISHED, non-archived products are
 * publicly visible. Drafts and archived products are never exposed, while all
 * order/inventory history for them is retained server-side.
 */
export async function getStorefrontProducts(orgId: string) {
  return prisma.product.findMany({
    where: { organizationId: orgId, status: "PUBLISHED", archivedAt: null },
    include: {
      variants: {
        include: { inventory: true }
      },
      images: { orderBy: { sortOrder: "asc" } },
    },
  })
}

export async function createProduct(
  orgId: string,
  actorId: string,
  locationId: string,
  data: { name: string, sku?: string, price: number, stock: number, cost?: number, description?: string }
) {
  if (!data.name?.trim()) {
    throw new DomainError("VALIDATION", "Product name is required.")
  }
  validatePositivePrice(data.price, "Price")
  if (!Number.isInteger(data.stock) || data.stock < 0) {
    throw new DomainError("VALIDATION", "Initial stock must be a non-negative whole number.")
  }
  // E-21: cost is EXPLICIT, never fabricated. Absent cost = "not tracked" (0).
  if (data.cost !== undefined && (!Number.isFinite(data.cost) || data.cost < 0)) {
    throw new DomainError("VALIDATION", "Cost must be a non-negative number.")
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

    if (data.sku?.trim()) {
      const existing = await tx.productVariant.findFirst({
        where: { organizationId: orgId, sku: data.sku.trim() },
        select: { id: true },
      })
      if (existing) {
        throw new DomainError("CONFLICT", "This SKU is already used by another product in your business.")
      }
    }

    const product = await tx.product.create({
      data: {
        name: data.name,
        description: data.description?.trim() || null,
        organizationId: orgId,
        status: "PUBLISHED"
      }
    })

    const variant = await tx.productVariant.create({
      data: {
        productId: product.id,
        organizationId: orgId,
        sku: data.sku?.trim() || undefined,
        name: "Default",
        sellingPrice: data.price,
        // Explicit cost capture (E-21). No valuation engine (P1 boundary).
        costPrice: data.cost ?? 0,
      }
    })

    await tx.inventory.create({
      data: { locationId, variantId: variant.id, quantity: data.stock }
    })

    // ADD AUDIT LOG
    await logAuditEvent(orgId, actorId, "CREATE_PRODUCT", product.id, { name: data.name, price: data.price, cost: data.cost ?? 0 })

    return product
  })
}

/**
 * Edits a product's own fields (name/description/status/category). Variant
 * prices are edited via updateVariant — the server never accepts client
 * prices as authoritative anywhere.
 */
export async function updateProduct(
  orgId: string,
  actorId: string,
  productId: string,
  data: { name?: string; description?: string | null; status?: string; categoryId?: string | null }
) {
  return prisma.$transaction(async (tx) => {
    // TENANT AUTHORIZATION: fail closed on cross-org access (NOT_FOUND —
    // never confirm existence to a foreign tenant).
    const product = await tx.product.findFirst({
      where: { id: productId, organizationId: orgId },
      select: { id: true, name: true, description: true, status: true, categoryId: true },
    })
    if (!product) {
      throw new DomainError("NOT_FOUND", "Product not found.")
    }

    const next: Record<string, unknown> = {}

    if (data.name !== undefined) {
      if (!data.name?.trim()) {
        throw new DomainError("VALIDATION", "Product name cannot be empty.")
      }
      next.name = data.name.trim()
    }

    if (data.description !== undefined) {
      next.description = data.description?.trim() || null
    }

    if (data.status !== undefined) {
      if (!isProductStatus(data.status)) {
        throw new DomainError("VALIDATION", "Status must be DRAFT or PUBLISHED.")
      }
      // Publish gating (decision D-13): a product may only be (re)published
      // with at least one variant carrying a positive selling price.
      if (data.status === "PUBLISHED") {
        const sellable = await tx.productVariant.findFirst({
          where: { productId: product.id, sellingPrice: { gt: 0 } },
          select: { id: true },
        })
        if (!sellable) {
          throw new DomainError("VALIDATION", "A product needs at least one variant with a price before it can be published.")
        }
      }
      next.status = data.status
    }

    if (data.categoryId !== undefined) {
      if (data.categoryId === null) {
        next.categoryId = null
      } else {
        // TENANT AUTHORIZATION: the category must belong to this organization.
        const category = await tx.category.findFirst({
          where: { id: data.categoryId, organizationId: orgId },
          select: { id: true },
        })
        if (!category) {
          throw new DomainError("NOT_FOUND", "Category not found.")
        }
        next.categoryId = data.categoryId
      }
    }

    const updated = await tx.product.update({
      where: { id: product.id },
      data: next,
      select: { id: true, name: true, description: true, status: true, categoryId: true },
    })

    // Exactly one audit event per mutation, with before/after metadata (X-2).
    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", product.id, {
      action: "PRODUCT_UPDATE",
      before: product,
      after: updated,
    })

    return updated
  })
}

/** Soft archival (decision D-12): history is retained, listing is suppressed. */
export async function archiveProduct(orgId: string, actorId: string, productId: string) {
  const updated = await prisma.product.updateMany({
    where: { id: productId, organizationId: orgId, archivedAt: null },
    data: { archivedAt: new Date() },
  })

  if (updated.count === 0) {
    // Distinguish already-archived (no-op, idempotent) from foreign/missing.
    const existing = await prisma.product.findFirst({
      where: { id: productId, organizationId: orgId },
      select: { id: true },
    })
    if (existing) return { success: true as const }
    throw new DomainError("NOT_FOUND", "Product not found.")
  }

  await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", productId, { action: "PRODUCT_ARCHIVE" })
  return { success: true as const }
}

export async function restoreProduct(orgId: string, actorId: string, productId: string) {
  const updated = await prisma.product.updateMany({
    where: { id: productId, organizationId: orgId, archivedAt: { not: null } },
    data: { archivedAt: null },
  })

  if (updated.count === 0) {
    const existing = await prisma.product.findFirst({
      where: { id: productId, organizationId: orgId },
      select: { id: true },
    })
    if (existing) return { success: true as const } // already live — idempotent
    throw new DomainError("NOT_FOUND", "Product not found.")
  }

  await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", productId, { action: "PRODUCT_RESTORE" })
  return { success: true as const }
}

/**
 * Guarded hard delete (decision D-12): only allowed for products never
 * referenced by orders, stock movements, or cart items. Anything with history
 * must be archived instead — history is never destroyed.
 */
export async function deleteProduct(orgId: string, actorId: string, productId: string) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, organizationId: orgId },
      select: { id: true, name: true },
    })
    if (!product) {
      throw new DomainError("NOT_FOUND", "Product not found.")
    }

    const [orderItemCount, movementCount, cartItemCount, stockHoldingCount] = await Promise.all([
      tx.orderItem.count({ where: { variant: { productId } } }),
      tx.stockMovement.count({ where: { variant: { productId } } }),
      tx.cartItem.count({ where: { variant: { productId } } }),
      tx.inventory.aggregate({ where: { variant: { productId } }, _sum: { quantity: true } }),
    ])

    if (orderItemCount > 0 || movementCount > 0 || cartItemCount > 0) {
      throw new DomainError(
        "CONFLICT",
        "This product has sales or stock history and cannot be deleted. Archive it instead."
      )
    }
    if ((stockHoldingCount._sum.quantity ?? 0) !== 0) {
      throw new DomainError(
        "CONFLICT",
        "This product still holds stock. Reduce its stock to zero before deleting."
      )
    }

    await tx.product.delete({ where: { id: product.id } })

    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", productId, {
      action: "PRODUCT_DELETE",
      name: product.name,
    })

    return { success: true as const }
  })
}

/**
 * Adds a variant to an existing product. Runs the same guarded patterns as
 * createProduct: org-scoped product + owned location, per-org SKU uniqueness
 * (D-2), explicit cost (E-21). The initial stock row is created directly (the
 * ledger covers mutations after creation — same semantics as createProduct).
 */
export async function addVariant(
  orgId: string,
  actorId: string,
  productId: string,
  locationId: string,
  data: { name: string; sku?: string; barcode?: string; sellingPrice: number; costPrice?: number; initialStock: number }
) {
  if (!data.name?.trim()) {
    throw new DomainError("VALIDATION", "Variant name is required.")
  }
  validatePositivePrice(data.sellingPrice, "Price")
  if (data.costPrice !== undefined && (!Number.isFinite(data.costPrice) || data.costPrice < 0)) {
    throw new DomainError("VALIDATION", "Cost must be a non-negative number.")
  }
  if (!Number.isInteger(data.initialStock) || data.initialStock < 0) {
    throw new DomainError("VALIDATION", "Initial stock must be a non-negative whole number.")
  }

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, organizationId: orgId },
      select: { id: true, archivedAt: true },
    })
    if (!product) {
      throw new DomainError("NOT_FOUND", "Product not found.")
    }
    if (product.archivedAt) {
      throw new DomainError("VALIDATION", "Archived products cannot be changed. Restore it first.")
    }

    const location = await tx.location.findFirst({
      where: { id: locationId, store: { organizationId: orgId } },
      select: { id: true },
    })
    if (!location) {
      throw new DomainError("FORBIDDEN", "Invalid location for this business.")
    }

    for (const field of ["sku", "barcode"] as const) {
      const value = data[field]?.trim()
      if (!value) continue
      const existing = await tx.productVariant.findFirst({
        where: { organizationId: orgId, [field]: value },
        select: { id: true },
      })
      if (existing) {
        throw new DomainError("CONFLICT", `This ${field.toUpperCase()} is already used in your business.`)
      }
    }

    const variant = await tx.productVariant.create({
      data: {
        productId,
        organizationId: orgId,
        name: data.name.trim(),
        sku: data.sku?.trim() || undefined,
        barcode: data.barcode?.trim() || undefined,
        sellingPrice: data.sellingPrice,
        costPrice: data.costPrice ?? 0,
      },
    }).catch((error: unknown) => mapUniqueViolation(error, "SKU or barcode"))

    await tx.inventory.create({
      data: { locationId, variantId: variant.id, quantity: data.initialStock },
    })

    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", productId, {
      action: "VARIANT_ADD",
      variantId: variant.id,
      name: variant.name,
      sku: variant.sku,
      sellingPrice: data.sellingPrice,
      costPrice: data.costPrice ?? 0,
    })

    return variant
  })
}

export async function updateVariant(
  orgId: string,
  actorId: string,
  variantId: string,
  data: { name?: string; sku?: string | null; barcode?: string | null; sellingPrice?: number; costPrice?: number }
) {
  return prisma.$transaction(async (tx) => {
    // TENANT AUTHORIZATION through the parent product (M1 pattern).
    const variant = await tx.productVariant.findFirst({
      where: { id: variantId, product: { organizationId: orgId } },
      select: {
        id: true, productId: true, name: true, sku: true, barcode: true,
        sellingPrice: true, costPrice: true,
        product: { select: { archivedAt: true } },
      },
    })
    if (!variant) {
      throw new DomainError("NOT_FOUND", "Variant not found.")
    }
    if (variant.product.archivedAt) {
      throw new DomainError("VALIDATION", "Archived products cannot be changed. Restore it first.")
    }

    const next: Record<string, unknown> = {}

    if (data.name !== undefined) {
      if (!data.name?.trim()) throw new DomainError("VALIDATION", "Variant name cannot be empty.")
      next.name = data.name.trim()
    }
    if (data.sellingPrice !== undefined) {
      validatePositivePrice(data.sellingPrice, "Price")
      next.sellingPrice = data.sellingPrice
    }
    // Cost capture is explicit; a value of 0 clears tracking (E-21).
    if (data.costPrice !== undefined) {
      if (!Number.isFinite(data.costPrice) || data.costPrice < 0) {
        throw new DomainError("VALIDATION", "Cost must be a non-negative number.")
      }
      next.costPrice = data.costPrice
    }
    for (const field of ["sku", "barcode"] as const) {
      if (data[field] === undefined) continue
      const value = data[field]?.trim() || null
      if (value) {
        const existing = await tx.productVariant.findFirst({
          where: { organizationId: orgId, [field]: value, id: { not: variantId } },
          select: { id: true },
        })
        if (existing) {
          throw new DomainError("CONFLICT", `This ${field.toUpperCase()} is already used in your business.`)
        }
      }
      next[field] = value
    }

    const before = {
      name: variant.name, sku: variant.sku, barcode: variant.barcode,
      sellingPrice: variant.sellingPrice, costPrice: variant.costPrice,
    }

    const updated = await tx.productVariant.update({
      where: { id: variant.id },
      data: next,
      select: {
        id: true, productId: true, name: true, sku: true, barcode: true,
        sellingPrice: true, costPrice: true,
      },
    }).catch((error: unknown) => mapUniqueViolation(error, "SKU or barcode"))

    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", variant.productId, {
      action: "VARIANT_UPDATE",
      variantId: variant.id,
      before,
      after: {
        name: updated.name, sku: updated.sku, barcode: updated.barcode,
        sellingPrice: updated.sellingPrice, costPrice: updated.costPrice,
      },
    })

    return updated
  })
}

// ==========================================
// CATEGORIES (P1-A, AC-A3)
// ==========================================

export async function createCategory(orgId: string, actorId: string, name: string) {
  if (!name?.trim()) {
    throw new DomainError("VALIDATION", "Category name is required.")
  }

  const existing = await prisma.category.findFirst({
    where: { organizationId: orgId, name: name.trim() },
    select: { id: true },
  })
  if (existing) {
    throw new DomainError("CONFLICT", "A category with this name already exists.")
  }

  const category = await prisma.category.create({
    data: { organizationId: orgId, name: name.trim() },
  }).catch((error: unknown) => mapUniqueViolation(error, "Category name"))

  await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", category.id, {
    action: "CATEGORY_CREATE",
    name: category.name,
  })

  return category
}

export async function updateCategory(orgId: string, actorId: string, categoryId: string, name: string) {
  if (!name?.trim()) {
    throw new DomainError("VALIDATION", "Category name is required.")
  }

  return prisma.$transaction(async (tx) => {
    const category = await tx.category.findFirst({
      where: { id: categoryId, organizationId: orgId },
      select: { id: true, name: true },
    })
    if (!category) {
      throw new DomainError("NOT_FOUND", "Category not found.")
    }

    const clash = await tx.category.findFirst({
      where: { organizationId: orgId, name: name.trim(), id: { not: categoryId } },
      select: { id: true },
    })
    if (clash) {
      throw new DomainError("CONFLICT", "A category with this name already exists.")
    }

    const updated = await tx.category.update({
      where: { id: category.id },
      data: { name: name.trim() },
    }).catch((error: unknown) => mapUniqueViolation(error, "Category name"))

    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", categoryId, {
      action: "CATEGORY_UPDATE",
      before: { name: category.name },
      after: { name: updated.name },
    })

    return updated
  })
}

/**
 * Deleting a category never destroys product history — the FK is
 * ON DELETE SET NULL, so products simply become uncategorized.
 */
export async function deleteCategory(orgId: string, actorId: string, categoryId: string) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.category.findFirst({
      where: { id: categoryId, organizationId: orgId },
      select: { id: true, name: true },
    })
    if (!category) {
      throw new DomainError("NOT_FOUND", "Category not found.")
    }

    await tx.category.delete({ where: { id: category.id } })

    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", categoryId, {
      action: "CATEGORY_DELETE",
      name: category.name,
    })

    return { success: true as const }
  })
}

// ==========================================
// PRODUCT IMAGES (URL-only, decision D-3)
// ==========================================

export async function addProductImage(
  orgId: string,
  actorId: string,
  productId: string,
  data: { url: string; isPrimary?: boolean }
) {
  if (!data.url?.trim()) {
    throw new DomainError("VALIDATION", "Image URL is required.")
  }
  validateUrl(data.url.trim())

  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId, organizationId: orgId },
      select: { id: true },
    })
    if (!product) {
      throw new DomainError("NOT_FOUND", "Product not found.")
    }

    if (data.isPrimary) {
      // One primary image per product.
      await tx.productImage.updateMany({ where: { productId }, data: { isPrimary: false } })
    }

    const image = await tx.productImage.create({
      data: {
        productId,
        url: data.url.trim(),
        isPrimary: data.isPrimary ?? false,
      },
    })

    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", productId, {
      action: "IMAGE_ADD",
      imageId: image.id,
      url: image.url,
      isPrimary: image.isPrimary,
    })

    return image
  })
}

export async function deleteProductImage(orgId: string, actorId: string, imageId: string) {
  return prisma.$transaction(async (tx) => {
    // TENANT AUTHORIZATION through the parent product.
    const image = await tx.productImage.findFirst({
      where: { id: imageId, product: { organizationId: orgId } },
      select: { id: true, productId: true, url: true },
    })
    if (!image) {
      throw new DomainError("NOT_FOUND", "Image not found.")
    }

    await tx.productImage.delete({ where: { id: image.id } })

    await logAuditEvent(orgId, actorId, "UPDATE_PRODUCT", image.productId, {
      action: "IMAGE_DELETE",
      imageId: image.id,
      url: image.url,
    })

    return { success: true as const }
  })
}

// ==========================================
// INVENTORY ADJUSTMENT (M1 behavior preserved)
// ==========================================

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
