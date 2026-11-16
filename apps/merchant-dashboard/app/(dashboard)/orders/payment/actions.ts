"use server"

import { recordPaymentReceived, toSafeErrorMessage } from "@via-saas/core"
import { canAccessLocation, getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { revalidatePath } from "next/cache"

/**
 * P1-B (D-B/D-D / P1-10): record that payment was RECEIVED for a TRANSFER
 * order. This is a merchant confirmation only — no provider/bank
 * verification, no money movement.
 *
 * Wrapper responsibilities (mirrors resolveOrder):
 *  - RBAC: STAFF members may not record payments (Owner/Manager action).
 *  - LOCATION AUTHORIZATION (E-11): the order's location must be within the
 *    caller's allowed locations, checked without leaking order details.
 *  - Core (`recordPaymentReceived`) re-verifies organization ownership and
 *    the TRANSFER + UNPAID + FULFILLED eligibility, performs the
 *    concurrency-safe conditional transition, and writes the
 *    transaction-bound PAYMENT_RECORDED audit event.
 */
export async function recordPayment(orderId: string) {
  const context = await getSessionContext()

  // RBAC Guard
  if (!context || context.role === "STAFF") {
    return { error: "Unauthorized. Only Owners and Managers can record payments." }
  }

  try {
    // LOCATION AUTHORIZATION (E-11): checked without leaking order details.
    const order = await prisma.order.findFirst({
      where: { id: orderId, organizationId: context.orgId },
      select: { locationId: true },
    })

    if (!order || !canAccessLocation(context, order.locationId)) {
      return { error: "Order not found or not payable." }
    }

    await recordPaymentReceived(context.orgId, context.userId, orderId)

    revalidatePath("/orders/list")
    revalidatePath(`/orders/${orderId}`)
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to record the payment.") }
  }
}
