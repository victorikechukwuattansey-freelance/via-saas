"use server"

import { processCheckout, upsertCustomer, toSafeErrorMessage } from "@via-saas/core"
import { getSessionContext } from "@/lib/auth-helpers"
import { revalidatePath } from "next/cache"

// NOTE: the client sends ONLY variant ids and quantities. Unit prices and the
// order total are computed on the server from the database (E-1). The
// idempotency key is client-generated (UUID per submission attempt) but is a
// KEY ONLY — it can never alter prices, attribution, or the audit source.
export async function createOrder(payload: {
  items: { variantId: string; quantity: number }[]
  paymentMethod: "CASH" | "TRANSFER"
  customerName: string
  customerPhone: string
  idempotencyKey: string
}) {
  const context = await getSessionContext()
  if (!context) return { error: "Your session has expired. Please log in again." }

  if (!payload?.items?.length) {
    return { error: "The cart is empty." }
  }
  if (!payload.customerName?.trim() || !payload.customerPhone?.trim()) {
    return { error: "Customer name and phone number are required." }
  }
  // D-C: POS must always supply an idempotency key.
  if (typeof payload.idempotencyKey !== "string" || payload.idempotencyKey.trim() === "") {
    return { error: "Missing order submission key." }
  }

  try {
    // 1. Create or find the customer (race-safe upsert)
    const customer = await upsertCustomer(context.orgId, {
      name: payload.customerName,
      phone: payload.customerPhone
    })

    // 2. Process the order with the customer ID (server-side pricing,
    //    tenant + item ownership validation, atomic stock deduction).
    //    The actor is the authenticated merchant user — the audit event is
    //    attributed to them (D-G: non-null; source is server-derived, and
    //    client input can never claim STOREFRONT_API).
    const order = await processCheckout(
      context.orgId,
      context.locationId,
      context.userId,
      payload.items,
      payload.paymentMethod,
      customer.id,
      payload.idempotencyKey
    )

    revalidatePath("/orders/list")
    revalidatePath("/products")
    revalidatePath("/customers")
    // P1-B (POS success state): return the created order reference so the
    // POS can link straight to the detail/receipt-record page.
    return { success: true, orderId: order.id, orderNumber: order.orderNumber }

  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to process order.") }
  }
}
