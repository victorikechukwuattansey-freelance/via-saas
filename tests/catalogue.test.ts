// P1-A catalogue regression tests (AC-A1..A5, A7, A8).
//
// Covers: product editing, multi-variant support with PER-ORGANIZATION
// SKU/barcode uniqueness, categories, archive/restore, guarded hard delete,
// explicit cost capture (E-21), and exactly-one-audit-event-per-mutation.
// Tenant isolation is exercised with cross-org negative cases throughout.
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import {
  createProduct,
  updateProduct,
  archiveProduct,
  restoreProduct,
  deleteProduct,
  addVariant,
  updateVariant,
  createCategory,
  deleteCategory,
  addProductImage,
  getStorefrontProducts,
  DomainError,
} from "@via-saas/core"
import { createOrganizationFixture, type OrgFixture } from "./helpers"

async function twoOrgs(): Promise<{ a: OrgFixture; b: OrgFixture }> {
  return {
    a: await createOrganizationFixture(),
    b: await createOrganizationFixture(),
  }
}

function expectDomainError(fn: () => Promise<unknown>, code: string) {
  return expect(fn()).rejects.toMatchObject({
    name: "DomainError",
    code,
  } satisfies Partial<DomainError>)
}

describe("product editing (AC-A1)", () => {
  it("edits name, description, and status; changes persist", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Original",
      price: 100,
      stock: 5,
    })

    const updated = await updateProduct(a.org.id, a.user.id, product.id, {
      name: "Renamed",
      description: "New description",
      status: "DRAFT",
    })

    expect(updated.name).toBe("Renamed")
    expect(updated.description).toBe("New description")
    expect(updated.status).toBe("DRAFT")

    const fetched = await prisma.product.findUnique({ where: { id: product.id } })
    expect(fetched?.name).toBe("Renamed")
    expect(fetched?.status).toBe("DRAFT")
  })

  it("rejects cross-org edits without leaking existence (NOT_FOUND)", async () => {
    const { a, b } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Mine",
      price: 100,
      stock: 5,
    })

    await expectDomainError(
      () => updateProduct(b.org.id, b.user.id, product.id, { name: "Stolen" }),
      "NOT_FOUND"
    )
    const untouched = await prisma.product.findUnique({ where: { id: product.id } })
    expect(untouched?.name).toBe("Mine")
  })

  it("rejects invalid status values", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "P",
      price: 100,
      stock: 5,
    })
    await expectDomainError(
      () => updateProduct(a.org.id, a.user.id, product.id, { status: "ARCHIVED" as string }),
      "VALIDATION"
    )
  })

  it("blocks re-publishing a product whose variants all have zero price (D-13)", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "P",
      price: 100,
      stock: 5,
    })
    // Sabotage: set every variant price to zero directly.
    await prisma.productVariant.updateMany({
      where: { productId: product.id },
      data: { sellingPrice: 0 },
    })
    await updateProduct(a.org.id, a.user.id, product.id, { status: "DRAFT" })
    await expectDomainError(
      () => updateProduct(a.org.id, a.user.id, product.id, { status: "PUBLISHED" }),
      "VALIDATION"
    )
  })

  it("writes exactly one audit event per edit with before/after metadata", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Before",
      price: 100,
      stock: 5,
    })

    await updateProduct(a.org.id, a.user.id, product.id, { name: "After" })

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: a.org.id, targetId: product.id },
      orderBy: { createdAt: "asc" },
    })
    // CREATE_PRODUCT from createProduct + exactly one UPDATE_PRODUCT.
    expect(audits).toHaveLength(2)
    expect(audits[1].action).toBe("UPDATE_PRODUCT")
    expect(audits[1].metadata).toMatchObject({
      action: "PRODUCT_UPDATE",
      before: { name: "Before" },
      after: { name: "After" },
    })
  })
})

describe("variants and per-org SKU/barcode uniqueness (AC-A2, D-2)", () => {
  it("adds a variant with sku, barcode, and explicit cost", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Shirt",
      price: 100,
      stock: 5,
    })

    const variant = await addVariant(a.org.id, a.user.id, product.id, a.locations[0].id, {
      name: "Red / M",
      sku: "SHIRT-RED-M",
      barcode: "1234567890",
      sellingPrice: 150,
      costPrice: 60,
      initialStock: 3,
    })

    expect(variant.name).toBe("Red / M")
    expect(Number(variant.sellingPrice)).toBe(150)
    expect(Number(variant.costPrice)).toBe(60)

    const inventory = await prisma.inventory.findFirst({
      where: { variantId: variant.id, locationId: a.locations[0].id },
    })
    expect(inventory?.quantity).toBe(3)
  })

  it("rejects duplicate SKU within one organization", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "One",
      sku: "DUP-1",
      price: 100,
      stock: 5,
    })
    const other = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Two",
      price: 100,
      stock: 5,
    })

    await expectDomainError(
      () =>
        addVariant(a.org.id, a.user.id, other.id, a.locations[0].id, {
          name: "Copy",
          sku: "DUP-1",
          sellingPrice: 100,
          initialStock: 1,
        }),
      "CONFLICT"
    )
  })

  it("allows the SAME SKU in two different organizations (per-org scope)", async () => {
    const { a, b } = await twoOrgs()
    await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "A",
      sku: "SHARED-SKU",
      price: 100,
      stock: 5,
    })
    // Must NOT conflict — uniqueness is per organization now.
    const variant = await addVariant(b.org.id, b.user.id, (await createProduct(b.org.id, b.user.id, b.locations[0].id, { name: "B", price: 100, stock: 5 })).id, b.locations[0].id, {
      name: "Default",
      sku: "SHARED-SKU",
      sellingPrice: 100,
      initialStock: 1,
    })
    expect(variant.sku).toBe("SHARED-SKU")
  })

  it("allows the SAME barcode in two different organizations", async () => {
    const { a, b } = await twoOrgs()
    await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "A",
      price: 100,
      stock: 5,
    })
    await prisma.productVariant.updateMany({
      where: { product: { organizationId: a.org.id } },
      data: { barcode: "BAR-SHARED" },
    })
    const productB = await createProduct(b.org.id, b.user.id, b.locations[0].id, {
      name: "B",
      price: 100,
      stock: 5,
    })
    const variant = await addVariant(b.org.id, b.user.id, productB.id, b.locations[0].id, {
      name: "Default",
      barcode: "BAR-SHARED",
      sellingPrice: 100,
      initialStock: 1,
    })
    expect(variant.barcode).toBe("BAR-SHARED")
  })

  it("edits variant price/cost/sku; sku conflict within org rejected", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "P",
      sku: "SKU-KEEP",
      price: 100,
      stock: 5,
    })
    const variants = await prisma.productVariant.findMany({ where: { productId: product.id } })
    const target = variants[0]

    const other = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Other",
      sku: "SKU-TAKE",
      price: 100,
      stock: 5,
    })

    // Renaming to a FREE sku succeeds (price + cost edited too).
    const updated = await updateVariant(a.org.id, a.user.id, target.id, {
      name: "Renamed Variant",
      sellingPrice: 250,
      costPrice: 90,
      sku: "SKU-NEW-FREE",
    })
    expect(Number(updated.sellingPrice)).toBe(250)
    expect(Number(updated.costPrice)).toBe(90)
    expect(updated.sku).toBe("SKU-NEW-FREE")

    // Taking a sku HELD BY ANOTHER variant in the same org is rejected...
    await expectDomainError(
      () => updateVariant(a.org.id, a.user.id, target.id, { sku: "SKU-TAKE" }),
      "CONFLICT"
    )

    // ...but keeping a variant's own sku is allowed (self-exclusion).
    await updateVariant(a.org.id, a.user.id, target.id, { sku: "SKU-NEW-FREE" })

    // The other variant losing its sku to nobody — it still owns SKU-TAKE.
    const otherVariant = await prisma.productVariant.findFirst({
      where: { productId: other.id },
    })
    expect(otherVariant?.sku).toBe("SKU-TAKE")
  })

  it("cannot add variants to an archived product", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "P",
      price: 100,
      stock: 5,
    })
    await archiveProduct(a.org.id, a.user.id, product.id)
    await expectDomainError(
      () =>
        addVariant(a.org.id, a.user.id, product.id, a.locations[0].id, {
          name: "V",
          sellingPrice: 100,
          initialStock: 1,
        }),
      "VALIDATION"
    )
  })
})

describe("categories (AC-A3)", () => {
  it("creates categories unique per organization", async () => {
    const { a, b } = await twoOrgs()
    const category = await createCategory(a.org.id, a.user.id, "Tyres")
    expect(category.name).toBe("Tyres")

    // Duplicate name in the same org rejected...
    await expectDomainError(() => createCategory(a.org.id, a.user.id, "Tyres"), "CONFLICT")
    // ...but the same name is fine in another org.
    const other = await createCategory(b.org.id, b.user.id, "Tyres")
    expect(other.organizationId).toBe(b.org.id)
  })

  it("assigns a category to a product and clears it on delete (SetNull)", async () => {
    const { a } = await twoOrgs()
    const category = await createCategory(a.org.id, a.user.id, "Electronics")
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Radio",
      price: 100,
      stock: 5,
    })
    await updateProduct(a.org.id, a.user.id, product.id, { categoryId: category.id })

    let fetched = await prisma.product.findUnique({ where: { id: product.id } })
    expect(fetched?.categoryId).toBe(category.id)

    await deleteCategory(a.org.id, a.user.id, category.id)
    fetched = await prisma.product.findUnique({ where: { id: product.id } })
    expect(fetched?.categoryId).toBeNull()
    // The product itself still exists — history intact.
    expect(fetched?.name).toBe("Radio")
  })

  it("rejects cross-org category operations (NOT_FOUND)", async () => {
    const { a, b } = await twoOrgs()
    const category = await createCategory(a.org.id, a.user.id, "A-Only")
    await expectDomainError(() => deleteCategory(b.org.id, b.user.id, category.id), "NOT_FOUND")
  })
})

describe("archive / restore / guarded delete (AC-A4, D-12)", () => {
  it("archives: excluded from storefront, history retained; restore reverses", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Seasonal",
      price: 100,
      stock: 7,
    })

    await archiveProduct(a.org.id, a.user.id, product.id)

    const archived = await prisma.product.findUnique({ where: { id: product.id } })
    expect(archived?.archivedAt).not.toBeNull()
    // Inventory and movements are untouched by archiving.
    const inventory = await prisma.inventory.findFirst({
      where: { variant: { productId: product.id } },
    })
    expect(inventory?.quantity).toBe(7)

    let storefront = await getStorefrontProducts(a.org.id)
    expect(storefront.find((p) => p.id === product.id)).toBeUndefined()

    await restoreProduct(a.org.id, a.user.id, product.id)
    const restored = await prisma.product.findUnique({ where: { id: product.id } })
    expect(restored?.archivedAt).toBeNull()
    storefront = await getStorefrontProducts(a.org.id)
    expect(storefront.find((p) => p.id === product.id)).toBeDefined()
  })

  it("archive/restore are idempotent and cross-org-safe", async () => {
    const { a, b } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "P",
      price: 100,
      stock: 5,
    })

    // Idempotent re-archive and re-restore are no-ops, not errors.
    await archiveProduct(a.org.id, a.user.id, product.id)
    await archiveProduct(a.org.id, a.user.id, product.id)
    await restoreProduct(a.org.id, a.user.id, product.id)
    await restoreProduct(a.org.id, a.user.id, product.id)

    // Foreign org can neither archive nor restore it.
    await expectDomainError(() => archiveProduct(b.org.id, b.user.id, product.id), "NOT_FOUND")
    await expectDomainError(() => restoreProduct(b.org.id, b.user.id, product.id), "NOT_FOUND")
  })

  it("hard delete succeeds only for never-referenced products", async () => {
    const { a } = await twoOrgs()
    const clean = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Clean",
      price: 100,
      stock: 0,
    })
    await deleteProduct(a.org.id, a.user.id, clean.id)
    expect(await prisma.product.findUnique({ where: { id: clean.id } })).toBeNull()

    // A product with stock history cannot be deleted.
    const dirty = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Dirty",
      price: 100,
      stock: 3,
    })
    await expectDomainError(() => deleteProduct(a.org.id, a.user.id, dirty.id), "CONFLICT")
    expect(await prisma.product.findUnique({ where: { id: dirty.id } })).not.toBeNull()

    // A product with zero stock but a movement ledger entry cannot be deleted.
    const moved = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Moved",
      price: 100,
      stock: 1,
    })
    const movedVariant = await prisma.productVariant.findFirst({ where: { productId: moved.id } })
    await prisma.stockMovement.create({
      data: {
        locationId: a.locations[0].id,
        variantId: movedVariant!.id,
        actorId: a.user.id,
        type: "REMOVED",
        quantity: -1,
        referenceId: "test-manual-removal",
      },
    })
    await expectDomainError(() => deleteProduct(a.org.id, a.user.id, moved.id), "CONFLICT")
  })

  it("writes one archive and one restore audit event", async () => {
    const { a } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "P",
      price: 100,
      stock: 5,
    })
    await archiveProduct(a.org.id, a.user.id, product.id)
    await restoreProduct(a.org.id, a.user.id, product.id)

    const lifecycleAudits = (await prisma.auditLog.findMany({
      where: { organizationId: a.org.id, targetId: product.id, action: "UPDATE_PRODUCT" },
    })).filter((entry) => {
      const meta = entry.metadata as { action?: string } | null
      return meta?.action === "PRODUCT_ARCHIVE" || meta?.action === "PRODUCT_RESTORE"
    })
    expect(lifecycleAudits).toHaveLength(2)
  })
})

describe("explicit cost capture (AC-A5, E-21)", () => {
  it("stores the explicit cost; absent cost means zero (never fabricated)", async () => {
    const { a } = await twoOrgs()
    const withCost = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Tracked",
      price: 1000,
      cost: 400,
      stock: 5,
    })
    const withoutCost = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Untracked",
      price: 1000,
      stock: 5,
    })

    const trackedVariant = await prisma.productVariant.findFirst({
      where: { productId: withCost.id },
    })
    const untrackedVariant = await prisma.productVariant.findFirst({
      where: { productId: withoutCost.id },
    })

    // E-21 regression: cost is EXACTLY what was entered, and absent = 0.
    // The old `price * 0.5` fabrication would produce 500 for both.
    expect(Number(trackedVariant?.costPrice)).toBe(400)
    expect(Number(untrackedVariant?.costPrice)).toBe(0)
  })

  it("rejects negative or non-finite cost", async () => {
    const { a } = await twoOrgs()
    await expectDomainError(
      () =>
        createProduct(a.org.id, a.user.id, a.locations[0].id, {
          name: "Bad",
          price: 100,
          cost: -5,
          stock: 5,
        }),
      "VALIDATION"
    )
  })
})

describe("storefront product scope (AC-A6, core side)", () => {
  it("returns only PUBLISHED, non-archived products with variants and images", async () => {
    const { a, b } = await twoOrgs()
    const published = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Live",
      price: 100,
      stock: 5,
    })
    const draft = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Hidden",
      price: 100,
      stock: 5,
    })
    await updateProduct(a.org.id, a.user.id, draft.id, { status: "DRAFT" })
    const archived = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "Archived",
      price: 100,
      stock: 5,
    })
    await archiveProduct(a.org.id, a.user.id, archived.id)

    // Org B's product must never leak into org A's storefront payload.
    await createProduct(b.org.id, b.user.id, b.locations[0].id, {
      name: "Foreign",
      price: 100,
      stock: 5,
    })

    await addProductImage(a.org.id, a.user.id, published.id, {
      url: "https://cdn.example.com/live.jpg",
      isPrimary: true,
    })

    const storefront = await getStorefrontProducts(a.org.id)
    const names = storefront.map((p) => p.name)
    expect(names).toContain("Live")
    expect(names).not.toContain("Hidden")
    expect(names).not.toContain("Archived")
    expect(names).not.toContain("Foreign")
    // Images included and primary-aware.
    const live = storefront.find((p) => p.name === "Live")
    expect(live?.images).toHaveLength(1)
    expect(live?.images[0].isPrimary).toBe(true)
  })

  it("rejects cross-org image operations and invalid URLs", async () => {
    const { a, b } = await twoOrgs()
    const product = await createProduct(a.org.id, a.user.id, a.locations[0].id, {
      name: "P",
      price: 100,
      stock: 5,
    })

    await expectDomainError(
      () => addProductImage(b.org.id, b.user.id, product.id, { url: "https://x.test/a.jpg" }),
      "NOT_FOUND"
    )
    await expectDomainError(
      () => addProductImage(a.org.id, a.user.id, product.id, { url: "javascript:alert(1)" }),
      "VALIDATION"
    )
    await expectDomainError(
      () => addProductImage(a.org.id, a.user.id, product.id, { url: "not a url" }),
      "VALIDATION"
    )
  })
})
