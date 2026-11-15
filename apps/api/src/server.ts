import Fastify from "fastify"
import cors from "@fastify/cors"
import { getProductsByOrg, processCheckout, upsertCustomer } from "@via-saas/core"
import crypto from "crypto"

const app = Fastify({ logger: true })

app.register(cors, { origin: "*" }) // In production, restrict this to your storefront domain

// Health Check
app.get("/health", async () => ({ status: "ok" }))

// Public Storefront Endpoint: Get Products
// (In a real app, you'd look up the organization by a subdomain or store ID first)
app.get("/api/products", async (request, reply) => {
  try {
    // Hardcoded orgId for testing purposes. The storefront will eventually pass a real ID.
    const MOCK_ORG_ID = "cmwfvw48r0002abgh0uor5b7t" 
    const products = await getProductsByOrg(MOCK_ORG_ID)
    return products
  } catch (error) {
    reply.status(500).send({ error: "Failed to fetch products" })
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
  const { items, customer, paymentMethod, cartToken } = request.body as any

  if (!cartToken) {
    return reply.status(401).send({ error: "Missing X-Cart-Token" })
  }

  try {
    const MOCK_ORG_ID = "cmwfvw48r0002abgh0uor5b7t" // <--- PASTE YOUR REAL ORG ID HERE
    const MOCK_LOCATION_ID = "cmwfvw49t0006abghnckhmgea" // <--- PASTE YOUR REAL LOCATION ID HERE

    // 1. Create the customer record
    const newCustomer = await upsertCustomer(MOCK_ORG_ID, {
      name: customer.name,
      phone: customer.phone,
      email: customer.email
    })

    // 2. Process the order using the core logic (handles inventory deduction & attention state)
    const order = await processCheckout(
      MOCK_ORG_ID,
      MOCK_LOCATION_ID,
      "SYSTEM_STOREFRONT", // actorId
      items,
      paymentMethod,
      newCustomer.id
    )

    // 3. Invalidate cart token (client will destroy it)
    return { success: true, orderNumber: order.orderNumber, status: order.status }

  } catch (error: any) {
    app.log.error(error)
    reply.status(500).send({ error: error.message || "Checkout failed" })
  }
})

const start = async () => {
  try {
    await app.listen({ port: 4000, host: "0.0.0.0" })
    console.log("🚀 API Server running at http://localhost:4000")
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}
start()
