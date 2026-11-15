"use server"
import { createProduct as createProductCore, toSafeErrorMessage } from "@via-saas/core"
import { revalidatePath } from "next/cache"
import { getSessionContext } from "@/lib/auth-helpers"

export async function createProduct(formData: FormData) {
  const name = formData.get("name") as string
  const sku = formData.get("sku") as string
  const price = parseFloat(formData.get("price") as string)
  const stock = parseInt(formData.get("stock") as string, 10)

  const context = await getSessionContext()
  if (!context) return { error: "Your session has expired. Please log in again." }

  if (isNaN(price) || isNaN(stock)) {
    return { error: "Price and stock must be valid numbers." }
  }

  try {
    await createProductCore(context.orgId, context.userId, context.locationId, {
      name,
      sku: sku || undefined,
      price,
      stock,
    })
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to create product.") }
  }
}
