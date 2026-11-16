"use server"

import { cancelOrder, toSafeErrorMessage } from "@via-saas/core"
import { canAccessLocation, getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { revalidatePath } from "next/cache"

/**
 * P1-B (D-A / P1-09): void (cancel) an order.
 *
 * Wrapper responsibilities (mirrors resolveOrder):
 *  - RBAC: STAFF members may not void orders (Owner/Manager action).
 *  - LOCATION AUTHORIZATION (E-11): the order's location must be within the
 *    caller's allowed locations. Checked WITHOUT leaking order details —
 *    both cross-org and unauthorized-location ids return the same uniform
 *    "not found or not cancellable" error.
 *  - Core (`cancelOrder`) re-verifies organization ownership and the
 *    FULFILLED + UNPAID eligibility, performs the concurrency-safe
 *    conditional transition, restores stock exclusively through RETURN
 *    movements, and writes the transaction-bound CANCEL_ORDER audit event.
 */
export async function voidOrder(
  orderId: string,
  options?: { reason?: string }
) {
  const context = await getSessionContext()

  // RBAC Guard
  if (!context || context.role === "STAFF") {
    return { error: "Unauthorized. Only Owners and Managers can void orders." }
  }

  try {
    // LOCATION AUTHORIZATION (E-11): checked without leaking order details.
    const order = await prisma.order.findFirst({
      where: { id: orderId, organizationId: context.orgId },
      select: { locationId: true },
    })

    if (!order || !canAccessLocation(context, order.locationId)) {
      return { error: "Order not found or not cancellable." }
    }

    await cancelOrder(context.orgId, context.userId, orderId, {
      reason: options?.reason,
    })

    revalidatePath("/orders/list")
    revalidatePath(`/orders/${orderId}`)
    revalidatePath("/products")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to void the order.") }
  }
}
