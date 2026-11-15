"use server"

import { adjustInventory, toSafeErrorMessage } from "@via-saas/core"
import { getSessionContext } from "@/lib/auth-helpers"
import { revalidatePath } from "next/cache"

export async function adjustStock(formData: FormData) {
  const variantId = formData.get("variantId") as string
  const adjustment = parseInt(formData.get("adjustment") as string)
  const reason = formData.get("reason") as string

  const context = await getSessionContext()
  if (!context || context.role === "STAFF") {
    return { error: "Unauthorized. Only Owners and Managers can adjust stock." }
  }

  if (isNaN(adjustment) || adjustment === 0) {
    return { error: "Please enter a valid non-zero adjustment." }
  }

  try {
    await adjustInventory(context.orgId, context.userId, context.locationId, variantId, adjustment, reason)
    revalidatePath("/products")
    return { success: true }
  } catch (error: any) {
    return { error: toSafeErrorMessage(error, "Failed to adjust stock.") }
  }
}
