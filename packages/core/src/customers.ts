import { prisma } from "@via-saas/database"

export async function upsertCustomer(orgId: string, data: { name: string, phone: string, email?: string }) {
  if (!data.name || !data.phone) throw new Error("Name and phone are required")
  
  // For MVP, we'll assume phone number is the unique identifier per organization
  const existing = await prisma.customer.findFirst({
    where: { organizationId: orgId, phone: data.phone }
  })

  if (existing) return existing

  return prisma.customer.create({
    data: {
      organizationId: orgId,
      name: data.name,
      phone: data.phone,
      email: data.email,
    }
  })
}
