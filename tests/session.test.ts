// AC-6 / E-8 — Session expiry enforced in getSessionContext; E-11 —
// allowedLocationIds are enforced (not merely stored).
//
// next/headers is mocked so the dashboard helper can be exercised outside of
// a Next.js request context. Everything else (Prisma, real sessions in the
// disposable test DB) is real.
import { describe, expect, it, vi, beforeEach } from "vitest"
import { prisma } from "@via-saas/database"

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}))

import { canAccessLocation, getSessionContext } from "../../apps/merchant-dashboard/lib/auth-helpers"
import { cookies } from "next/headers"
import bcrypt from "bcryptjs"

const mockedCookies = vi.mocked(cookies)

type CookieJar = Map<string, string>

function setCookieJar(jar: CookieJar) {
  mockedCookies.mockReturnValue({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  } as unknown as ReturnType<typeof cookies>)
}

async function createSessionFixture(options?: {
  role?: "OWNER" | "MANAGER" | "STAFF"
  allowedLocationIds?: string[]
  expiresAt?: Date
  locationCount?: number
}) {
  const suffix = Math.random().toString(36).slice(2, 10)
  const user = await prisma.user.create({
    data: {
      name: `Session User ${suffix}`,
      email: `session-${suffix}@via.test`,
      passwordHash: await bcrypt.hash("test-password-123", 10),
    },
  })
  const org = await prisma.organization.create({ data: { name: `SessOrg ${suffix}` } })
  const store = await prisma.store.create({
    data: { name: `SessStore ${suffix}`, organizationId: org.id, slug: `sess-${suffix}` },
  })
  const locations = []
  for (let i = 0; i < (options?.locationCount ?? 2); i++) {
    locations.push(
      await prisma.location.create({ data: { name: `Loc ${i} ${suffix}`, storeId: store.id } })
    )
  }
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      role: options?.role ?? "OWNER",
      allowedLocationIds: options?.allowedLocationIds ?? [],
    },
  })
  const session = await prisma.session.create({
    data: {
      token: `sess-token-${suffix}`,
      userId: user.id,
      expiresAt: options?.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  return { user, org, store, locations, membership, session }
}

beforeEach(() => {
  mockedCookies.mockReset()
})

describe("session expiry (E-8 / AC-6)", () => {
  it("returns the context for a valid, unexpired session", async () => {
    const fixture = await createSessionFixture()
    const jar: CookieJar = new Map([["session_token", fixture.session.token]])
    setCookieJar(jar)

    const context = await getSessionContext()

    expect(context).not.toBeNull()
    expect(context?.userId).toBe(fixture.user.id)
    expect(context?.orgId).toBe(fixture.org.id)
    expect(context?.role).toBe("OWNER")
    // Unrestricted membership can access all org locations
    expect(context?.accessibleLocationIds).toEqual(
      expect.arrayContaining(fixture.locations.map((l) => l.id))
    )
  })

  it("treats an expired session as unauthenticated AND deletes it", async () => {
    const fixture = await createSessionFixture({
      expiresAt: new Date(Date.now() - 1000),
    })
    const jar: CookieJar = new Map([["session_token", fixture.session.token]])
    setCookieJar(jar)

    const context = await getSessionContext()

    expect(context).toBeNull()

    // The expired session no longer exists in the database
    const remaining = await prisma.session.findUnique({ where: { id: fixture.session.id } })
    expect(remaining).toBeNull()
  })

  it("returns null for an unknown token without touching other sessions", async () => {
    const fixture = await createSessionFixture()
    const jar: CookieJar = new Map([["session_token", "totally-unknown-token"]])
    setCookieJar(jar)

    expect(await getSessionContext()).toBeNull()

    const stillThere = await prisma.session.findUnique({ where: { id: fixture.session.id } })
    expect(stillThere).not.toBeNull()
  })

  it("returns null when no session cookie is present", async () => {
    setCookieJar(new Map())
    expect(await getSessionContext()).toBeNull()
  })

  it("returns null for a user without any membership", async () => {
    const fixture = await createSessionFixture()
    await prisma.membership.delete({ where: { id: fixture.membership.id } })
    const jar: CookieJar = new Map([["session_token", fixture.session.token]])
    setCookieJar(jar)

    expect(await getSessionContext()).toBeNull()
  })
})

describe("location authorization from the session (E-11)", () => {
  it("restricts accessibleLocationIds to allowedLocationIds when set", async () => {
    const fixture = await createSessionFixture({
      allowedLocationIds: [],
    })
    const secondLocation = fixture.locations[1].id
    await prisma.membership.update({
      where: { id: fixture.membership.id },
      data: { allowedLocationIds: [secondLocation] },
    })

    const jar: CookieJar = new Map([["session_token", fixture.session.token]])
    setCookieJar(jar)

    const context = await getSessionContext()

    expect(context?.accessibleLocationIds).toEqual([secondLocation])
    expect(context?.locationId).toBe(secondLocation)
    expect(canAccessLocation(context!, fixture.locations[0].id)).toBe(false)
    expect(canAccessLocation(context!, secondLocation)).toBe(true)
  })

  it("yields no context when the membership has zero accessible locations", async () => {
    // allowedLocationIds contains an id that does not belong to the org's stores
    const fixture = await createSessionFixture({ allowedLocationIds: ["nonexistent-location"] })
    const jar: CookieJar = new Map([["session_token", fixture.session.token]])
    setCookieJar(jar)

    const context = await getSessionContext()
    expect(context).toBeNull()
  })
})
