"use server"

import { prisma } from "@via-saas/database"
import bcrypt from "bcryptjs"
import { redirect } from "next/navigation"
import { generateStoreSlug, normalizeEmail } from "@via-saas/core"

export async function registerUser(prevState: any, formData: FormData) {
  const name = formData.get("name") as string
  const businessName = formData.get("business") as string
  // C-D18a: normalize identically to login and invitations, so a user who
  // registered with mixed case can log in case-insensitively.
  const email = normalizeEmail(formData.get("email") as string)
  const password = formData.get("password") as string

  if (!name || !businessName || !email || !password) {
    return { error: "All fields are required." }
  }

  try {
    // 1. Check if user exists
    const existingUser = await prisma.user.findUnique({ where: { email } })
    if (existingUser) {
      return { error: "An account with this email already exists." }
    }

    // 2. Hash the password
    const passwordHash = await bcrypt.hash(password, 10)

    // 3. Execute the transaction (The Flowchart!)
    await prisma.$transaction(async (tx) => {
      // A. Create User
      const user = await tx.user.create({
        data: { name, email, passwordHash },
      })

      // B. Create Organization
      const org = await tx.organization.create({
        data: { name: businessName, subscriptionPlan: "GROWTH" },
      })

      // C. Create Store (public slug resolves the storefront to this org)
      const store = await tx.store.create({
        data: {
          name: businessName,
          organizationId: org.id,
          slug: generateStoreSlug(businessName),
        },
      })

      // D. Create Default Location
      const location = await tx.location.create({
        data: { name: "Main Location", storeId: store.id },
      })

      // E. Create Owner Membership
      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: "OWNER",
          allowedLocationIds: [], // Empty means access to all
        },
      })
    })

  } catch (error) {
    console.error("Registration Error:", error)
    return { error: "Something went wrong. Please try again." }
  }

  // 4. Redirect to Login on success
  redirect("/login?registered=true")
}
