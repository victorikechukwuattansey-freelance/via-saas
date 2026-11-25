// M2-01 — focused tests for @via-saas/core session context resolution.
import { describe, expect, it } from "vitest"
import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"
import { prisma } from "@via-saas/database"
import {
  resolveSessionContext,
  pickInitialActiveOrganization,
  isMembershipEligible,
} from "@via-saas/core"

type SessionFixture = {
  userId: string
  orgId: string
  membershipId: string
  locationIds: string[]
  sessionToken: string
}

async function createSessionContextFixture(options?: {
  expiresAt?: Date
  activeOrganizationId?: string | null
  locationCount?: number
  allowedLocationIds?: string[]
  role?: "OWNER" | "MANAGER" | "STAFF"
  archiveOrg?: boolean
  archiveLocations?: boolean[]
}): Promise<SessionFixture> {
  const suffix = randomBytes(4).toString("hex")
  const user = await prisma.user.create({
    data: {
      name: `SC User ${suffix}`,
      email: `sc-${suffix}@via.test`,
      passwordHash: await bcrypt.hash("test-password-123", 10),
    },
  })
  const org = await prisma.organization.create({
    data: {
      name: `SC Org ${suffix}`,
      archivedAt: options?.archiveOrg ? new Date() : null,
    },
  })
  const store = await prisma.store.create({
    data: { name: `SC Store ${suffix}`, organizationId: org.id, slug: `sc-${suffix}` },
  })
  const count = options?.locationCount ?? 2
  const locationIds: string[] = []
  for (let i = 0; i < count; i++) {
    const loc = await prisma.location.create({
      data: {
        name: `SC Loc ${i} ${suffix}`,
        storeId: store.id,
        archivedAt: options?.archiveLocations?.[i] ? new Date() : null,
      },
    })
    locationIds.push(loc.id)
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
      token: `sc-token-${suffix}`,
      userId: user.id,
      expiresAt: options?.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      activeOrganizationId: options?.activeOrganizationId === undefined ? null : options.activeOrganizationId,
    },
  })
  return {
    userId: user.id,
    orgId: org.id,
    membershipId: membership.id,
    locationIds,
    sessionToken: session.token,
  }
}

describe("resolveSessionContext (M2-01)", () => {
  it("1. returns null for missing token", async () => {
    expect(await resolveSessionContext(undefined)).toBeNull()
    expect(await resolveSessionContext("")).toBeNull()
  })

  it("2. returns null for unknown token", async () => {
    expect(await resolveSessionContext("definitely-not-a-real-token")).toBeNull()
  })

  it("3. treats expired session as unauthenticated and deletes it (lazy cleanup)", async () => {
    const fx = await createSessionContextFixture({
      expiresAt: new Date(Date.now() - 1000),
    })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).toBeNull()
    const stillThere = await prisma.session.findFirst({ where: { token: fx.sessionToken } })
    expect(stillThere).toBeNull()
  })

  it("4. returns context for a valid session with eligible membership (exact key fields)", async () => {
    const fx = await createSessionContextFixture({ locationCount: 1 })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).not.toBeNull()
    expect(ctx?.userId).toBe(fx.userId)
    expect(ctx?.orgId).toBe(fx.orgId)
    expect(ctx?.role).toBe("OWNER")
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: fx.orgId } })
    expect(ctx?.orgName).toBe(org.name)
    expect(ctx?.user).toBeTruthy()
    expect(ctx?.user.id).toBe(fx.userId)
    expect(ctx?.user.email).toBe(`sc-${fx.sessionToken.split("sc-token-")[1]}@via.test`)
    expect(typeof ctx?.user.name).toBe("string")
    expect((ctx?.user as Record<string, unknown>).passwordHash).toBeUndefined()
    expect((ctx?.user as Record<string, unknown>).createdAt).toBeUndefined()
    expect((ctx?.user as Record<string, unknown>).updatedAt).toBeUndefined()
    expect((ctx?.user as Record<string, unknown>).memberships).toBeUndefined()
    expect((ctx?.user as Record<string, unknown>).sessions).toBeUndefined()
    expect(ctx?.accessibleLocationIds.length).toBeGreaterThan(0)
    expect(fx.locationIds).toContain(ctx?.locationId)
    expect(Array.isArray(ctx?.rawAllowedLocationIds)).toBe(true)
    expect(ctx?.rawAllowedLocationIds).toEqual([])
  })

  it("5. valid session with multiple accessible locations returns deterministic locationId pick context", async () => {
    const fx = await createSessionContextFixture({ locationCount: 2 })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).not.toBeNull()
    expect(ctx?.accessibleLocationIds.length).toBe(2)
    // deterministic ordering by createdAt then id; we at least assert both are present
    expect(new Set(ctx?.accessibleLocationIds)).toEqual(new Set(fx.locationIds))
  })

  it("6. restricted membership location access (allowedLocationIds non-empty)", async () => {
    const fx = await createSessionContextFixture({
      locationCount: 2,
      allowedLocationIds: ["__will_replace__"],
    })
    // replace with real second location id
    await prisma.membership.update({
      where: { id: fx.membershipId },
      data: { allowedLocationIds: [fx.locationIds[1]] },
    })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).not.toBeNull()
    expect(ctx?.accessibleLocationIds).toEqual([fx.locationIds[1]])
    expect(ctx?.locationId).toBe(fx.locationIds[1])
    expect(ctx?.rawAllowedLocationIds).toEqual([fx.locationIds[1]])
  })

  it("6b. non-empty allowedLocationIds with no intersection to active locations yields null", async () => {
    const fx = await createSessionContextFixture({
      locationCount: 2,
      allowedLocationIds: [],
    })
    await prisma.membership.update({
      where: { id: fx.membershipId },
      data: { allowedLocationIds: ["nonexistent-location-id"] },
    })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).toBeNull()
  })

  it("7. empty allowedLocationIds grants all active locations", async () => {
    const fx = await createSessionContextFixture({
      locationCount: 2,
      allowedLocationIds: [],
    })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).not.toBeNull()
    expect(new Set(ctx?.accessibleLocationIds)).toEqual(new Set(fx.locationIds))
  })

  it("8. archived locations are excluded", async () => {
    const fx = await createSessionContextFixture({
      locationCount: 2,
      archiveLocations: [true, false],
    })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).not.toBeNull()
    expect(ctx?.accessibleLocationIds).toEqual([fx.locationIds[1]])
  })

  it("9. archived organizations are excluded (no eligible context)", async () => {
    const fx = await createSessionContextFixture({ archiveOrg: true })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).toBeNull()
  })

  it("10. preferred active organization selected when eligible", async () => {
    const suffix = randomBytes(4).toString("hex")
    const user = await prisma.user.create({
      data: {
        name: `SC User2 ${suffix}`,
        email: `sc2-${suffix}@via.test`,
        passwordHash: await bcrypt.hash("test-password-123", 10),
      },
    })
    // org A older
    const orgA = await prisma.organization.create({
      data: { name: `A ${suffix}`, createdAt: new Date("2024-01-01T00:00:00.000Z") },
    })
    const storeA = await prisma.store.create({ data: { name: `SA ${suffix}`, organizationId: orgA.id } })
    const locA = await prisma.location.create({ data: { name: `LA ${suffix}`, storeId: storeA.id } })
    await prisma.membership.create({
      data: { userId: user.id, organizationId: orgA.id, role: "OWNER", allowedLocationIds: [] },
    })
    // org B newer
    const orgB = await prisma.organization.create({
      data: { name: `B ${suffix}`, createdAt: new Date("2024-06-01T00:00:00.000Z") },
    })
    const storeB = await prisma.store.create({ data: { name: `SB ${suffix}`, organizationId: orgB.id } })
    const locB = await prisma.location.create({ data: { name: `LB ${suffix}`, storeId: storeB.id } })
    await prisma.membership.create({
      data: { userId: user.id, organizationId: orgB.id, role: "MANAGER", allowedLocationIds: [] },
    })
    const session = await prisma.session.create({
      data: {
        token: `sc2-token-${suffix}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        activeOrganizationId: orgB.id,
      },
    })
    const ctx = await resolveSessionContext(session.token)
    expect(ctx?.orgId).toBe(orgB.id)
    expect(ctx?.orgName).toBe(orgB.name)
    expect(ctx?.role).toBe("MANAGER")
    expect(ctx?.locationId).toBe(locB.id)
  })

  it("10b. preferred activeOrganizationId points to membership whose org is archived → falls back to eligible org", async () => {
    const suffix2b = randomBytes(4).toString("hex")
    const user2b = await prisma.user.create({
      data: {
        name: `SC User2b ${suffix2b}`,
        email: `sc2b-${suffix2b}@via.test`,
        passwordHash: await bcrypt.hash("test-password-123", 10),
      },
    })
    const orgArchived2b = await prisma.organization.create({
      data: { name: `Archived ${suffix2b}`, createdAt: new Date("2024-01-01T00:00:00.000Z"), archivedAt: new Date() },
    })
    const storeA2b = await prisma.store.create({ data: { name: `SA2b ${suffix2b}`, organizationId: orgArchived2b.id } })
    await prisma.location.create({ data: { name: `LA2b ${suffix2b}`, storeId: storeA2b.id } })
    await prisma.membership.create({
      data: { userId: user2b.id, organizationId: orgArchived2b.id, role: "OWNER", allowedLocationIds: [] },
    })
    const orgOk2b = await prisma.organization.create({
      data: { name: `Ok ${suffix2b}`, createdAt: new Date("2024-06-01T00:00:00.000Z") },
    })
    const storeB2b = await prisma.store.create({ data: { name: `SB2b ${suffix2b}`, organizationId: orgOk2b.id } })
    const locB2b = await prisma.location.create({ data: { name: `LB2b ${suffix2b}`, storeId: storeB2b.id } })
    await prisma.membership.create({
      data: { userId: user2b.id, organizationId: orgOk2b.id, role: "MANAGER", allowedLocationIds: [] },
    })
    const session2b = await prisma.session.create({
      data: {
        token: `sc2b-token-${suffix2b}`,
        userId: user2b.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        activeOrganizationId: orgArchived2b.id,
      },
    })
    const ctx = await resolveSessionContext(session2b.token)
    expect(ctx).not.toBeNull()
    expect(ctx?.orgId).toBe(orgOk2b.id)
    expect(ctx?.locationId).toBe(locB2b.id)
  })

  it("11. fallback when preferred active organization is unavailable", async () => {
    const suffix = randomBytes(4).toString("hex")
    const user = await prisma.user.create({
      data: {
        name: `SC User3 ${suffix}`,
        email: `sc3-${suffix}@via.test`,
        passwordHash: await bcrypt.hash("test-password-123", 10),
      },
    })
    const orgA = await prisma.organization.create({
      data: { name: `A3 ${suffix}`, createdAt: new Date("2024-01-01T00:00:00.000Z") },
    })
    const storeA = await prisma.store.create({ data: { name: `SA3 ${suffix}`, organizationId: orgA.id } })
    await prisma.location.create({ data: { name: `LA3 ${suffix}`, storeId: storeA.id } })
    await prisma.membership.create({
      data: { userId: user.id, organizationId: orgA.id, role: "OWNER", allowedLocationIds: [] },
    })
    const session = await prisma.session.create({
      data: {
        token: `sc3-token-${suffix}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        activeOrganizationId: "org-does-not-exist",
      },
    })
    const ctx = await resolveSessionContext(session.token)
    expect(ctx?.orgId).toBe(orgA.id)
  })

  it("12. deterministic organization ordering (createdAt then membership id)", async () => {
    const suffix = randomBytes(4).toString("hex")
    const user = await prisma.user.create({
      data: {
        name: `SC User4 ${suffix}`,
        email: `sc4-${suffix}@via.test`,
        passwordHash: await bcrypt.hash("test-password-123", 10),
      },
    })
    // Create orgB first but make it "later" by createdAt? easier: set explicit createdAt
    const orgLater = await prisma.organization.create({
      data: { name: `Later ${suffix}`, createdAt: new Date("2024-12-01T00:00:00.000Z") },
    })
    const storeL = await prisma.store.create({ data: { name: `SL ${suffix}`, organizationId: orgLater.id } })
    const locL = await prisma.location.create({ data: { name: `LL ${suffix}`, storeId: storeL.id } })
    await prisma.membership.create({
      data: { userId: user.id, organizationId: orgLater.id, role: "OWNER", allowedLocationIds: [] },
    })
    const orgEarlier = await prisma.organization.create({
      data: { name: `Earlier ${suffix}`, createdAt: new Date("2024-01-01T00:00:00.000Z") },
    })
    const storeE = await prisma.store.create({ data: { name: `SE ${suffix}`, organizationId: orgEarlier.id } })
    const locE = await prisma.location.create({ data: { name: `LE ${suffix}`, storeId: storeE.id } })
    await prisma.membership.create({
      data: { userId: user.id, organizationId: orgEarlier.id, role: "OWNER", allowedLocationIds: [] },
    })
    const session = await prisma.session.create({
      data: {
        token: `sc4-token-${suffix}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    const ctx = await resolveSessionContext(session.token)
    expect(ctx?.orgId).toBe(orgEarlier.id)
    expect(ctx?.locationId).toBe(locE.id)
  })

  it("13. deterministic location ordering (createdAt then id) is applied (stable across calls)", async () => {
    const fx = await createSessionContextFixture({ locationCount: 2 })
    const ctx1 = await resolveSessionContext(fx.sessionToken)
    const ctx2 = await resolveSessionContext(fx.sessionToken)
    expect(ctx1?.locationId).toBe(ctx2?.locationId)
    expect(ctx1?.accessibleLocationIds).toEqual(ctx2?.accessibleLocationIds)
  })

  it("13b. deterministic location ordering by createdAt then id (explicit)", async () => {
    const suffix = randomBytes(4).toString("hex")
    const user = await prisma.user.create({
      data: {
        name: `SC User5 ${suffix}`,
        email: `sc5-${suffix}@via.test`,
        passwordHash: await bcrypt.hash("test-password-123", 10),
      },
    })
    const org = await prisma.organization.create({ data: { name: `LocOrd ${suffix}` } })
    const store = await prisma.store.create({ data: { name: `SLocOrd ${suffix}`, organizationId: org.id } })
    const locLater = await prisma.location.create({
      data: { name: `LLoc ${suffix}`, storeId: store.id, createdAt: new Date("2024-12-01T00:00:00.000Z") },
    })
    const locEarlier = await prisma.location.create({
      data: { name: `ELoc ${suffix}`, storeId: store.id, createdAt: new Date("2024-01-01T00:00:00.000Z") },
    })
    await prisma.membership.create({
      data: { userId: user.id, organizationId: org.id, role: "OWNER", allowedLocationIds: [] },
    })
    const session = await prisma.session.create({
      data: {
        token: `sc5-token-${suffix}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })
    const ctx = await resolveSessionContext(session.token)
    expect(ctx).not.toBeNull()
    expect(ctx?.locationId).toBe(locEarlier.id)
    expect(ctx?.accessibleLocationIds[0]).toBe(locEarlier.id)
    expect(ctx?.accessibleLocationIds[1]).toBe(locLater.id)
    const fx = await createSessionContextFixture({ locationCount: 2 })
    const ctx1 = await resolveSessionContext(fx.sessionToken)
    const ctx2 = await resolveSessionContext(fx.sessionToken)
    expect(ctx1?.locationId).toBe(ctx2?.locationId)
    expect(ctx1?.accessibleLocationIds).toEqual(ctx2?.accessibleLocationIds)
  })

  it("14. returns null when no eligible memberships", async () => {
    const fx = await createSessionContextFixture()
    await prisma.membership.delete({ where: { id: fx.membershipId } })
    const ctx = await resolveSessionContext(fx.sessionToken)
    expect(ctx).toBeNull()
  })
})

describe("pickInitialActiveOrganization (M2-01)", () => {
  it("15. picks first eligible in deterministic order", () => {
    const now = new Date()
    const memberships = [
      {
        id: "m2",
        organizationId: "org2",
        allowedLocationIds: [],
        organization: {
          archivedAt: null,
          createdAt: new Date(now.getTime() + 100000),
          stores: [{ locations: [{ id: "l2", archivedAt: null }] }],
        },
      },
      {
        id: "m1",
        organizationId: "org1",
        allowedLocationIds: [],
        organization: {
          archivedAt: null,
          createdAt: new Date(now.getTime() - 100000),
          stores: [{ locations: [{ id: "l1", archivedAt: null }] }],
        },
      },
    ]
    expect(pickInitialActiveOrganization(memberships)).toBe("org1")
  })

  it("15b. returns null if none eligible", () => {
    const memberships = [
      {
        id: "m1",
        organizationId: "org1",
        allowedLocationIds: [],
        organization: {
          archivedAt: new Date(),
          createdAt: new Date(),
          stores: [{ locations: [{ id: "l1", archivedAt: null }] }],
        },
      },
    ]
    expect(pickInitialActiveOrganization(memberships as never)).toBeNull()
  })
})

describe("isMembershipEligible (M2-01)", () => {
  it("16. eligible when org active and has active locations", () => {
    expect(
      isMembershipEligible({
        allowedLocationIds: [],
        organization: {
          archivedAt: null,
          stores: [{ locations: [{ id: "l1", archivedAt: null }] }],
        },
      })
    ).toBe(true)
  })

  it("16b. ineligible when org archived", () => {
    expect(
      isMembershipEligible({
        allowedLocationIds: [],
        organization: {
          archivedAt: new Date(),
          stores: [{ locations: [{ id: "l1", archivedAt: null }] }],
        },
      })
    ).toBe(false)
  })

  it("16c. respects allowedLocationIds and archived locations", () => {
    expect(
      isMembershipEligible({
        allowedLocationIds: ["l2"],
        organization: {
          archivedAt: null,
          stores: [{ locations: [{ id: "l1", archivedAt: null }, { id: "l2", archivedAt: new Date() }] }],
        },
      })
    ).toBe(false)
  })
})
