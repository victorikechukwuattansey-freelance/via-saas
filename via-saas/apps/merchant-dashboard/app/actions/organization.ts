"use server"

// P1-17 — Active-organization switching (dashboard server action, §10.3).
// The transactional core lives in lib/organization.ts (Next-free and
// unit-tested); this wrapper supplies the session context (the effective
// §10.2 organization for the audit's `fromOrganizationId`), purges cached
// RSC payloads (C-AC39), and re-renders under the new org.

import { toSafeErrorMessage } from "@via-saas/core"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import { getSessionContext } from "@/lib/auth-helpers"
import { performOrganizationSwitch } from "@/lib/organization"

type SwitchState = { error?: string } | null

export async function switchOrganization(
  _prevState: SwitchState,
  formData: FormData
): Promise<SwitchState> {
  const organizationId = formData.get("organizationId") as string

  const context = await getSessionContext()
  if (!context) {
    redirect("/login")
  }

  if (!organizationId) {
    return { error: "Invalid organization selection." }
  }

  try {
    await performOrganizationSwitch({
      token: cookies().get("session_token")?.value ?? "",
      userId: context.userId,
      fromOrganizationId: context.orgId,
      targetOrganizationId: organizationId,
    })

    // Purge cached RSC payloads and re-render under the new org (C-AC39).
    revalidatePath("/", "layout")
  } catch (error: unknown) {
    // NEXT_REDIRECT rethrows must not be swallowed.
    if (error && typeof error === "object" && "digest" in error) throw error
    return { error: toSafeErrorMessage(error, "Could not switch organization.") }
  }

  redirect("/")
}
