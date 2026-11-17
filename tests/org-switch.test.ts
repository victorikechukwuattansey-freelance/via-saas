// P1-C organization switching (C-AC31..C-AC42 subset, C-AC44, C-AC55, C-AC58).
// Session-context resolution semantics (active-org preference, eligible-first
// fallback, staleness, ineligibility) and the switch core: authorization,
// conditional session update, SWITCH_ORG audit atomicity, expiry handling.
//
// C-AC39 (revalidatePath) and the login action's cookie write are Next-layer
// glue verified by code inspection; C-AC32's deterministic selection logic is
// unit-tested here through pickInitialActiveOrganization.
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest"
import { randomBytes } from "node:crypto"
import { prisma } from "@via-saas/database"
import { archiveLocation, removeStaffMember } from "@via-saas/core"
import { performOrganizationSwitch } from "../apps/merchant-dashboard/lib/organization"
import {
  getSessionContext,
  pickInitialActiveOrganization,
  listEligibleOrganizations,
} from "../apps/merchant-dashboard/lib/auth-helpers"
import { createOrganizationFixture, type OrgFixture } from "./helpers"

// The resolution helper reads the session cookie — supply it via a hoisted mock.
const cookieMock = vi.hoisted(() => ({ token: null as string | null }))
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (key: string) =>
      key === "session_token" && cookieMock.token ? { value: cookieMock.token } : undefined,
    set: () => {},
    delete: () => {},
  }),
}))

beforeEach(() => {
  cookieMock.token = null
})

async function createSession(userId: string, expiresAt?: Date) {
  const token = randomBytes(16).toString("hex")
  await prisma.session.create({
    data: {
      userId,
      token,
      expiresAt: expiresAt ?? new Date(Date.now() + 3_600_000),
    },
  })
  return token
}

/** Adds userId as an OWNER of another org (multi-org user scaffolding). */
async function addCrossMembership(org: OrgFixture, userId: string, role: "OWNER" | "STAFF" = "OWNER") {
  return prisma.membership.create({
    data: { userId, organizationId: org.org.id, role, allowedLocationIds: [] },
  })
}

/** Forces distinct deterministic createdAt values on two orgs. */
async function orderOrgs(first: OrgFixture, second: OrgFixture) {
  await prisma.organization.update({
    where: { id: first.org.id },
    data: { createdAt: new Date(Date.now() - 60_000) },
  })
  await prisma.organization.update({
    where: { id: second.org.id },
    data: { createdAt: new Date() },
  })
}

function auditRowsFor(orgId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { organizationId: orgId, action: action as never },
    orderBy: { createdAt: "asc" },
  })
}

// --- C-AC44 forced-audit-failure machinery (fixture-org-scoped, unique names) ---
const AUDIT_FN = "p1c_fail_audit_switch"
const KILL_SWITCH = "p1c_kill_switch_org"

async function installAuditKillTrigger(orgId: string) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${AUDIT_FN}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced audit failure (switch-file test)';
    END;
    $$ LANGUAGE plpgsql;
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${KILL_SWITCH}
    BEFORE INSERT ON "AuditLog"
    FOR EACH ROW
    WHEN (NEW."organizationId" = '${orgId}' AND NEW."action" = 'SWITCH_ORG')
    EXECUTE FUNCTION ${AUDIT_FN}();
  `)
}

afterEach(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${KILL_SWITCH} ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FN}() CASCADE`)
})

describe("P1-17 resolution semantics (C-AC31, C-AC36, C-AC55)", () => {
  it("C-AC31: a legacy session (null activeOrganizationId) resolves exactly as before — via the fallback", async () => {
    const org = await createOrganizationFixture()
    const token = await createSession(org.user.id)
    cookieMock.token = token

    const context = await getSessionContext()
    expect(context).not.toBeNull()
    expect(context!.orgId).toBe(org.org.id)
    expect(context!.role).toBe("OWNER")
    expect(context!.locationId).toBe(org.locations[0].id)

    const session = await prisma.session.findUniqueOrThrow({ where: { token } })
    expect(session.activeOrganizationId).toBeNull() // resolution never rewrites the row
  })

  it("C-AC36: a stale activeOrganizationId never blocks resolution — deterministic eligible-first fallback", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await orderOrgs(a, b)
    await addCrossMembership(b, a.user.id)

    const token = await createSession(a.user.id)
    await prisma.session.update({
      where: { token },
      data: { activeOrganizationId: "org-that-no-longer-exists" },
    })
    cookieMock.token = token

    const context = await getSessionContext()
    expect(context).not.toBeNull()
    expect(context!.orgId).toBe(a.org.id) // earlier-created eligible org
  })

  it("C-AC55: eligible-first fallback — [A-inaccessible, B-eligible] resolves to B, never null", async () => {
    const a = await createOrganizationFixture({ locationCount: 2 })
    const b = await createOrganizationFixture()
    await orderOrgs(a, b)
    await addCrossMembership(b, a.user.id)

    // A's membership is INACCESSIBLE: restricted to a location, then archived
    // (one of two — the last-active guard does not fire).
    await prisma.membership.update({
      where: { id: a.membership.id },
      data: { allowedLocationIds: [a.locations[1].id] },
    })
    await archiveLocation(a.org.id, a.user.id, a.locations[1].id)

    const token = await createSession(a.user.id)
    cookieMock.token = token

    const context = await getSessionContext()
    expect(context).not.toBeNull()
    expect(context!.orgId).toBe(b.org.id)
  })

  it("C-AC55: zero eligible memberships → null context (not an error)", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })

    // Restrict the membership to one location, then archive it (one of two):
    // the restricted expansion yields ZERO accessible locations → ineligible,
    // even though the org still has an active location outside the scope.
    await prisma.membership.update({
      where: { id: org.membership.id },
      data: { allowedLocationIds: [org.locations[1].id] },
    })
    await archiveLocation(org.org.id, org.user.id, org.locations[1].id)

    const token = await createSession(org.user.id)
    cookieMock.token = token

    expect(await getSessionContext()).toBeNull()
  })

  it("C-AC38: an unknown/tampered token resolves to nothing (cookie only selects the session row)", async () => {
    cookieMock.token = "tampered-token-value"
    expect(await getSessionContext()).toBeNull()
  })
})

describe("P1-17 deterministic initial selection (C-AC32, C-AC55)", () => {
  it("pickInitialActiveOrganization orders by organization.createdAt then membership.id, eligible-first", async () => {
    const a = await createOrganizationFixture({ locationCount: 2 })
    const b = await createOrganizationFixture({ locationCount: 2 })
    await orderOrgs(a, b)
    await addCrossMembership(b, a.user.id)

    const memberships = await prisma.membership.findMany({
      where: { userId: a.user.id },
      include: { organization: { include: { stores: { include: { locations: true } } } } },
    })

    expect(pickInitialActiveOrganization(memberships)).toBe(a.org.id)

    // A becomes ineligible (its restricted scope is archived) → B is selected.
    await prisma.membership.update({
      where: { id: a.membership.id },
      data: { allowedLocationIds: [a.locations[1].id] },
    })
    await archiveLocation(a.org.id, a.user.id, a.locations[1].id)
    const refreshed = await prisma.membership.findMany({
      where: { userId: a.user.id },
      include: { organization: { include: { stores: { include: { locations: true } } } } },
    })
    expect(pickInitialActiveOrganization(refreshed)).toBe(b.org.id)

    // No eligible membership → null (b's memberships are restricted to their
    // own archived location too).
    await prisma.membership.updateMany({
      where: { organizationId: b.org.id },
      data: { allowedLocationIds: [b.locations[1].id] },
    })
    await archiveLocation(b.org.id, b.user.id, b.locations[1].id)
    const noneEligible = await prisma.membership.findMany({
      where: { userId: a.user.id },
      include: { organization: { include: { stores: { include: { locations: true } } } } },
    })
    expect(pickInitialActiveOrganization(noneEligible)).toBeNull()
  })

  it("listEligibleOrganizations returns only eligible orgs in deterministic order", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await orderOrgs(a, b)
    await addCrossMembership(b, a.user.id)

    const eligible = await listEligibleOrganizations(a.user.id)
    expect(eligible.map((o) => o.organizationId)).toEqual([a.org.id, b.org.id])
  })
})

describe("P1-17 switch authorization and effects (C-AC33, C-AC34, C-AC35, C-AC40)", () => {
  it("C-AC33: a valid switch resolves the context to the chosen org on the next request", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await orderOrgs(a, b)
    await addCrossMembership(b, a.user.id)

    const token = await createSession(a.user.id)
    cookieMock.token = token
    const before = await getSessionContext()
    expect(before!.orgId).toBe(a.org.id)

    await performOrganizationSwitch({
      token,
      userId: a.user.id,
      fromOrganizationId: before!.orgId,
      targetOrganizationId: b.org.id,
    })

    const after = await getSessionContext()
    expect(after!.orgId).toBe(b.org.id)
    expect(after!.locationId).toBe(b.locations[0].id)
    expect(after!.role).toBe("OWNER")
  })

  it("C-AC34: switching to an org the user does not belong to is rejected — NO state change, NO audit", async () => {
    const a = await createOrganizationFixture()
    const stranger = await createOrganizationFixture()

    const token = await createSession(a.user.id)
    await prisma.session.update({
      where: { token },
      data: { activeOrganizationId: a.org.id },
    })

    await expect(
      performOrganizationSwitch({
        token,
        userId: a.user.id,
        fromOrganizationId: a.org.id,
        targetOrganizationId: stranger.org.id,
      })
    ).rejects.toThrow(/You do not have access to that organization/)

    const session = await prisma.session.findUniqueOrThrow({ where: { token } })
    expect(session.activeOrganizationId).toBe(a.org.id) // unchanged
    expect(await auditRowsFor(stranger.org.id, "SWITCH_ORG")).toHaveLength(0)
    expect(await auditRowsFor(a.org.id, "SWITCH_ORG")).toHaveLength(0)
  })

  it("C-AC34 (ineligible target): an org with no accessible active location is rejected identically", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture({ locationCount: 2 })
    // The cross-membership is restricted to a location that is then archived
    // (one of two): the target org holds a membership but it is INELIGIBLE.
    const cross = await prisma.membership.create({
      data: {
        userId: a.user.id,
        organizationId: b.org.id,
        role: "OWNER",
        allowedLocationIds: [b.locations[1].id],
      },
    })
    void cross
    await archiveLocation(b.org.id, b.user.id, b.locations[1].id)

    const token = await createSession(a.user.id)
    await expect(
      performOrganizationSwitch({
        token,
        userId: a.user.id,
        fromOrganizationId: a.org.id,
        targetOrganizationId: b.org.id,
      })
    ).rejects.toThrow(/You do not have access to that organization/)
    expect(
      (await prisma.session.findUniqueOrThrow({ where: { token } })).activeOrganizationId
    ).toBeNull()
  })

  it("C-AC35: membership removed after switching — the next request falls back; removed org data is inaccessible", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await orderOrgs(a, b)
    const cross = await addCrossMembership(b, a.user.id)

    const token = await createSession(a.user.id)
    cookieMock.token = token
    await performOrganizationSwitch({
      token,
      userId: a.user.id,
      fromOrganizationId: a.org.id,
      targetOrganizationId: b.org.id,
    })
    expect((await getSessionContext())!.orgId).toBe(b.org.id)

    // Remove the b-membership (owner of b removes our cross membership).
    await removeStaffMember(b.org.id, b.user.id, cross.id)

    // The active org is now stale → resolution falls back to the remaining
    // eligible org (a). The removed org's data is no longer reachable.
    const context = await getSessionContext()
    expect(context).not.toBeNull()
    expect(context!.orgId).toBe(a.org.id)
  })

  it("C-AC40: switching does not extend or renew session expiry; an expired session cannot switch", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await addCrossMembership(b, a.user.id)

    const token = await createSession(a.user.id)
    const before = await prisma.session.findUniqueOrThrow({ where: { token } })

    await performOrganizationSwitch({
      token,
      userId: a.user.id,
      fromOrganizationId: a.org.id,
      targetOrganizationId: b.org.id,
    })
    const after = await prisma.session.findUniqueOrThrow({ where: { token } })
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime())
    expect(after.token).toBe(before.token) // no token rotation (C-D14)

    // An expired session is rejected outright (conditional update, no resurrect).
    const expired = await createSession(a.user.id, new Date(Date.now() - 1000))
    await expect(
      performOrganizationSwitch({
        token: expired,
        userId: a.user.id,
        fromOrganizationId: a.org.id,
        targetOrganizationId: b.org.id,
      })
    ).rejects.toThrow(/session has expired/i)
    expect(
      (await prisma.session.findUniqueOrThrow({ where: { token: expired } }))
        .activeOrganizationId
    ).toBeNull()
  })
})

describe("P1-17 switch audit (C-AC58) and atomicity (C-AC37, C-AC44)", () => {
  it("C-AC58: a successful switch writes exactly one SWITCH_ORG audit in the TARGET org with from/to metadata", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await orderOrgs(a, b)
    await addCrossMembership(b, a.user.id)

    const token = await createSession(a.user.id)
    cookieMock.token = token

    // from = the EFFECTIVE session organization resolved under §10.2.
    const context = await getSessionContext()
    expect(context!.orgId).toBe(a.org.id)

    await performOrganizationSwitch({
      token,
      userId: a.user.id,
      fromOrganizationId: context!.orgId,
      targetOrganizationId: b.org.id,
    })

    const auditsInTarget = await auditRowsFor(b.org.id, "SWITCH_ORG")
    expect(auditsInTarget).toHaveLength(1)
    expect(auditsInTarget[0].actorId).toBe(a.user.id)
    expect(auditsInTarget[0].targetId).toBe(b.org.id)
    const meta = auditsInTarget[0].metadata as Record<string, unknown>
    expect(meta.fromOrganizationId).toBe(a.org.id)
    expect(meta.toOrganizationId).toBe(b.org.id)

    // Nothing was written into the source org's audit stream.
    expect(await auditRowsFor(a.org.id, "SWITCH_ORG")).toHaveLength(0)
  })

  it("C-AC58 (effective, not raw): a legacy session's from = the fallback-resolved org, never the null column", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await orderOrgs(a, b)
    await addCrossMembership(b, a.user.id)

    // Legacy session: activeOrganizationId is NULL; the effective org is the
    // eligible-first fallback (a). The action derives `from` from
    // getSessionContext — NOT from the raw column.
    const token = await createSession(a.user.id)
    cookieMock.token = token
    const context = await getSessionContext()
    expect(context!.orgId).toBe(a.org.id)
    expect((await prisma.session.findUniqueOrThrow({ where: { token } })).activeOrganizationId).toBeNull()

    await performOrganizationSwitch({
      token,
      userId: a.user.id,
      fromOrganizationId: context!.orgId,
      targetOrganizationId: b.org.id,
    })

    const meta = (await auditRowsFor(b.org.id, "SWITCH_ORG"))[0].metadata as Record<string, unknown>
    expect(meta.fromOrganizationId).toBe(a.org.id)
  })

  it("C-AC58: a FAILED switch writes no audit event", async () => {
    const a = await createOrganizationFixture()
    const stranger = await createOrganizationFixture()
    const token = await createSession(a.user.id)

    await expect(
      performOrganizationSwitch({
        token,
        userId: a.user.id,
        fromOrganizationId: a.org.id,
        targetOrganizationId: stranger.org.id,
      })
    ).rejects.toThrow(/You do not have access/)

    expect(await auditRowsFor(stranger.org.id, "SWITCH_ORG")).toHaveLength(0)
    expect(await auditRowsFor(a.org.id, "SWITCH_ORG")).toHaveLength(0)
  })

  it("C-AC37: concurrent switches are atomic — the session ends wholly in one org, one audit per success", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    const c = await createOrganizationFixture()
    await addCrossMembership(b, a.user.id)
    await addCrossMembership(c, a.user.id)

    const token = await createSession(a.user.id)
    await prisma.session.update({ where: { token }, data: { activeOrganizationId: a.org.id } })

    const results = await Promise.allSettled([
      performOrganizationSwitch({
        token, userId: a.user.id,
        fromOrganizationId: a.org.id,
        targetOrganizationId: b.org.id,
      }),
      performOrganizationSwitch({
        token, userId: a.user.id,
        fromOrganizationId: a.org.id,
        targetOrganizationId: c.org.id,
      }),
    ])

    // Both switches were authorized; both commit atomically.
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(2)

    // The final state is exactly ONE of the targets — never mixed.
    const finalOrg = (await prisma.session.findUniqueOrThrow({ where: { token } }))
      .activeOrganizationId
    expect([b.org.id, c.org.id]).toContain(finalOrg)

    // Exactly one audit per successful switch (in each TARGET org).
    const bAudits = await auditRowsFor(b.org.id, "SWITCH_ORG")
    const cAudits = await auditRowsFor(c.org.id, "SWITCH_ORG")
    expect(bAudits.length + cAudits.length).toBe(2)
    for (const audit of [...bAudits, ...cAudits]) {
      expect((audit.metadata as Record<string, unknown>).fromOrganizationId).toBe(a.org.id)
    }
  })

  it("C-AC44: forced audit failure rolls back the switch — session unchanged, no audit", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await addCrossMembership(b, a.user.id)

    const token = await createSession(a.user.id)
    await prisma.session.update({ where: { token }, data: { activeOrganizationId: a.org.id } })

    await installAuditKillTrigger(b.org.id)
    await expect(
      performOrganizationSwitch({
        token,
        userId: a.user.id,
        fromOrganizationId: a.org.id,
        targetOrganizationId: b.org.id,
      })
    ).rejects.toThrow(/forced audit failure/)

    const session = await prisma.session.findUniqueOrThrow({ where: { token } })
    expect(session.activeOrganizationId).toBe(a.org.id) // rolled back
    expect(await auditRowsFor(b.org.id, "SWITCH_ORG")).toHaveLength(0)
    expect(await auditRowsFor(a.org.id, "SWITCH_ORG")).toHaveLength(0)
  })
})
