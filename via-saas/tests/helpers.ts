// tests/helpers.ts — shared fixtures. All data is created per-test with
// unique suffixes inside the disposable test database.
import { randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"
import { prisma } from "@via-saas/database"
// P1-D §6.7: contract-covered inventory is created THROUGH the core creation
// pathway, never directly — see createProductFixture below.
import { createProduct, updateProduct } from "@via-saas/core"

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

  // P1-D §6.7: this fixture's inventory row is created THROUGH the core
  // creation pathway (createProduct), so it carries the initial ADDED
  // movement and satisfies the ledger-reconciliation invariant
  // (quantity === Σ movements). The acting user is the org's first member —
  // fixture attribution only.
  const membership = await prisma.membership.findFirst({
    where: { organizationId: orgId },
    select: { userId: true },
  })
  if (!membership) {
    throw new Error(`createProductFixture: no membership found for org ${orgId}`)
  }

  const price = config?.price ?? 5000
  const stock = config?.stock ?? 100

  const product = await createProduct(orgId, membership.userId, locationId, {
    name: `Product ${suffix}`,
    price,
    stock,
    // Fixture cost semantics preserved: costPrice used to default to the
    // price (E-21 keeps explicit cost in createProduct, default 0).
    cost: price,
  })

  // createProduct always creates the product PUBLISHED; a DRAFT fixture is
  // downgraded through the normal catalogue pathway (no publish gate on the
  // DRAFT direction).
  if (config?.status && config.status !== "PUBLISHED") {
    await updateProduct(orgId, membership.userId, product.id, { status: config.status })
  }

  const variant = await prisma.productVariant.findFirstOrThrow({
    where: { productId: product.id },
  })
  const inventory = await prisma.inventory.findFirstOrThrow({
    where: { variantId: variant.id, locationId },
  })

  return {
    productId: product.id,
    variantId: variant.id,
    sellingPrice: price,
    inventoryId: inventory.id,
  }
}
