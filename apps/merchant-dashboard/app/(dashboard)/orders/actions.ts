"use server"

import { processCheckout, upsertCustomer, toSafeErrorMessage } from "@via-saas/core"
import { getSessionContext } from "@/lib/auth-helpers"
import { revalidatePath } from "next/cache"

// NOTE: the client sends ONLY variant ids and quantities. Unit prices and the
// order total are computed on the server from the database (E-1).
export async function createOrder(payload: {
  items: { variantId: string; quantity: number }[]
  paymentMethod: "CASH" | "TRANSFER"
  customerName: string
  customerPhone: string
}) {
  const context = await getSessionContext()
  if (!context) return { error: "Your session has expired. Please log in again." }

  if (!payload?.items?.length) {
    return { error: "The cart is empty." }
  }
  if (!payload.customerName?.trim() || !payload.customerPhone?.trim()) {
    return { error: "Customer name and phone number are required." }
  }

  try {
    // 1. Create or find the customer (race-safe upsert)
    const customer = await upsertCustomer(context.orgId, {
      name: payload.customerName,
      phone: payload.customerPhone
    })

    // 2. Process the order with the customer ID (server-side pricing,
    //    tenant + item ownership validation, atomic stock deduction)
    await processCheckout(
      context.orgId,
      context.locationId,
      context.userId,
      payload.items,
      payload.paymentMethod,
      customer.id
    )

    revalidatePath("/orders/list")
    revalidatePath("/products")
    revalidatePath("/customers")
    return { success: true }

  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to process order.") }
  }
}
