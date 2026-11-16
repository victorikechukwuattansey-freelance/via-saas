// P1-A storefront contract tests (AC-A6, AC-A8) — Fastify app without a
// listening socket, via app.inject().
//
// Covers: slug resolution, PUBLISHED + non-archived filtering, images in the
// payload, CORS allowlist, safe validation errors, and the publication
// contract on checkout (draft/archived products are unsellable).
import { describe, expect, it, beforeAll } from "vitest"
import { prisma } from "@via-saas/database"
import { archiveProduct, updateProduct, createCategory } from "@via-saas/core"
import { buildApp } from "../apps/api/src/app"
import { createProductFixture, createOrganizationFixture, type OrgFixture } from "./helpers"

const app = buildApp()

beforeAll(async () => {
  await app.ready()
})

let fixtures: { a: OrgFixture; draft: { productId: string; variantId: string }; live: { productId: string; variantId: string }; archived: { productId: string; variantId: string } }

beforeAll(async () => {
  const a = await createOrganizationFixture()
  const live = await createProductFixture(a.org.id, a.locations[0].id, { price: 5000, stock: 10 })
  const draft = await createProductFixture(a.org.id, a.locations[0].id, { price: 5000, stock: 10, status: "DRAFT" })
  const archived = await createProductFixture(a.org.id, a.locations[0].id, { price: 5000, stock: 10 })
  await archiveProduct(a.org.id, a.user.id, archived.productId)

  // Give the live product a category + image to verify payload enrichment.
  const category = await createCategory(a.org.id, a.user.id, "Storefront")
  await updateProduct(a.org.id, a.user.id, live.productId, { categoryId: category.id })
  await prisma.productImage.create({
    data: { productId: live.productId, url: "https://cdn.example.com/live.jpg", isPrimary: true },
  })

  fixtures = { a, live, draft, archived }
})

describe("GET /api/stores/:slug/products", () => {
  it("returns only PUBLISHED, non-archived products with variants and images", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/stores/${fixtures.a.store.slug}/products`,
    })
    expect(res.statusCode).toBe(200)
    const products = res.json()
    expect(Array.isArray(products)).toBe(true)

    const ids = products.map((p: { id: string }) => p.id)
    expect(ids).toContain(fixtures.live.productId)
    expect(ids).not.toContain(fixtures.draft.productId)
    expect(ids).not.toContain(fixtures.archived.productId)

    const live = products.find((p: { id: string }) => p.id === fixtures.live.productId)
    expect(live.variants).toHaveLength(1)
    expect(live.images).toHaveLength(1)
    expect(live.images[0].url).toBe("https://cdn.example.com/live.jpg")
    expect(live.categoryId).toBeTruthy()
  })

  it("404s for an unknown slug without leaking internals", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/stores/no-such-store-ever/products",
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: "Store not found." })
  })

  it("honors the CORS allowlist", async () => {
    const allowed = await app.inject({
      method: "GET",
      url: `/api/stores/${fixtures.a.store.slug}/products`,
      headers: { origin: "http://localhost:3001" },
    })
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3001")

    const blocked = await app.inject({
      method: "GET",
      url: `/api/stores/${fixtures.a.store.slug}/products`,
      headers: { origin: "http://evil.example.net" },
    })
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined()
  })
})

describe("POST /api/checkout — publication contract", () => {
  const baseBody = {
    storeSlug: "", // set per-test
    customer: { name: "Ada", phone: "08012345678" },
    paymentMethod: "TRANSFER",
    cartToken: "tok_test_123",
  }

  it("sells a PUBLISHED, non-archived variant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        ...baseBody,
        storeSlug: fixtures.a.store.slug,
        items: [{ variantId: fixtures.live.variantId, quantity: 2 }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(body.orderNumber).toMatch(/^ORD-\d+$/)
  })

  it("rejects a DRAFT product variant with a safe 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        ...baseBody,
        storeSlug: fixtures.a.store.slug,
        items: [{ variantId: fixtures.draft.variantId, quantity: 1 }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("One or more items in your cart are unavailable.")
    // No ATTENTION order may be created for an unsellable item.
    const orders = await prisma.order.findMany({
      where: { organizationId: fixtures.a.org.id },
      include: { items: true },
    })
    expect(orders.find((o) => o.items.some((i) => i.variantId === fixtures.draft.variantId))).toBeUndefined()
  })

  it("rejects an ARCHIVED product variant with a safe 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        ...baseBody,
        storeSlug: fixtures.a.store.slug,
        items: [{ variantId: fixtures.archived.variantId, quantity: 1 }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe("One or more items in your cart are unavailable.")
  })

  it("400s on missing fields (E-22 safe envelopes)", async () => {
    const noCustomer = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: { storeSlug: fixtures.a.store.slug, paymentMethod: "CASH", cartToken: "t" },
    })
    expect(noCustomer.statusCode).toBe(400)

    const badMethod = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        ...baseBody,
        storeSlug: fixtures.a.store.slug,
        paymentMethod: "CARD",
        items: [{ variantId: fixtures.live.variantId, quantity: 1 }],
      },
    })
    expect(badMethod.statusCode).toBe(400)
  })

  it("404s an unknown store on checkout", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: {
        ...baseBody,
        storeSlug: "ghost-store",
        items: [{ variantId: fixtures.live.variantId, quantity: 1 }],
      },
    })
    expect(res.statusCode).toBe(404)
  })
})
