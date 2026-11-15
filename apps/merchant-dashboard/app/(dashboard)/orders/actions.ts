"use server"

import { processCheckout, upsertCustomer } from "@via-saas/core"
import { getSessionContext } from "@/lib/auth-helpers"
import { revalidatePath } from "next/cache"

export async function createOrder(payload: {
  items: { variantId: string; quantity: number; price: number }[]
  paymentMethod: "CASH" | "TRANSFER"
  customerName: string
  customerPhone: string
}) {
  const context = await getSessionContext()
  if (!context) return { error: "Unauthorized" }

  try {
    // 1. Create or find the customer
    const customer = await upsertCustomer(context.orgId, {
      name: payload.customerName,
      phone: payload.customerPhone
    })

    // 2. Process the order with the customer ID
    await processCheckout(
      context.orgId, 
      context.locationId, 
      context.userId, 
      payload.items,
      payload.paymentMethod,
      customer.id // Pass the linked customer
    )

    revalidatePath("/orders/list")
    revalidatePath("/products")
    revalidatePath("/customers")
    return { success: true }

  } catch (error: any) {
    console.error("POS Error:", error)
    return { error: error.message || "Failed to process order." }
  }
}
