"use server"

import {
  inviteStaffMember,
  updateStaffMember,
  removeStaffMember,
  rescindInvitation,
  createLocation,
  renameLocation,
  archiveLocation,
  isCanonicalRole,
  toSafeErrorMessage,
} from "@via-saas/core"
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

/** Shared OWNER gate for the settings actions (server-side, two-layer). */
async function requireOwner() {
  const context = await getSessionContext()
  if (!context) {
    return { error: "Your session has expired. Please log in again." as const }
  }
  if (context.role !== "OWNER") {
    return { error: "Unauthorized. Only Owners can manage this setting." as const }
  }
  return { context }
}

/**
 * Updates a staff member's role and/or location scope (OWNER only).
 * Core enforces C-D1 (canonical roles), C-D3/C-D17 (no self-mutation),
 * and the last-owner demotion guard; this layer only gates + maps errors.
 */
export async function updateStaff(
  prevState: { error?: string; success?: string } | null,
  formData: FormData
) {
  const membershipId = formData.get("membershipId") as string
  const role = formData.get("role") as string
  const locationId = formData.get("locationId") as string | null

  const gate = await requireOwner()
  if ("error" in gate) return { error: gate.error }

  if (!membershipId || !isCanonicalRole(role)) {
    return { error: "A staff member and a valid role are required." }
  }

  try {
    await updateStaffMember(gate.context.orgId, gate.context.userId, membershipId, {
      role,
      // Empty scope = all ACTIVE locations; "ALL" sentinel matches invite form.
      allowedLocationIds: !locationId || locationId === "ALL" ? [] : [locationId],
    })
    revalidatePath("/settings")
    return { success: "Staff member updated." }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to update the staff member.") }
  }
}

/**
 * Removes a staff member (OWNER only). Hard-deletes the Membership with an
 * audit snapshot; all business history is preserved (C-D4a). Self-removal
 * and last-owner removal are blocked in core (C-D3a/C-D17a, C-AC6/7).
 */
export async function removeStaff(
  prevState: { error?: string; success?: string } | null,
  formData: FormData
) {
  const membershipId = formData.get("membershipId") as string

  const gate = await requireOwner()
  if ("error" in gate) return { error: gate.error }

  if (!membershipId) {
    return { error: "A staff member is required." }
  }

  try {
    await removeStaffMember(gate.context.orgId, gate.context.userId, membershipId)
    revalidatePath("/settings")
    return { success: "Staff member removed." }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to remove the staff member.") }
  }
}

/**
 * Rescinds a PENDING invitation (OWNER only). Idempotent on already-revoked
 * invites (C-D8i); an accepted invite reports "already used" (C-D8b).
 */
export async function rescindInvite(
  prevState: { error?: string; success?: string } | null,
  formData: FormData
) {
  const inviteId = formData.get("inviteId") as string

  const gate = await requireOwner()
  if ("error" in gate) return { error: gate.error }

  if (!inviteId) {
    return { error: "An invitation is required." }
  }

  try {
    const result = await rescindInvitation(gate.context.orgId, gate.context.userId, inviteId)
    revalidatePath("/settings")
    return {
      success: result.alreadyRevoked ? "Invitation was already rescinded." : "Invitation rescinded.",
    }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to rescind the invitation.") }
  }
}

/** Creates a location (OWNER only, C-D9a). */
export async function addLocation(
  prevState: { error?: string; success?: string } | null,
  formData: FormData
) {
  const name = formData.get("name") as string

  const gate = await requireOwner()
  if ("error" in gate) return { error: gate.error }

  if (!name || !name.trim()) {
    return { error: "A location name is required." }
  }

  try {
    await createLocation(gate.context.orgId, gate.context.userId, { name })
    revalidatePath("/settings")
    return { success: "Location created." }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to create the location.") }
  }
}

/** Renames a location (OWNER only, C-D9a). */
export async function renameLocationAction(
  prevState: { error?: string; success?: string } | null,
  formData: FormData
) {
  const locationId = formData.get("locationId") as string
  const name = formData.get("name") as string

  const gate = await requireOwner()
  if ("error" in gate) return { error: gate.error }

  if (!locationId || !name || !name.trim()) {
    return { error: "A location and a new name are required." }
  }

  try {
    await renameLocation(gate.context.orgId, gate.context.userId, locationId, name)
    revalidatePath("/settings")
    return { success: "Location renamed." }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to rename the location.") }
  }
}

/**
 * Archives (or restores) a location (OWNER only, C-D9a/C-D10a). The
 * last-active-location guard and the conditional transition live in core.
 */
export async function archiveLocationAction(
  prevState: { error?: string; success?: string } | null,
  formData: FormData
) {
  const locationId = formData.get("locationId") as string
  const restore = formData.get("restore") === "true"

  const gate = await requireOwner()
  if ("error" in gate) return { error: gate.error }

  if (!locationId) {
    return { error: "A location is required." }
  }

  try {
    await archiveLocation(gate.context.orgId, gate.context.userId, locationId, { restore })
    revalidatePath("/settings")
    return { success: restore ? "Location restored." : "Location archived." }
  } catch (error: unknown) {
    return {
      error: toSafeErrorMessage(
        error,
        restore ? "Failed to restore the location." : "Failed to archive the location."
      ),
    }
  }
}
