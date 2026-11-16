// tests/helpers.ts — shared fixtures. All data is created per-test with
// unique suffixes inside the disposable test database.
import { randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"
import { prisma } from "@via-saas/database"

export type OrgFixture = {
  user: { id: string; email: string }
  org: { id: string; name: string }
  store: { id: string; slug: string | null }
  locations: { id: string; name: string }[]
  membership: { id: string; role: string; allowedLocationIds: string[] }
}

export async function createOrganizationFixture(config?: {
  locationCount?: number
  role?: "OWNER" | "MANAGER" | "STAFF"
  allowedLocationIds?: string[]
}): Promise<OrgFixture> {
  const suffix = randomBytes(4).toString("hex")

  const user = await prisma.user.create({
    data: {
      name: `Owner ${suffix}`,
      email: `owner-${suffix}@via.test`,
      passwordHash: await bcrypt.hash("test-password-123", 10),
    },
  })

  const org = await prisma.organization.create({ data: { name: `Org ${suffix}` } })

  const store = await prisma.store.create({
    data: {
      name: `Store ${suffix}`,
      organizationId: org.id,
      slug: `store-${suffix}`,
    },
  })

  const locations: { id: string; name: string }[] = []
  const count = config?.locationCount ?? 1
  for (let i = 0; i < count; i++) {
    const location = await prisma.location.create({
      data: { name: `Location ${i} ${suffix}`, storeId: store.id },
    })
    locations.push({ id: location.id, name: location.name })
  }

  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      role: config?.role ?? "OWNER",
      allowedLocationIds: config?.allowedLocationIds ?? [],
    },
  })

  return {
    user: { id: user.id, email: user.email },
    org: { id: org.id, name: org.name },
    store: { id: store.id, slug: store.slug },
    locations,
    membership: {
      id: membership.id,
      role: membership.role,
      allowedLocationIds: membership.allowedLocationIds,
    },
  }
}

export type VariantFixture = {
  productId: string
  variantId: string
  sellingPrice: number
  inventoryId: string
}

export async function createProductFixture(
  orgId: string,
  locationId: string,
  config?: { price?: number; stock?: number; status?: string }
): Promise<VariantFixture> {
  const suffix = randomBytes(4).toString("hex")

  const product = await prisma.product.create({
    data: {
      name: `Product ${suffix}`,
      organizationId: orgId,
      status: config?.status ?? "PUBLISHED",
    },
  })

  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      organizationId: orgId,
      name: "Default",
      sellingPrice: config?.price ?? 5000,
      costPrice: config?.price ?? 5000,
    },
  })

  const inventory = await prisma.inventory.create({
    data: {
      locationId,
      variantId: variant.id,
      quantity: config?.stock ?? 100,
    },
  })

  return {
    productId: product.id,
    variantId: variant.id,
    sellingPrice: config?.price ?? 5000,
    inventoryId: inventory.id,
  }
}
