import { prisma } from "@via-saas/database"
import bcrypt from "bcryptjs"

export async function registerOrganization(data: { name: string, businessName: string, email: string, password: string }) {
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } })
  if (existingUser) throw new Error("Email already exists")

  const passwordHash = await bcrypt.hash(data.password, 10)

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { name: data.name, email: data.email, passwordHash } })
    const org = await tx.organization.create({ data: { name: data.businessName, subscriptionPlan: "GROWTH" } })
    const store = await tx.store.create({ data: { name: data.businessName, organizationId: org.id } })
    const location = await tx.location.create({ data: { name: "Main Location", storeId: store.id } })
    
    await tx.membership.create({
      data: { userId: user.id, organizationId: org.id, role: "OWNER", allowedLocationIds: [] }
    })
    
    return { user, org, location }
  })
}

// Add this to packages/core/src/auth.ts

export async function addStaffMember(orgId: string, data: { name: string, email: string, role: "MANAGER" | "STAFF", locationId?: string }) {
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } })
  
  return prisma.$transaction(async (tx) => {
    let user = existingUser
    
    // If the user doesn't exist anywhere in the system, create them
    if (!user) {
      const passwordHash = await bcrypt.hash("password123", 10)
      user = await tx.user.create({
        data: { name: data.name, email: data.email, passwordHash }
      })
    }

    // Check if they are already in this organization
    const existingMembership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: orgId } }
    })

    if (existingMembership) throw new Error("User is already a member of this organization.")

    // Create the Membership
    return tx.membership.create({
      data: {
        userId: user.id,
        organizationId: orgId,
        role: data.role,
        allowedLocationIds: data.locationId ? [data.locationId] : [], // Empty means all locations
      }
    })
  })
}
