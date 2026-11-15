"use server"
import { createProduct as createProductCore } from "@via-saas/core"
import { cookies } from "next/headers"
import { revalidatePath } from "next/cache"
import { getSessionContext } from "@/lib/auth-helpers" // We'll create this helper next

export async function createProduct(formData: FormData) {
  const name = formData.get("name") as string
  const sku = formData.get("sku") as string
  const price = parseFloat(formData.get("price") as string)
  const stock = parseInt(formData.get("stock") as string)

  const context = await getSessionContext()
  if (!context) return { error: "Unauthorized" }

  try {
    await createProductCore(context.orgId, context.userId, context.locationId, { name, sku, price, stock })
    revalidatePath("/products")
    return { success: true }
  } catch (error) {
    return { error: "Failed to create product." }
  }
}
