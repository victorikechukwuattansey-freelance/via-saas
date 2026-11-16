// P1-B POS SKU/barcode search (B6 / P1-11) — B-AC25..26.
// Unit tests for the pure search module + the per-org uniqueness backstop.
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { findVariantByCode, type PosProduct } from "../apps/merchant-dashboard/lib/pos-search"
import { randomBytes } from "node:crypto"

const product = (
  name: string,
  variants: Partial<Extract<PosProduct["variants"][number], { sku: string | null }>>[]
): PosProduct => ({
  id: `prod-${name}`,
  name,
  variants: variants.map((v, i) => ({
    id: v.id ?? `var-${name}-${i}`,
    name: v.name ?? `Variant ${i}`,
    sku: v.sku ?? null,
    barcode: v.barcode ?? null,
    sellingPrice: v.sellingPrice ?? "1000",
    inventory: v.inventory ?? [{ quantity: 10 }],
  })),
})

describe("B-AC25 — exact, case-insensitive SKU/barcode lookup", () => {
  const feed: PosProduct[] = [
    product("Milk", [{ sku: "SKU-MLK-1", barcode: "5012345678900" }]),
    product("Bread", [{ sku: "SKU-BRD-1", barcode: "5012345678901" }]),
  ]

  it("finds by exact SKU", () => {
    const result = findVariantByCode(feed, "SKU-MLK-1")
    expect(result.found).toBe(true)
    if (result.found) expect(result.variant.id).toBe("var-Milk-0")
  })

  it("finds by exact barcode", () => {
    const result = findVariantByCode(feed, "5012345678901")
    expect(result.found).toBe(true)
    if (result.found) expect(result.variant.id).toBe("var-Bread-0")
  })

  it("is case-insensitive", () => {
    const result = findVariantByCode(feed, "sku-mlk-1")
    expect(result.found).toBe(true)
    if (result.found) expect(result.ambiguous).toBe(false)
  })

  it("trims surrounding whitespace", () => {
    const result = findVariantByCode(feed, "  SKU-BRD-1  ")
    expect(result.found).toBe(true)
  })

  it("returns not-found for unknown, partial, or blank codes", () => {
    expect(findVariantByCode(feed, "SKU-NOPE").found).toBe(false)
    // No partial/fuzzy matching by design.
    expect(findVariantByCode(feed, "SKU-MLK").found).toBe(false)
    expect(findVariantByCode(feed, "").found).toBe(false)
    expect(findVariantByCode(feed, "   ").found).toBe(false)
  })

  it("does not treat SKU against barcode loosely (exact value only, both columns consulted)", () => {
    // "5012345678900" is Milk's barcode, not Bread's SKU — Milk is returned.
    const result = findVariantByCode(feed, "5012345678900")
    expect(result.found).toBe(true)
    if (result.found) expect(result.product.name).toBe("Milk")
  })
})

describe("B-AC25 — multi-match resolution (cross-column collision)", () => {
  it("resolves deterministically (product name, then variant name) and surfaces the ambiguity", () => {
    const feed: PosProduct[] = [
      product("Zebra Shirt", [{ sku: "12345", name: "Red" }]),
      product("Alpha Mug", [{ barcode: "12345", name: "Blue" }]),
      product("Mid Hat", [{ barcode: "12345", name: "Green" }]),
    ]

    const result = findVariantByCode(feed, "12345")
    expect(result.found).toBe(true)
    expect(result.ambiguous).toBe(true)
    if (result.found) {
      // Deterministic: lowest product name first.
      expect(result.product.name).toBe("Alpha Mug")
      expect(result.notice).toMatch(/matches 3 variants/i)
      expect(result.notice).toContain("Alpha Mug")
    }
  })

  it("tie-breaks equal product names by variant name", () => {
    const feed: PosProduct[] = [
      product("Same", [{ sku: "9", name: "Zulu" }]),
      product("Same", [{ barcode: "9", name: "Alpha" }]),
    ]
    const result = findVariantByCode(feed, "9")
    expect(result.found).toBe(true)
    if (result.found) expect(result.variant.name).toBe("Alpha")
  })
})

describe("B-AC26 — no cross-organization lookup results", () => {
  it("the search only sees the org-scoped feed it is given", async () => {
    // Two orgs with the SAME SKU.
    const { createOrganizationFixture, createProductFixture } = await import("./helpers")
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const shared = `SHARED-${randomBytes(4).toString("hex")}`
    const a = await createProductFixture(orgA.org.id, orgA.locations[0].id, { price: 1000, stock: 5 })
    const b = await createProductFixture(orgB.org.id, orgB.locations[0].id, { price: 1000, stock: 5 })
    await prisma.productVariant.update({ where: { id: a.variantId }, data: { sku: shared } })
    await prisma.productVariant.update({ where: { id: b.variantId }, data: { sku: shared } })

    // Org A's POS feed (same query shape as /api/products).
    const feedA = await prisma.product.findMany({
      where: { organizationId: orgA.org.id, status: "PUBLISHED", archivedAt: null },
      include: { variants: { include: { inventory: true } } },
    })

    const result = findVariantByCode(feedA as unknown as PosProduct[], shared)
    expect(result.found).toBe(true)
    if (result.found) {
      expect(result.variant.id).toBe(a.variantId)
      // Never org B's variant.
      expect(result.variant.id).not.toBe(b.variantId)
    }
  })
})

describe("B-AC25 backstop — per-org SKU/barcode uniqueness (P1-A D-2)", () => {
  it("duplicate SKU within one organization is rejected by the database", async () => {
    const { createOrganizationFixture, createProductFixture } = await import("./helpers")
    const org = await createOrganizationFixture()
    const first = await createProductFixture(org.org.id, org.locations[0].id)
    const dupe = await createProductFixture(org.org.id, org.locations[0].id)
    const sku = `DUPE-${randomBytes(4).toString("hex")}`
    await prisma.productVariant.update({ where: { id: first.variantId }, data: { sku } })

    await expect(
      prisma.productVariant.update({ where: { id: dupe.variantId }, data: { sku } })
    ).rejects.toThrow()
  })

  it("the SAME SKU in a DIFFERENT organization is allowed (org-scoped uniqueness)", async () => {
    const { createOrganizationFixture, createProductFixture } = await import("./helpers")
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const first = await createProductFixture(orgA.org.id, orgA.locations[0].id)
    const second = await createProductFixture(orgB.org.id, orgB.locations[0].id)
    const sku = `XORG-${randomBytes(4).toString("hex")}`

    await prisma.productVariant.update({ where: { id: first.variantId }, data: { sku } })
    await expect(
      prisma.productVariant.update({ where: { id: second.variantId }, data: { sku } })
    ).resolves.toBeTruthy()
  })
})
