// P1-A stock-adjustment and catalogue-management permission tests.
//
// Binding decision: stock adjustment = OWNER/MANAGER always + STAFF only when
// EXPLICITLY authorized (non-empty allowedLocationIds). Catalogue mutations =
// OWNER/MANAGER only.
//
// next/headers is mocked (same pattern as session.test.ts); everything else
// is real against the disposable test DB.
import { describe, expect, it, vi, beforeEach } from "vitest"
import { prisma } from "@via-saas/database"

vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}))

import {
  canAdjustStock,
  canManageCatalogue,
  getSessionContext,
} from "../../apps/merchant-dashboard/lib/auth-helpers"
import { cookies } from "next/headers"
import bcrypt from "bcryptjs"

const mockedCookies = vi.mocked(cookies)

type CookieJar = Map<string, string>

function setCookieJar(jar: CookieJar) {
  mockedCookies.mockReturnValue({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  } as unknown as ReturnType<typeof cookies>)
}

beforeEach(() => {
  setCookieJar(new Map())
})

async function createMembershipFixture(options: {
  role: "OWNER" | "MANAGER" | "STAFF"
  allowedLocationIds?: string[]
}) {
  const suffix = Math.random().toString(36).slice(2, 10)
  const user = await prisma.user.create({
    data: {
      name: `Perm User ${suffix}`,
      email: `perm-${suffix}@via.test`,
      passwordHash: await bcrypt.hash("test-password-123", 10),
    },
  })
  const org = await prisma.organization.create({ data: { name: `PermOrg ${suffix}` } })
  const store = await prisma.store.create({
    data: { name: `PermStore ${suffix}`, organizationId: org.id, slug: `perm-${suffix}` },
  })
  const location = await prisma.location.create({
    data: { name: `PermLoc ${suffix}`, storeId: store.id },
  })
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: org.id,
      role: options.role,
      allowedLocationIds: options.allowedLocationIds ?? [],
    },
  })
  const token = `perm-token-${suffix}`
  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  return { token, locationId: location.id, membershipId: membership.id, orgId: org.id }
}

describe("canAdjustStock (binding P1-A decision)", () => {
  it("allows OWNER always", async () => {
    const f = await createMembershipFixture({ role: "OWNER" })
    setCookieJar(new Map([["session_token", f.token]]))
    const context = await getSessionContext()
    expect(context).not.toBeNull()
    expect(canAdjustStock(context!)).toBe(true)
  })

  it("allows MANAGER always", async () => {
    const f = await createMembershipFixture({ role: "MANAGER" })
    setCookieJar(new Map([["session_token", f.token]]))
    const context = await getSessionContext()
    expect(canAdjustStock(context!)).toBe(true)
  })

  it("REJECTS an unrestricted STAFF member (no explicit authorization)", async () => {
    const f = await createMembershipFixture({ role: "STAFF", allowedLocationIds: [] })
    setCookieJar(new Map([["session_token", f.token]]))
    const context = await getSessionContext()
    expect(context).not.toBeNull()
    expect(canAdjustStock(context!)).toBe(false)
  })

  it("ALLOWS a STAFF member explicitly authorized via allowedLocationIds", async () => {
    const f = await createMembershipFixture({
      role: "STAFF",
      allowedLocationIds: [], // set below after location id is known
    })
    await prisma.membership.update({
      where: { id: f.membershipId },
      data: { allowedLocationIds: [f.locationId] },
    })
    setCookieJar(new Map([["session_token", f.token]]))
    const context = await getSessionContext()
    expect(context).not.toBeNull()
    expect(context!.accessibleLocationIds).toContain(f.locationId)
    expect(canAdjustStock(context!)).toBe(true)
  })
})

describe("canManageCatalogue", () => {
  it("allows OWNER and MANAGER, rejects STAFF (even authorized staff)", async () => {
    const owner = await createMembershipFixture({ role: "OWNER" })
    setCookieJar(new Map([["session_token", owner.token]]))
    expect(canManageCatalogue((await getSessionContext())!)).toBe(true)

    const manager = await createMembershipFixture({ role: "MANAGER" })
    setCookieJar(new Map([["session_token", manager.token]]))
    expect(canManageCatalogue((await getSessionContext())!)).toBe(true)

    const staff = await createMembershipFixture({
      role: "STAFF",
      allowedLocationIds: [], // patched below
    })
    await prisma.membership.update({
      where: { id: staff.membershipId },
      data: { allowedLocationIds: [staff.locationId] },
    })
    setCookieJar(new Map([["session_token", staff.token]]))
    expect(canManageCatalogue((await getSessionContext())!)).toBe(false)
  })
})
