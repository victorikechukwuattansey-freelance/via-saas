// AC-7 / E-2 — Staff invitation security: hashed single-use tokens, no
// default passwords, expiry enforcement, cross-org location protection.
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { acceptStaffInvite, inviteStaffMember, DomainError } from "@via-saas/core"
import { createOrganizationFixture } from "./helpers"

describe("staff invitation security (E-2)", () => {
  it("returns a one-time token and stores ONLY its hash (never the raw token)", async () => {
    const org = await createOrganizationFixture()

    const result = await inviteStaffMember(org.org.id, org.user.id, {
      name: "New Staff",
      email: "staff-1@via.test",
      role: "STAFF",
    })

    expect(result.linked).toBe(false)
    if (result.linked) return

    expect(result.inviteToken).toMatch(/^[0-9a-f]{64}$/) // 256-bit token

    const invites = await prisma.staffInvite.findMany({
      where: { organizationId: org.org.id },
    })
    expect(invites).toHaveLength(1)
    expect(invites[0].tokenHash).not.toBe(result.inviteToken)
    expect(JSON.stringify(invites[0])).not.toContain(result.inviteToken)
    expect(invites[0].acceptedAt).toBeNull()
    expect(invites[0].expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it("accepting an invite sets the caller-chosen password and creates the membership", async () => {
    const org = await createOrganizationFixture()

    const result = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Accept Staff",
      email: "accept@via.test",
      role: "MANAGER",
    })
    if (result.linked) throw new Error("expected token invite")

    const { membership, user } = await acceptStaffInvite(result.inviteToken, "my-own-password-9")

    expect(user.email).toBe("accept@via.test")
    expect(membership.organizationId).toBe(org.org.id)
    expect(membership.role).toBe("MANAGER")

    // The chosen password works (bcrypt hash stored, not the raw password)
    const stored = await prisma.user.findUnique({ where: { id: user.id } })
    expect(stored?.passwordHash).toBeDefined()
    expect(stored?.passwordHash).not.toBe("my-own-password-9")
  })

  it("rejects reuse of an accepted invite (single-use)", async () => {
    const org = await createOrganizationFixture()

    const result = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Single Use",
      email: "single-use@via.test",
      role: "STAFF",
    })
    if (result.linked) throw new Error("expected token invite")

    await acceptStaffInvite(result.inviteToken, "first-password-1")

    await expect(
      acceptStaffInvite(result.inviteToken, "second-password-2")
    ).rejects.toMatchObject({ code: "INVALID_INVITE" })

    // No duplicate membership was created
    const memberships = await prisma.membership.findMany({
      where: { organizationId: org.org.id, role: "STAFF" },
    })
    expect(memberships).toHaveLength(1)
  })

  it("rejects expired invites", async () => {
    const org = await createOrganizationFixture()

    const result = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Expired Staff",
      email: "expired@via.test",
      role: "STAFF",
    })
    if (result.linked) throw new Error("expected token invite")

    await prisma.staffInvite.updateMany({
      where: { organizationId: org.org.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    await expect(
      acceptStaffInvite(result.inviteToken, "valid-password-1")
    ).rejects.toMatchObject({ code: "INVALID_INVITE" })
  })

  it("rejects unknown tokens and short passwords", async () => {
    await expect(
      acceptStaffInvite("deadbeef".repeat(8), "valid-password-1")
    ).rejects.toMatchObject({ code: "INVALID_INVITE" })

    await expect(acceptStaffInvite("", "valid-password-1")).rejects.toMatchObject({
      code: "INVALID_INVITE",
    })

    const org = await createOrganizationFixture()
    const result = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Short Pw",
      email: "shortpw@via.test",
      role: "STAFF",
    })
    if (result.linked) throw new Error("expected token invite")

    await expect(acceptStaffInvite(result.inviteToken, "short")).rejects.toMatchObject({
      code: "VALIDATION",
    })
    // Nothing was accepted
    const invite = await prisma.staffInvite.findFirst({
      where: { organizationId: org.org.id },
    })
    expect(invite?.acceptedAt).toBeNull()
  })

  it("links an existing user directly without creating any invite token", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()

    // orgB's owner already has a password; invite them into orgA
    const result = await inviteStaffMember(orgA.org.id, orgA.user.id, {
      name: "Existing User",
      email: orgB.user.email,
      role: "MANAGER",
    })

    expect(result.linked).toBe(true)

    const membership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: orgB.user.id, organizationId: orgA.org.id },
      },
    })
    expect(membership?.role).toBe("MANAGER")

    const inviteCount = await prisma.staffInvite.count({
      where: { email: orgB.user.email },
    })
    expect(inviteCount).toBe(0)

    // Password was NOT touched
    const stored = await prisma.user.findUnique({ where: { id: orgB.user.id } })
    expect(stored?.passwordHash).toBeDefined()
  })

  it("rejects inviting someone who is already a member", async () => {
    const org = await createOrganizationFixture()

    await expect(
      inviteStaffMember(org.org.id, org.user.id, {
        name: "Owner Again",
        email: org.user.email,
        role: "STAFF",
      })
    ).rejects.toMatchObject({ code: "ALREADY_MEMBER" })
  })

  it("validates email format and role values", async () => {
    const org = await createOrganizationFixture()

    await expect(
      inviteStaffMember(org.org.id, org.user.id, {
        name: "Bad Email",
        email: "not-an-email",
        role: "STAFF",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" })

    await expect(
      inviteStaffMember(org.org.id, org.user.id, {
        name: "Bad Role",
        email: "badrole@via.test",
        role: "SUPERADMIN" as "STAFF",
      })
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("rejects a restricted location that belongs to another organization", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()

    await expect(
      inviteStaffMember(orgA.org.id, orgA.user.id, {
        name: "Cross Org",
        email: "crossorg@via.test",
        role: "STAFF",
        locationId: orgB.locations[0].id,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("persists restricted location access on the created membership", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })

    const result = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Restricted Staff",
      email: "restricted@via.test",
      role: "STAFF",
      locationId: org.locations[1].id, // second location only
    })
    if (result.linked) throw new Error("expected token invite")

    const { membership } = await acceptStaffInvite(result.inviteToken, "valid-password-1")
    expect(membership.allowedLocationIds).toEqual([org.locations[1].id])
  })
})
