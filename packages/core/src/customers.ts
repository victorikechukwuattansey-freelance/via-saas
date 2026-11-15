import { prisma } from "@via-saas/database"
import { DomainError } from "./errors"

export async function upsertCustomer(orgId: string, data: { name: string, phone: string, email?: string }) {
  const name = data.name?.trim()
  const phone = data.phone?.trim()

  if (!name || !phone) throw new DomainError("VALIDATION", "Name and phone are required")

  // Phone is the per-organization customer identifier. The DB-level unique
  // constraint Customer @@unique([organizationId, phone]) plus this atomic
  // upsert make creation safe under concurrent requests (no find-then-create
  // race, no duplicate customers).
  return prisma.customer.upsert({
    where: { organizationId_phone: { organizationId: orgId, phone } },
    create: {
      organizationId: orgId,
      name,
      phone,
      email: data.email?.trim() || undefined,
    },
    update: {}, // existing customers are reused unchanged
  })
}
