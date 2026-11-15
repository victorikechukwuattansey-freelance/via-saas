"use server"

import { inviteStaffMember, toSafeErrorMessage } from "@via-saas/core"
import { getSessionContext } from "@/lib/auth-helpers"
import { revalidatePath } from "next/cache"

/**
 * Invites a staff member (OWNER only).
 *
 * Returns a one-time setup link when a new account must be created. The
 * invite token is returned to the OWNER exactly once and is never logged;
 * only its SHA-256 hash is persisted (see packages/core/src/auth.ts).
 */
export async function inviteStaff(
  prevState: { error?: string; inviteUrl?: string; linked?: boolean } | null,
  formData: FormData
) {
  const name = formData.get("name") as string
  const email = formData.get("email") as string
  const role = formData.get("role") as "MANAGER" | "STAFF"
  const locationId = formData.get("locationId") as string

  const context = await getSessionContext()

  // RBAC Guard: Only Owners can invite staff
  if (!context) {
    return { error: "Your session has expired. Please log in again." }
  }
  if (context.role !== "OWNER") {
    return { error: "Unauthorized. Only Owners can invite staff." }
  }

  try {
    const result = await inviteStaffMember(context.orgId, context.userId, {
      name,
      email,
      role,
      locationId: locationId === "ALL" ? undefined : locationId,
    })

    revalidatePath("/settings")

    if (result.linked) {
      return { linked: true }
    }

    // Token is returned once; the OWNER copies the link to the staff member.
    return { inviteUrl: `/invite/${result.inviteToken}` }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to add staff member.") }
  }
}
