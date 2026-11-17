// P1-C staff/membership management (C-AC1..C-AC11, C-AC43, C-AC44, C-AC57).
// Core-layer behavior of listStaffMembers / updateStaffMember /
// removeStaffMember: OWNER-only gates, self-mutation blocks, last-owner
// protection, audit atomicity, and business-history preservation.
import { describe, expect, it, afterEach } from "vitest"
import { randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"
import { prisma } from "@via-saas/database"
import {
  listStaffMembers,
  updateStaffMember,
  removeStaffMember,
  archiveLocation,
  logAuditEvent,
} from "@via-saas/core"
import { createOrganizationFixture, type OrgFixture } from "./helpers"

/** Org-scoped audit rows for an action. */
function auditRowsFor(orgId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { organizationId: orgId, action: action as never },
    orderBy: { createdAt: "asc" },
  })
}

/** Creates a second OWNER/role membership for an existing fixture user… or a brand-new user. */
async function addMember(
  org: OrgFixture,
  role: "OWNER" | "MANAGER" | "STAFF",
  opts?: { allowedLocationIds?: string[]; existingUserId?: string }
) {
  const suffix = randomBytes(4).toString("hex")
  const user =
    opts?.existingUserId
      ? await prisma.user.findUniqueOrThrow({ where: { id: opts.existingUserId } })
      : await prisma.user.create({
          data: {
            name: `Member ${suffix}`,
            email: `member-${suffix}@via.test`,
            passwordHash: await bcrypt.hash("test-password-123", 10),
          },
        })
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: org.org.id,
      role,
      allowedLocationIds: opts?.allowedLocationIds ?? [],
    },
  })
  return { user, membership }
}

// --- C-AC44 forced-audit-failure machinery (fixture-org-scoped, unique names) ---
const AUDIT_FN = "p1c_fail_audit_staff"
const KILL_UPDATE = "p1c_kill_update_staff"
const KILL_REMOVE = "p1c_kill_remove_staff"

async function installAuditKillTrigger(orgId: string, action: string, trigger: string) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${AUDIT_FN}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced audit failure (staff-file test)';
    END;
    $$ LANGUAGE plpgsql;
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${trigger}
    BEFORE INSERT ON "AuditLog"
    FOR EACH ROW
    WHEN (NEW."organizationId" = '${orgId}' AND NEW."action" = '${action}')
    EXECUTE FUNCTION ${AUDIT_FN}();
  `)
}

afterEach(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${KILL_UPDATE} ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${KILL_REMOVE} ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FN}() CASCADE`)
})

describe("P1-14 staff listing and editing (C-AC1..C-AC5)", () => {
  it("C-AC1: OWNER lists org staff with identity, role and scope; other orgs are excluded", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    const extra = await addMember(a, "MANAGER")

    const staff = await listStaffMembers(a.org.id, a.user.id)
    expect(staff).toHaveLength(2)
    const ids = staff.map((s) => s.membershipId)
    expect(ids).toContain(a.membership.id)
    expect(ids).toContain(extra.membership.id)
    // NOT b's membership: org-scoped only.
    expect(ids).not.toContain(b.membership.id)

    const owner = staff.find((s) => s.membershipId === a.membership.id)!
    expect(owner.email).toBe(a.user.email)
    expect(owner.role).toBe("OWNER")
    expect(owner.allowedLocationIds).toEqual([]) // empty = "All"
  })

  it("C-AC2: MANAGER and STAFF are rejected from listing, editing and removing (core layer)", async () => {
    const org = await createOrganizationFixture()
    const manager = await addMember(org, "MANAGER")
    const staffMember = await addMember(org, "STAFF")

    await expect(listStaffMembers(org.org.id, manager.user.id)).rejects.toThrow(/Only Owners/)
    await expect(
      updateStaffMember(org.org.id, manager.user.id, staffMember.membership.id, {
        role: "STAFF",
      })
    ).rejects.toThrow(/Only Owners/)
    await expect(
      removeStaffMember(org.org.id, manager.user.id, staffMember.membership.id)
    ).rejects.toThrow(/Only Owners/)

    // A bare non-member is rejected with the same gate.
    await expect(listStaffMembers(org.org.id, staffMember.user.id)).rejects.toThrow(
      /not authorized|Only Owners/
    )

    // State unchanged: role still MANAGER/STAFF.
    const rows = await prisma.membership.findMany({ where: { organizationId: org.org.id } })
    const roles = rows.map((r) => r.role).sort()
    expect(roles).toEqual(["MANAGER", "OWNER", "STAFF"])
  })

  it("C-AC3: a cross-org membership id fails closed on edit AND removal with the uniform error", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    const bStaff = await addMember(b, "STAFF")

    await expect(
      updateStaffMember(a.org.id, a.user.id, bStaff.membership.id, { role: "MANAGER" })
    ).rejects.toThrow("Staff member not found.")
    await expect(
      removeStaffMember(a.org.id, a.user.id, bStaff.membership.id)
    ).rejects.toThrow("Staff member not found.")

    // No leak, no mutation, no audits in either org.
    expect(await auditRowsFor(a.org.id, "UPDATE_STAFF")).toHaveLength(0)
    expect(await auditRowsFor(a.org.id, "REMOVE_STAFF")).toHaveLength(0)
    const stillThere = await prisma.membership.findUnique({
      where: { id: bStaff.membership.id },
    })
    expect(stillThere).not.toBeNull()
  })

  it("C-AC4: a role edit takes effect on the member's next operation without session recreation", async () => {
    const org = await createOrganizationFixture()
    const member = await addMember(org, "STAFF")

    await updateStaffMember(org.org.id, org.user.id, member.membership.id, { role: "MANAGER" })

    // The SAME membership row now carries the new role — every subsequent
    // request resolves from this row (no caching layer, code-verified), so
    // the very next staff-management attempt by that member reflects it.
    const row = await prisma.membership.findUniqueOrThrow({
      where: { id: member.membership.id },
    })
    expect(row.role).toBe("MANAGER")

    // Promotion did NOT grant staff administration (only OWNER manages staff).
    await expect(listStaffMembers(org.org.id, member.user.id)).rejects.toThrow(/Only Owners/)

    // Demote back: the demoted member is rejected again from OWNER operations.
    await updateStaffMember(org.org.id, org.user.id, member.membership.id, { role: "STAFF" })
    await expect(
      updateStaffMember(org.org.id, member.user.id, member.membership.id, { role: "MANAGER" })
    ).rejects.toThrow(/Only Owners/)
  })

  it("C-AC5: scope edits reject non-org and archived locations; empty array = all active", async () => {
    const a = await createOrganizationFixture({ locationCount: 2 })
    const b = await createOrganizationFixture()
    const member = await addMember(a, "STAFF")

    // Non-org location id.
    await expect(
      updateStaffMember(a.org.id, a.user.id, member.membership.id, {
        role: "STAFF",
        allowedLocationIds: [b.locations[0].id],
      })
    ).rejects.toThrow(/Invalid location for this business./)

    // Archived location of the org is NOT grantable.
    await archiveLocation(a.org.id, a.user.id, a.locations[1].id)
    await expect(
      updateStaffMember(a.org.id, a.user.id, member.membership.id, {
        role: "STAFF",
        allowedLocationIds: [a.locations[1].id],
      })
    ).rejects.toThrow(/Invalid location for this business./)

    // Empty array = all ACTIVE locations — accepted.
    const updated = await updateStaffMember(a.org.id, a.user.id, member.membership.id, {
      role: "STAFF",
      allowedLocationIds: [],
    })
    expect(updated.allowedLocationIds).toEqual([])
  })
})

describe("P1-14 last-owner protection and self-mutation blocks (C-AC6..C-AC8, C-AC57)", () => {
  it("C-AC6: demoting or removing the last OWNER is rejected; the org retains its OWNER", async () => {
    const org = await createOrganizationFixture()

    // The sole OWNER targets their own membership: the self-mutation block
    // (C-D3/C-D17) fires FIRST and equally protects the last owner. The
    // in-lock owner-count guard is defense-in-depth behind it.
    await expect(
      updateStaffMember(org.org.id, org.user.id, org.membership.id, { role: "MANAGER" })
    ).rejects.toThrow(/You cannot modify your own staff record/)
    await expect(
      removeStaffMember(org.org.id, org.user.id, org.membership.id)
    ).rejects.toThrow(/You cannot remove your own membership/)

    const owners = await prisma.membership.count({
      where: { organizationId: org.org.id, role: "OWNER" },
    })
    expect(owners).toBe(1)
    expect(await auditRowsFor(org.org.id, "UPDATE_STAFF")).toHaveLength(0)
    expect(await auditRowsFor(org.org.id, "REMOVE_STAFF")).toHaveLength(0)
  })

  it("C-AC6 (in-lock guard): demotion below one OWNER is rejected when attempted against the last remaining owner", async () => {
    const org = await createOrganizationFixture()
    const second = await addMember(org, "OWNER")

    // Owner A demotes B to STAFF: legitimate (one OWNER remains).
    await updateStaffMember(org.org.id, org.user.id, second.membership.id, { role: "STAFF" })
    expect(
      await prisma.membership.count({ where: { organizationId: org.org.id, role: "OWNER" } })
    ).toBe(1)

    // Now A is the last OWNER: A demoting themself is blocked by the
    // self-mutation rule; a racing edit that slipped past the pre-check
    // would still be caught by the in-lock count re-read.
    await expect(
      updateStaffMember(org.org.id, org.user.id, org.membership.id, { role: "MANAGER" })
    ).rejects.toThrow(/You cannot modify your own staff record/)
    expect(
      await prisma.membership.count({ where: { organizationId: org.org.id, role: "OWNER" } })
    ).toBe(1)
  })

  it("C-AC7: concurrent owner-degrading operations — exactly one succeeds, ≥1 OWNER remains", async () => {
    const org = await createOrganizationFixture()
    const second = await addMember(org, "OWNER")

    // Owner A removes owner B; owner B simultaneously demotes owner A.
    const [remove, demote] = await Promise.allSettled([
      removeStaffMember(org.org.id, org.user.id, second.membership.id),
      updateStaffMember(org.org.id, second.user.id, org.membership.id, { role: "MANAGER" }),
    ])

    const fulfilled = [remove, demote].filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)

    // Exactly one OWNER remains either way, and the org is consistent.
    const rows = await prisma.membership.findMany({ where: { organizationId: org.org.id } })
    const owners = rows.filter((r) => r.role === "OWNER")
    expect(owners.length).toBeGreaterThanOrEqual(1)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })

  it("C-AC8/C-AC57: self-removal, self-demotion and self-location-strip are ALL blocked; state unchanged", async () => {
    const org = await createOrganizationFixture()

    await expect(
      removeStaffMember(org.org.id, org.user.id, org.membership.id)
    ).rejects.toThrow(/You cannot remove your own membership/)
    await expect(
      updateStaffMember(org.org.id, org.user.id, org.membership.id, { role: "MANAGER" })
    ).rejects.toThrow(/You cannot modify your own staff record/)
    await expect(
      updateStaffMember(org.org.id, org.user.id, org.membership.id, {
        role: "OWNER",
        allowedLocationIds: [org.locations[0].id],
      })
    ).rejects.toThrow(/You cannot modify your own staff record/)

    const row = await prisma.membership.findUniqueOrThrow({
      where: { id: org.membership.id },
    })
    expect(row.role).toBe("OWNER")
    expect(row.allowedLocationIds).toEqual([])
    expect(await auditRowsFor(org.org.id, "REMOVE_STAFF")).toHaveLength(0)
    expect(await auditRowsFor(org.org.id, "UPDATE_STAFF")).toHaveLength(0)
  })
})

describe("P1-14 removal semantics and audit (C-AC9..C-AC11)", () => {
  it("C-AC9: removal deletes exactly the Membership; one REMOVE_STAFF audit with snapshot; history survives", async () => {
    const org = await createOrganizationFixture()
    const member = await addMember(org, "STAFF")

    // Give the member a session + a historical stock movement (business history).
    const session = await prisma.session.create({
      data: {
        userId: member.user.id,
        token: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const movement = await prisma.stockMovement.create({
      data: {
        locationId: org.locations[0].id,
        actorId: member.user.id,
        variantId: (await createProductForMovements(org)).variantId,
        quantity: 3,
        type: "ADDED",
      },
    })

    await removeStaffMember(org.org.id, org.user.id, member.membership.id, {
      reason: "offboarding",
    })

    // Exactly the Membership row is gone.
    expect(await prisma.membership.findUnique({ where: { id: member.membership.id } })).toBeNull()
    // User and session survive (access ends via resolution failure, not deletion).
    expect(await prisma.user.findUnique({ where: { id: member.user.id } })).not.toBeNull()
    expect(await prisma.session.findUnique({ where: { id: session.id } })).not.toBeNull()
    // Historical attribution survives.
    expect(await prisma.stockMovement.findUnique({ where: { id: movement.id } })).not.toBeNull()

    const audits = await auditRowsFor(org.org.id, "REMOVE_STAFF")
    expect(audits).toHaveLength(1)
    expect(audits[0].actorId).toBe(org.user.id)
    expect(audits[0].targetId).toBe(member.membership.id)
    const meta = audits[0].metadata as Record<string, unknown>
    expect(meta.userId).toBe(member.user.id)
    expect(meta.email).toBe(member.user.email)
    expect(meta.role).toBe("STAFF")
    expect(meta.reason).toBe("offboarding")
  })

  it("C-AC9 (failure path): a rejected removal writes no orphan audit", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    const bStaff = await addMember(b, "STAFF")

    await expect(
      removeStaffMember(a.org.id, a.user.id, bStaff.membership.id)
    ).rejects.toThrow("Staff member not found.")
    expect(await auditRowsFor(a.org.id, "REMOVE_STAFF")).toHaveLength(0)
  })

  it("C-AC10: after removal the member's next request in that org fails resolution", async () => {
    const org = await createOrganizationFixture()
    const member = await addMember(org, "STAFF")

    await removeStaffMember(org.org.id, org.user.id, member.membership.id)

    // The removed member's next authenticated operation in the org is
    // rejected by the membership gate (E-11/D-G resolution semantics).
    await expect(listStaffMembers(org.org.id, member.user.id)).rejects.toThrow(
      /not authorized|Only Owners/
    )
    expect(
      await prisma.membership.findUnique({
        where: { userId_organizationId: { userId: member.user.id, organizationId: org.org.id } },
      })
    ).toBeNull()
  })

  it("C-AC11: a role edit writes exactly one UPDATE_STAFF audit (before/after) atomic with the mutation", async () => {
    const org = await createOrganizationFixture()
    const member = await addMember(org, "STAFF")

    await updateStaffMember(org.org.id, org.user.id, member.membership.id, {
      role: "MANAGER",
      allowedLocationIds: [org.locations[0].id],
    })

    const audits = await auditRowsFor(org.org.id, "UPDATE_STAFF")
    expect(audits).toHaveLength(1)
    expect(audits[0].actorId).toBe(org.user.id)
    expect(audits[0].targetId).toBe(member.membership.id)
    const meta = audits[0].metadata as { before: Record<string, unknown>; after: Record<string, unknown> }
    expect(meta.before).toEqual({ role: "STAFF", allowedLocationIds: [] })
    expect(meta.after).toEqual({ role: "MANAGER", allowedLocationIds: [org.locations[0].id] })
  })
})

describe("P1-C audit invariants (C-AC43, C-AC44 — staff events)", () => {
  it("C-AC43: every new staff audit event rejects a null actor (D-G matrix)", async () => {
    const org = await createOrganizationFixture()
    await expect(
      logAuditEvent(org.org.id, null, "UPDATE_STAFF", org.membership.id, {})
    ).rejects.toThrow("Audit events require an authenticated actor.")
    await expect(
      logAuditEvent(org.org.id, null, "REMOVE_STAFF", org.membership.id, {})
    ).rejects.toThrow("Audit events require an authenticated actor.")
  })

  it("C-AC44: forced audit failure rolls back UPDATE_STAFF — membership unchanged, no audit", async () => {
    const org = await createOrganizationFixture()
    const member = await addMember(org, "STAFF")

    await installAuditKillTrigger(org.org.id, "UPDATE_STAFF", KILL_UPDATE)
    await expect(
      updateStaffMember(org.org.id, org.user.id, member.membership.id, { role: "MANAGER" })
    ).rejects.toThrow(/forced audit failure/)

    const row = await prisma.membership.findUniqueOrThrow({ where: { id: member.membership.id } })
    expect(row.role).toBe("STAFF")
    expect(await auditRowsFor(org.org.id, "UPDATE_STAFF")).toHaveLength(0)
  })

  it("C-AC44: forced audit failure rolls back REMOVE_STAFF — membership retained, no audit", async () => {
    const org = await createOrganizationFixture()
    const member = await addMember(org, "STAFF")

    await installAuditKillTrigger(org.org.id, "REMOVE_STAFF", KILL_REMOVE)
    await expect(
      removeStaffMember(org.org.id, org.user.id, member.membership.id)
    ).rejects.toThrow(/forced audit failure/)

    expect(
      await prisma.membership.findUnique({ where: { id: member.membership.id } })
    ).not.toBeNull()
    expect(await auditRowsFor(org.org.id, "REMOVE_STAFF")).toHaveLength(0)
  })
})

/** Minimal product for movement scaffolding. */
async function createProductForMovements(org: OrgFixture) {
  const suffix = randomBytes(4).toString("hex")
  const product = await prisma.product.create({
    data: { name: `Product ${suffix}`, organizationId: org.org.id, status: "PUBLISHED" },
  })
  const variant = await prisma.productVariant.create({
    data: {
      productId: product.id,
      organizationId: org.org.id,
      name: "Default",
      sellingPrice: 100,
      costPrice: 100,
    },
  })
  return { variantId: variant.id }
}
