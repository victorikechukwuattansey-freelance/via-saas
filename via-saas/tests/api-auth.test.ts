import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { buildApp } from "../apps/api/src/app"
import { createOrganizationFixture } from "./helpers"

const app = buildApp()

beforeAll(async () => {
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe("merchant API authentication", () => {
  it("rejects requests without a session cookie", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/merchant/session",
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: "Unauthenticated" })
  })

  it("rejects an unknown session token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/merchant/session",
      headers: { cookie: `session_token=${randomUUID()}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: "Unauthenticated" })
  })

  it("rejects and lazily deletes an expired session", async () => {
    const fixture = await createOrganizationFixture()
    const token = randomUUID()
    const session = await prisma.session.create({
      data: {
        token,
        userId: fixture.user.id,
        expiresAt: new Date(Date.now() - 1_000),
      },
    })

    const response = await app.inject({
      method: "GET",
      url: "/api/merchant/session",
      headers: { cookie: `session_token=${token}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: "Unauthenticated" })
    await expect(
      prisma.session.findUnique({ where: { id: session.id } })
    ).resolves.toBeNull()
  })

  it("returns the verified merchant context for a valid session", async () => {
    const fixture = await createOrganizationFixture({
      role: "MANAGER",
      locationCount: 2,
    })
    const token = randomUUID()
    await prisma.session.create({
      data: {
        token,
        userId: fixture.user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    })

    const response = await app.inject({
      method: "GET",
      url: "/api/merchant/session",
      headers: { cookie: `session_token=${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      userId: fixture.user.id,
      orgId: fixture.org.id,
      orgName: fixture.org.name,
      role: "MANAGER",
    })
    expect(body.accessibleLocationIds).toEqual(
      expect.arrayContaining(fixture.locations.map((location) => location.id))
    )
    expect(body.accessibleLocationIds).toHaveLength(2)
    expect(body.locationId).toBe(body.accessibleLocationIds[0])
    expect(body).not.toHaveProperty("user")
  })

  it("rejects a session whose user has no eligible membership", async () => {
    const fixture = await createOrganizationFixture()
    await prisma.membership.delete({ where: { id: fixture.membership.id } })
    const token = randomUUID()
    await prisma.session.create({
      data: {
        token,
        userId: fixture.user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    })

    const response = await app.inject({
      method: "GET",
      url: "/api/merchant/session",
      headers: { cookie: `session_token=${token}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: "Unauthenticated" })
  })
})

describe("merchant API credentialed CORS", () => {
  it("allows credentials for an explicitly allowed dashboard origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3001" },
    })

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3001"
    )
    expect(response.headers["access-control-allow-credentials"]).toBe("true")
  })

  it("does not grant credentialed CORS access to an unlisted origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://evil.example.net" },
    })

    expect(response.headers["access-control-allow-origin"]).toBeUndefined()
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined()
  })
})
