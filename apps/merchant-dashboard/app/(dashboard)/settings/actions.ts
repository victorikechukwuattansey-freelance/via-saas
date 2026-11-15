"use server"

import { addStaffMember } from "@via-saas/core"
import { getSessionContext } from "@/lib/auth-helpers"
import { revalidatePath } from "next/cache"

export async function inviteStaff(formData: FormData) {
  const name = formData.get("name") as string
  const email = formData.get("email") as string
  const role = formData.get("role") as "MANAGER" | "STAFF"
  const locationId = formData.get("locationId") as string

  const context = await getSessionContext()
  
  // RBAC Guard: Only Owners can invite staff
  if (!context || context.role !== "OWNER") {
    return { error: "Unauthorized. Only Owners can invite staff." }
  }

  try {
    await addStaffMember(context.orgId, {
      name,
      email,
      role,
      locationId: locationId === "ALL" ? undefined : locationId
    })
    revalidatePath("/settings")
    return { success: true }
  } catch (error: any) {
    return { error: error.message || "Failed to add staff member." }
  }
}
