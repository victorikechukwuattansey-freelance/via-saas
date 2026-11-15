"use server"

import { resolveAttentionOrder, toSafeErrorMessage } from "@via-saas/core"
import { canAccessLocation, getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { revalidatePath } from "next/cache"

export async function resolveOrder(orderId: string, action: "FULFILL" | "CANCEL") {
  const context = await getSessionContext()

  // RBAC Guard
  if (!context || context.role === "STAFF") {
    return { error: "Unauthorized. Only Owners and Managers can resolve orders." }
  }

  try {
    // LOCATION AUTHORIZATION (E-11): the order's location must be within the
    // caller's allowed locations. Checked without leaking order details.
    const order = await prisma.order.findFirst({
      where: { id: orderId, organizationId: context.orgId },
      select: { locationId: true },
    })

    if (!order || !canAccessLocation(context, order.locationId)) {
      return { error: "Order not found or not resolvable." }
    }

    // Core re-verifies organization ownership inside its transaction (E-4).
    await resolveAttentionOrder(context.orgId, context.userId, orderId, action)

    revalidatePath("/orders/list")
    revalidatePath("/")
    return { success: true }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to resolve order.") }
  }
}
