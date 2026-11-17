"use server"

import { normalizeEmail } from "@via-saas/core"
import { prisma } from "@via-saas/database"
import bcrypt from "bcryptjs"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { pickInitialActiveOrganization } from "@/lib/auth-helpers"

export async function loginUser(prevState: any, formData: FormData) {
  // C-D18a: the canonical normalization — identical to registration and
  // invitations, so every path compares the same normalized value.
  const email = normalizeEmail((formData.get("email") as string) ?? "")
  const password = formData.get("password") as string

  if (!email || !password) {
    return { error: "Email and password are required." }
  }

  try {
    // 1. Find user
    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      return { error: "Invalid email or password." }
    }

    // 2. Check password
    const isValidPassword = await bcrypt.compare(password, user.passwordHash)
    if (!isValidPassword) {
      return { error: "Invalid email or password." }
    }

    // 3. Create Session Token
    const sessionToken = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

    // 4. C-D13a: initialize the session's active organization server-side —
    //    the first ELIGIBLE membership in the deterministic §10.2 order
    //    (organization.createdAt, then id; eligible = ≥1 accessible ACTIVE
    //    location). Null when the user has no eligible organization; the
    //    user can switch afterwards (the switch action is the ONLY writer).
    const memberships = await prisma.membership.findMany({
      where: { userId: user.id },
      include: {
        organization: { include: { stores: { include: { locations: true } } } },
      },
    })
    const activeOrganizationId = pickInitialActiveOrganization(memberships)

    // 5. Save Session to DB
    await prisma.session.create({
      data: {
        userId: user.id,
        token: sessionToken,
        expiresAt,
        activeOrganizationId,
      },
    })

    // 6. Set Cookie
    cookies().set("session_token", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      expires: expiresAt,
      sameSite: "lax",
      path: "/",
    })

  } catch (error) {
    console.error("Login Error:", error)
    return { error: "Something went wrong. Please try again." }
  }

  // 7. Redirect to Dashboard
  redirect("/")
}
