"use server"

import { acceptStaffInvite, toSafeErrorMessage } from "@via-saas/core"
import { redirect } from "next/navigation"

export async function acceptInvite(
  prevState: { error?: string } | null,
  formData: FormData
) {
  const token = formData.get("token") as string
  const password = formData.get("password") as string
  const confirm = formData.get("confirm") as string

  if (!password || password !== confirm) {
    return { error: "Passwords do not match." }
  }

  try {
    await acceptStaffInvite(token, password)
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "This invitation link is invalid, used, or expired.") }
  }

  redirect("/login?invited=true")
}
