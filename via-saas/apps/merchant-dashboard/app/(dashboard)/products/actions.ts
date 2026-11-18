"use server"
import {
  createProduct as createProductCore,
  updateProduct as updateProductCore,
  archiveProduct as archiveProductCore,
  restoreProduct as restoreProductCore,
  deleteProduct as deleteProductCore,
  addVariant as addVariantCore,
  updateVariant as updateVariantCore,
  createCategory as createCategoryCore,
  deleteCategory as deleteCategoryCore,
  addProductImage as addProductImageCore,
  deleteProductImage as deleteProductImageCore,
  toSafeErrorMessage,
} from "@via-saas/core"
import { revalidatePath } from "next/cache"
import {
  canManageCatalogue,
  getSessionContext,
} from "@/lib/auth-helpers"

// ==========================================
// Session + permission plumbing (X-3: every action validates its inputs
// server-side and returns a uniform { success } | { error } shape).
// ==========================================

async function requireCatalogueManager() {
  const context = await getSessionContext()
  if (!context) {
    return { context: null, error: { error: "Your session has expired. Please log in again." } as const }
  }
  if (!canManageCatalogue(context)) {
    return { context: null, error: { error: "Unauthorized. Only Owners and Managers can manage the catalogue." } as const }
  }
  return { context, error: null }
}

function parseOptionalString(value: FormDataEntryValue | null): string | undefined {
  const raw = typeof value === "string" ? value.trim() : ""
  return raw || undefined
}

function parseRequiredNumber(value: FormDataEntryValue | null, label: string): number | string {
  const parsed = Number.parseFloat(typeof value === "string" ? value : "")
  if (!Number.isFinite(parsed)) return `${label} must be a valid number.`
  return parsed
}

function parseRequiredInt(value: FormDataEntryValue | null, label: string): number | string {
  const parsed = Number.parseInt(typeof value === "string" ? value : "", 10)
  if (!Number.isInteger(parsed)) return `${label} must be a valid whole number.`
  return parsed
}

// ==========================================
// PRODUCTS
// ==========================================

export async function createProduct(formData: FormData) {
  const name = formData.get("name") as string
  const sku = parseOptionalString(formData.get("sku"))
  const description = parseOptionalString(formData.get("description"))
  const cost = parseRequiredNumber(formData.get("cost"), "Cost")
  const price = parseRequiredNumber(formData.get("price"), "Price")
  const stock = parseRequiredInt(formData.get("stock"), "Initial stock")

  const context = await getSessionContext()
  if (!context) return { error: "Your session has expired. Please log in again." }

  if (typeof price === "string") return { error: price }
  if (typeof cost === "string") return { error: cost }
  if (typeof stock === "string") return { error: stock }

  try {
    await createProductCore(context.orgId, context.userId, context.locationId, {
      name,
      sku,
      description,
      price,
      cost,
      stock,
    })
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to create product.") }
  }
}

export async function updateProduct(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error
  const context = session.context

  const productId = formData.get("productId") as string
  const name = parseOptionalString(formData.get("name"))
  const description = parseOptionalString(formData.get("description"))
  const statusRaw = formData.get("status")
  const categoryIdRaw = formData.get("categoryId")

  try {
    await updateProductCore(context.orgId, context.userId, productId, {
      ...(name !== undefined ? { name } : {}),
      ...(formData.has("description") ? { description: description ?? null } : {}),
      ...(typeof statusRaw === "string" && statusRaw ? { status: statusRaw } : {}),
      // An empty select value clears the category; an absent field leaves it.
      ...(formData.has("categoryId")
        ? { categoryId: typeof categoryIdRaw === "string" && categoryIdRaw ? categoryIdRaw : null }
        : {}),
    })
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to update product.") }
  }
}

export async function archiveProduct(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error

  const productId = formData.get("productId") as string
  try {
    await archiveProductCore(session.context.orgId, session.context.userId, productId)
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to archive product.") }
  }
}

export async function restoreProduct(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error

  const productId = formData.get("productId") as string
  try {
    await restoreProductCore(session.context.orgId, session.context.userId, productId)
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to restore product.") }
  }
}

export async function deleteProduct(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error

  const productId = formData.get("productId") as string
  try {
    await deleteProductCore(session.context.orgId, session.context.userId, productId)
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to delete product.") }
  }
}

// ==========================================
// VARIANTS
// ==========================================

export async function addVariant(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error
  const context = session.context

  const productId = formData.get("productId") as string
  const name = parseOptionalString(formData.get("name"))
  const sku = parseOptionalString(formData.get("sku"))
  const barcode = parseOptionalString(formData.get("barcode"))
  const sellingPrice = parseRequiredNumber(formData.get("sellingPrice"), "Price")
  const costPrice = parseRequiredNumber(formData.get("costPrice"), "Cost")
  const initialStock = parseRequiredInt(formData.get("initialStock"), "Initial stock")

  if (typeof sellingPrice === "string") return { error: sellingPrice }
  if (typeof costPrice === "string") return { error: costPrice }
  if (typeof initialStock === "string") return { error: initialStock }

  try {
    await addVariantCore(context.orgId, context.userId, productId, context.locationId, {
      name: name ?? "",
      sku,
      barcode,
      sellingPrice,
      costPrice,
      initialStock,
    })
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to add variant.") }
  }
}

export async function updateVariant(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error
  const context = session.context

  const variantId = formData.get("variantId") as string
  const name = parseOptionalString(formData.get("name"))
  const sku = parseOptionalString(formData.get("sku"))
  const barcode = parseOptionalString(formData.get("barcode"))
  const sellingPrice = parseRequiredNumber(formData.get("sellingPrice"), "Price")
  const costPrice = parseRequiredNumber(formData.get("costPrice"), "Cost")

  if (typeof sellingPrice === "string") return { error: sellingPrice }
  if (typeof costPrice === "string") return { error: costPrice }

  // P1-D (P1-21, R-8): threshold is optional on the form; absent field =
  // untouched, empty = disabled (NULL), otherwise a non-negative integer.
  // Final validation is server-side in the core (defense in depth).
  const lowStockRaw = formData.get("lowStockThreshold")
  let lowStockThreshold: number | null | undefined
  if (lowStockRaw === null) {
    lowStockThreshold = undefined
  } else if (typeof lowStockRaw !== "string" || lowStockRaw.trim() === "") {
    lowStockThreshold = null
  } else {
    const parsed = Number.parseInt(lowStockRaw, 10)
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { error: "Low stock threshold must be a non-negative whole number, or empty to disable." }
    }
    lowStockThreshold = parsed
  }

  try {
    await updateVariantCore(context.orgId, context.userId, variantId, {
      name,
      sku: sku ?? null,
      barcode: barcode ?? null,
      sellingPrice,
      costPrice,
      lowStockThreshold,
    })
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to update variant.") }
  }
}

// ==========================================
// CATEGORIES
// ==========================================

export async function createCategory(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error

  const name = parseOptionalString(formData.get("name"))
  try {
    await createCategoryCore(session.context.orgId, session.context.userId, name ?? "")
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to create category.") }
  }
}

export async function deleteCategory(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error

  const categoryId = formData.get("categoryId") as string
  try {
    await deleteCategoryCore(session.context.orgId, session.context.userId, categoryId)
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to delete category.") }
  }
}

// ==========================================
// IMAGES (URL-only, decision D-3)
// ==========================================

export async function addProductImage(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error

  const productId = formData.get("productId") as string
  const url = parseOptionalString(formData.get("url"))
  const isPrimary = formData.get("isPrimary") === "on"
  try {
    await addProductImageCore(session.context.orgId, session.context.userId, productId, {
      url: url ?? "",
      isPrimary,
    })
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to add image.") }
  }
}

export async function deleteProductImage(formData: FormData) {
  const session = await requireCatalogueManager()
  if (!session.context) return session.error

  const imageId = formData.get("imageId") as string
  try {
    await deleteProductImageCore(session.context.orgId, session.context.userId, imageId)
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to delete image.") }
  }
}
