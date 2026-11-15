"use server"

import { resolveAttentionOrder } from "@via-saas/core"
import { getSessionContext } from "@/lib/auth-helpers"
import { revalidatePath } from "next/cache"

export async function resolveOrder(orderId: string, action: "FULFILL" | "CANCEL") {
  const context = await getSessionContext()
  
  // RBAC Guard
  if (!context || context.role === "STAFF") {
    return { error: "Unauthorized. Only Owners and Managers can resolve orders." }
  }

  try {
    // Pass orgId and actorId (userId) to the core function
    await resolveAttentionOrder(context.orgId, context.userId, orderId, action)
    
    revalidatePath("/orders/list")
    revalidatePath("/")
    return { success: true }
  } catch (error: any) {
    return { error: error.message || "Failed to resolve order." }
  }
}
