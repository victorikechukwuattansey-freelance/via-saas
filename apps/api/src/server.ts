import Fastify from "fastify"
import cors from "@fastify/cors"
import { getProductsByOrg, processCheckout, upsertCustomer, DomainError } from "@via-saas/core"
import { prisma } from "@via-saas/database"
import crypto from "crypto"

const app = Fastify({ logger: true })

// CORS origins come from configuration (comma-separated). In local dev the
// docker/storefront default is used; production must set STOREFRONT_ORIGINS.
const allowedOrigins = (process.env.STOREFRONT_ORIGINS ?? "http://localhost:3001")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

app.register(cors, {
  origin: (origin, cb) => {
    // Allow requests with no Origin header (same-origin tools, health checks)
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true)
      return
    }
    cb(new Error("Origin not allowed"), false)
  },
})

function safeErrorReply(reply: import("fastify").FastifyReply, error: unknown, fallback: string) {
  if (error instanceof DomainError) {
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "ITEM_UNAVAILABLE" ? 409 : 400
    return reply.status(status).send({ error: error.message })
  }
  app.log.error(error instanceof Error ? error.message : error)
  return reply.status(500).send({ error: fallback })
}

// Health Check
app.get("/health", async () => ({ status: "ok" }))

/**
 * Resolves the merchant organization from the store's public slug.
 * No hardcoded organization/location identifiers exist anywhere (M1.4).
 */
async function resolveStoreBySlug(slug: string) {
  const store = await prisma.store.findUnique({
    where: { slug },
    include: { locations: { take: 1 } },
  })
  if (!store || store.locations.length === 0) return null
  return { store, location: store.locations[0] }
}

// Public Storefront Endpoint: Get Products (published only)
app.get("/api/stores/:slug/products", async (request, reply) => {
  const { slug } = request.params as { slug: string }
  try {
    const resolved = await resolveStoreBySlug(slug)
    if (!resolved) {
      return reply.status(404).send({ error: "Store not found." })
    }

    const products = await getProductsByOrg(resolved.store.organizationId)
    // Drafts are never exposed on the public plane.
    return products.filter((product) => product.status === "PUBLISHED")
  } catch (error: unknown) {
    return safeErrorReply(reply, error, "Failed to fetch products")
  }
})

// 3. Generate a Guest Cart Token
app.post("/api/cart", async (request, reply) => {
  // Generate an opaque 256-bit token for the shopper
  const cartToken = crypto.randomBytes(32).toString("hex")
  return { cartToken }
})

// 4. Checkout Endpoint
app.post("/api/checkout", async (request, reply) => {
  const body = request.body as {
    storeSlug?: string
    items?: { variantId?: string; quantity?: number }[]
    customer?: { name?: string; phone?: string; email?: string }
    paymentMethod?: string
    cartToken?: string
  }

  // Basic request validation (full schema validation lands with P0-8 follow-up)
  if (!body?.cartToken) {
    return reply.status(401).send({ error: "Missing cart token" })
  }
  if (!body.storeSlug) {
    return reply.status(400).send({ error: "Missing store" })
  }
  if (!body.customer?.name || !body.customer?.phone) {
    return reply.status(400).send({ error: "Customer name and phone are required." })
  }
  if (body.paymentMethod !== "CASH" && body.paymentMethod !== "TRANSFER") {
    return reply.status(400).send({ error: "Unsupported payment method." })
  }

  try {
    // Resolve the merchant from the public store slug — never hardcoded ids.
    const resolved = await resolveStoreBySlug(body.storeSlug)
    if (!resolved) {
      return reply.status(404).send({ error: "Store not found." })
    }

    // 1. Create the customer record (race-safe upsert)
    const customer = await upsertCustomer(resolved.store.organizationId, {
      name: body.customer.name,
      phone: body.customer.phone,
      email: body.customer.email,
    })

    // 2. Process the order. NOTE:
    //    - Unit prices are resolved server-side; client prices are ignored.
    //    - actorId is null: system-originated movements have no fake user id.
    const order = await processCheckout(
      resolved.store.organizationId,
      resolved.location.id,
      null,
      (body.items ?? []).map((item) => ({
        variantId: String(item?.variantId ?? ""),
        quantity: Number(item?.quantity),
      })),
      body.paymentMethod,
      customer.id
    )

    // 3. Invalidate cart token (client will destroy it)
    return { success: true, orderNumber: order.orderNumber, status: order.status }

  } catch (error: unknown) {
    return safeErrorReply(reply, error, "Checkout failed")
  }
})

const start = async () => {
  try {
    await app.listen({ port: 4000, host: "0.0.0.0" })
    console.log("VIA storefront API running at http://localhost:4000")
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
start()
