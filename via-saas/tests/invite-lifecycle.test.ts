// P1-C invitation lifecycle (C-AC12..C-AC20, C-AC43, C-AC44, C-AC51, C-AC52, C-AC61).
// Derived-state listing, rescission, supersession on BOTH reinvitation
// paths, concurrent accept/rescind settlement, normalization, and audit.
import { describe, expect, it, afterEach } from "vitest"
import { randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"
import { prisma } from "@via-saas/database"
import {
  inviteStaffMember,
  acceptStaffInvite,
  listInvitations,
  rescindInvitation,
  registerOrganization,
  logAuditEvent,
} from "@via-saas/core"
import { createOrganizationFixture, type OrgFixture } from "./helpers"

function auditRowsFor(orgId: string, action: string) {
  return prisma.auditLog.findMany({
    where: { organizationId: orgId, action: action as never },
    orderBy: { createdAt: "asc" },
  })
}

/** Creates a pre-existing user account (no membership). */
async function createUser(email: string) {
  return prisma.user.create({
    data: {
      name: `Existing ${randomBytes(2).toString("hex")}`,
      email,
      passwordHash: await bcrypt.hash("existing-password-1", 10),
    },
  })
}

/** Forces an invite row into an EXPIRED state. */
async function expireInvite(inviteId: string) {
  await prisma.staffInvite.update({
    where: { id: inviteId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  })
}

// --- C-AC44 forced-audit-failure machinery (fixture-org-scoped, unique names) ---
const AUDIT_FN = "p1c_fail_audit_invite"
const KILL_RESCIND = "p1c_kill_rescind_invite"

async function installAuditKillTrigger(orgId: string, action: string) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${AUDIT_FN}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'forced audit failure (invite-file test)';
    END;
    $$ LANGUAGE plpgsql;
  `)
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${KILL_RESCIND}
    BEFORE INSERT ON "AuditLog"
    FOR EACH ROW
    WHEN (NEW."organizationId" = '${orgId}' AND NEW."action" = '${action}')
    EXECUTE FUNCTION ${AUDIT_FN}();
  `)
}

afterEach(async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${KILL_RESCIND} ON "AuditLog"`)
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${AUDIT_FN}() CASCADE`)
})

describe("P1-15 invitation listing (C-AC12, C-AC16, C-AC19)", () => {
  it("C-AC12: OWNER lists invitations with derived states and NO token material", async () => {
    const org = await createOrganizationFixture()

    // PENDING
    const pendingEmail = `pending-${randomBytes(3).toString("hex")}@via.test`
    const pending = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Pending Person",
      email: pendingEmail,
      role: "STAFF",
    })
    if (pending.linked) throw new Error("expected token invite")

    // ACCEPTED
    const acceptedEmail = `accepted-${randomBytes(3).toString("hex")}@via.test`
    const accepted = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Accepted Person",
      email: acceptedEmail,
      role: "STAFF",
    })
    if (accepted.linked) throw new Error("expected token invite")
    await acceptStaffInvite(accepted.inviteToken, "acceptor-password-1")

    // EXPIRED
    const expiredEmail = `expired-${randomBytes(3).toString("hex")}@via.test`
    const expired = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Expired Person",
      email: expiredEmail,
      role: "MANAGER",
    })
    if (expired.linked) throw new Error("expected token invite")
    await expireInvite(
      (await prisma.staffInvite.findFirstOrThrow({ where: { email: expiredEmail } })).id
    )

    // REVOKED
    const revokedEmail = `revoked-${randomBytes(3).toString("hex")}@via.test`
    const revoked = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Revoked Person",
      email: revokedEmail,
      role: "STAFF",
    })
    if (revoked.linked) throw new Error("expected token invite")
    await rescindInvitation(
      org.org.id,
      org.user.id,
      (await prisma.staffInvite.findFirstOrThrow({ where: { email: revokedEmail } })).id
    )

    const list = await listInvitations(org.org.id, org.user.id)
    const byEmail = new Map(list.map((i) => [i.email, i]))

    expect(byEmail.size).toBe(4)
    expect(byEmail.get(pendingEmail)!.state).toBe("PENDING")
    expect(byEmail.get(acceptedEmail)!.state).toBe("ACCEPTED")
    expect(byEmail.get(expiredEmail)!.state).toBe("EXPIRED")
    expect(byEmail.get(revokedEmail)!.state).toBe("REVOKED")

    // C-AC19: the serialized view must contain NO hash and NO raw token.
    const stored = await prisma.staffInvite.findMany({
      where: { organizationId: org.org.id },
    })
    const serialized = JSON.stringify(list)
    for (const row of stored) {
      expect(serialized).not.toContain(row.tokenHash)
    }
    for (const token of [pending.inviteToken, accepted.inviteToken, expired.inviteToken, revoked.inviteToken]) {
      expect(serialized).not.toContain(token)
    }
    expect(serialized).not.toContain("tokenHash")
  })

  it("C-AC16: cross-org listing and rescinding fail closed with uniform errors", async () => {
    const a = await createOrganizationFixture()
    const b = await createOrganizationFixture()
    await inviteStaffMember(b.org.id, b.user.id, {
      name: "B Staff",
      email: `b-staff-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })

    // OWNER of A is not an OWNER of B — listing B's invitations rejects.
    await expect(listInvitations(b.org.id, a.user.id)).rejects.toThrow(/Only Owners/)

    // A rescinding a B invite id within its own org → uniform no-leak miss.
    const bInvite = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: b.org.id },
    })
    await expect(
      rescindInvitation(a.org.id, a.user.id, bInvite.id)
    ).rejects.toThrow("Invitation not found.")
    // And a nonexistent id behaves identically (indistinguishable).
    await expect(
      rescindInvitation(a.org.id, a.user.id, "nonexistent-id")
    ).rejects.toThrow("Invitation not found.")
  })
})

describe("P1-15 rescission and acceptance interplay (C-AC13..C-AC15, C-AC20)", () => {
  it("C-AC13: rescinding a PENDING invite sets revokedAt; the token can never be accepted afterwards", async () => {
    const org = await createOrganizationFixture()
    const invite = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Rescind Me",
      email: `rescind-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (invite.linked) throw new Error("expected token invite")

    const row = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "rescind-" } },
    })
    await rescindInvitation(org.org.id, org.user.id, row.id)

    const revoked = await prisma.staffInvite.findUniqueOrThrow({ where: { id: row.id } })
    expect(revoked.revokedAt).not.toBeNull()

    await expect(acceptStaffInvite(invite.inviteToken, "a-password-123")).rejects.toThrow(
      /invalid, used, or expired/
    )
    // No membership was created.
    expect(
      await prisma.membership.findFirst({ where: { organizationId: org.org.id, user: { email: row.email } } })
    ).toBeNull()
  })

  it("C-AC14: ACCEPTED and EXPIRED invites reject acceptance exactly as today", async () => {
    const org = await createOrganizationFixture()

    const accepted = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Used Up",
      email: `used-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (accepted.linked) throw new Error("expected token invite")
    await acceptStaffInvite(accepted.inviteToken, "first-password-1")
    await expect(acceptStaffInvite(accepted.inviteToken, "second-password-2")).rejects.toThrow(
      /invalid, used, or expired/
    )

    const expired = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Stale",
      email: `stale-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (expired.linked) throw new Error("expected token invite")
    const row = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "stale-" } },
    })
    await expireInvite(row.id)
    await expect(acceptStaffInvite(expired.inviteToken, "late-password-1")).rejects.toThrow(
      /invalid, used, or expired/
    )
  })

  it("C-AC15: concurrent accept + rescind — exactly one terminal outcome, at most one membership", async () => {
    const org = await createOrganizationFixture()
    const invite = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Racer",
      email: `race-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (invite.linked) throw new Error("expected token invite")
    const row = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "race-" } },
    })

    const [accepted, rescinded] = await Promise.allSettled([
      acceptStaffInvite(invite.inviteToken, "race-password-1"),
      rescindInvitation(org.org.id, org.user.id, row.id),
    ])

    // Exactly one succeeded.
    const fulfilled = [accepted, rescinded].filter((r) => r.status === "fulfilled")
    expect(fulfilled).toHaveLength(1)

    // At most one membership, and the row is terminal.
    const memberships = await prisma.membership.findMany({
      where: { organizationId: org.org.id, user: { email: row.email } },
    })
    expect(memberships.length).toBeLessThanOrEqual(1)
    const finalRow = await prisma.staffInvite.findUniqueOrThrow({ where: { id: row.id } })
    expect(finalRow.acceptedAt !== null || finalRow.revokedAt !== null).toBe(true)
  })

  it("C-AC20: invite rows are retained after acceptance and revocation (no deletion path)", async () => {
    const org = await createOrganizationFixture()

    // ACCEPTED invite: the row survives acceptance (and a later rescind
    // attempt correctly reports "already used" — C-D8b — without deleting).
    const accepted = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Keeper",
      email: `keep-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (accepted.linked) throw new Error("expected token invite")
    const acceptedRow = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "keep-" } },
    })
    await acceptStaffInvite(accepted.inviteToken, "keep-password-1")
    await expect(rescindInvitation(org.org.id, org.user.id, acceptedRow.id)).rejects.toThrow(
      /already been used/
    )
    expect(
      await prisma.staffInvite.findUnique({ where: { id: acceptedRow.id } })
    ).not.toBeNull()

    // REVOKED invite: the row survives rescission.
    const revoked = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Revoked Keeper",
      email: `rkeep-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (revoked.linked) throw new Error("expected token invite")
    const revokedRow = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "rkeep-" } },
    })
    await rescindInvitation(org.org.id, org.user.id, revokedRow.id)
    expect(
      await prisma.staffInvite.findUnique({ where: { id: revokedRow.id } })
    ).not.toBeNull()

    // Both terminal rows are retained — no deletion path exists.
    expect(await prisma.staffInvite.count({ where: { organizationId: org.org.id } })).toBe(2)
  })
})

describe("P1-15 supersession on both reinvitation paths (C-AC17, C-AC18, C-AC61)", () => {
  it("C-AC61 (token path): reinviting the same email supersedes the pending invite; the old token is dead", async () => {
    const org = await createOrganizationFixture()
    const email = `supersede-${randomBytes(3).toString("hex")}@via.test`

    const first = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Supersede", email, role: "STAFF",
    })
    if (first.linked) throw new Error("expected token invite")
    const firstRow = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email },
    })

    const second = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Supersede", email, role: "MANAGER",
    })
    if (second.linked) throw new Error("expected token invite")

    // The first row is REVOKED; the second is PENDING.
    const after = await prisma.staffInvite.findMany({
      where: { organizationId: org.org.id, email },
      orderBy: { createdAt: "asc" },
    })
    expect(after).toHaveLength(2)
    expect(after[0].revokedAt).not.toBeNull()
    expect(after[1].revokedAt).toBeNull()

    // The superseded token can never be accepted.
    await expect(acceptStaffInvite(first.inviteToken, "old-password-12")).rejects.toThrow(
      /invalid, used, or expired/
    )
    // The live token works.
    const result = await acceptStaffInvite(second.inviteToken, "new-password-12")
    expect(result.membership.role).toBe("MANAGER")

    // Exactly one supersession audit for the first row, actor = re-inviting OWNER,
    // supersededBy = the second invite id (C-AC18).
    const audits = await auditRowsFor(org.org.id, "RESCIND_INVITE")
    expect(audits).toHaveLength(1)
    expect(audits[0].actorId).toBe(org.user.id)
    expect(audits[0].targetId).toBe(firstRow.id)
    const meta = audits[0].metadata as Record<string, unknown>
    expect(meta.supersededBy).toBe(after[1].id)
  })

  it("C-AC61 (LINKED_EXISTING_USER path): linking an existing user supersedes their live pending token invite", async () => {
    const org = await createOrganizationFixture()
    const email = `linked-${randomBytes(3).toString("hex")}@via.test`

    // 1. Invite while NO account exists yet → a live PENDING token invite.
    const pending = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Linked", email, role: "STAFF",
    })
    if (pending.linked) throw new Error("expected token invite")
    const pendingRow = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email },
    })

    // 2. The invitee then registers an account elsewhere (simulating
    //    registration between the invite and the reinvitation).
    const user = await createUser(email)

    // 3. Reinvitation now resolves to the LINKED path (existing account).
    const linked = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Linked", email, role: "MANAGER",
    })
    expect(linked.linked).toBe(true)

    // The pending token invite was superseded in the same transaction.
    const after = await prisma.staffInvite.findUniqueOrThrow({ where: { id: pendingRow.id } })
    expect(after.revokedAt).not.toBeNull()

    // Old token is dead AND the account is already a member — either way,
    // no second membership can ever be created.
    await expect(acceptStaffInvite(pending.inviteToken, "late-password-1")).rejects.toThrow(
      /invalid, used, or expired/
    )
    const memberships = await prisma.membership.findMany({
      where: { organizationId: org.org.id, userId: user.id },
    })
    expect(memberships).toHaveLength(1)
    expect(memberships[0].role).toBe("MANAGER")

    const audits = await auditRowsFor(org.org.id, "RESCIND_INVITE")
    expect(audits).toHaveLength(1)
    expect(audits[0].actorId).toBe(org.user.id)
    // On the LINKED path, supersededBy = the membership created in the same tx.
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: user.id, organizationId: org.org.id } },
    })
    expect((audits[0].metadata as Record<string, unknown>).supersededBy).toBe(membership.id)
  })

  it("C-AC18: manual rescission writes exactly one RESCIND_INVITE audit; re-rescission is idempotent (no second audit)", async () => {
    const org = await createOrganizationFixture()
    const invite = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Idempotent",
      email: `idem-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (invite.linked) throw new Error("expected token invite")
    const row = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "idem-" } },
    })

    const first = await rescindInvitation(org.org.id, org.user.id, row.id)
    expect(first.alreadyRevoked).toBe(false)
    const second = await rescindInvitation(org.org.id, org.user.id, row.id)
    expect(second.alreadyRevoked).toBe(true)

    expect(await auditRowsFor(org.org.id, "RESCIND_INVITE")).toHaveLength(1)

    // An ACCEPTED invite reports "already used" and does not resurrect.
    const used = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Used",
      email: `used2-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (used.linked) throw new Error("expected token invite")
    const usedRow = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "used2-" } },
    })
    await acceptStaffInvite(used.inviteToken, "used-password-1")
    await expect(rescindInvitation(org.org.id, org.user.id, usedRow.id)).rejects.toThrow(
      /already been used/
    )
    expect(await auditRowsFor(org.org.id, "RESCIND_INVITE")).toHaveLength(1)
  })
})

describe("P1-15 email normalization (C-AC51, C-AC52)", () => {
  it("C-AC51: a case-mismatched pre-existing account MATCHES after normalization (acceptance succeeds)", async () => {
    const org = await createOrganizationFixture()
    const email = `mixed-case-${randomBytes(3).toString("hex")}@via.test`

    // The account as REGISTRATION stores it: normalized lowercase (C-D18a —
    // every account-creating path persists the normalized address).
    const user = await createUser(email)

    // The OWNER addresses the invite with a different casing of the same
    // address; normalization bridges the mismatch and the existing account
    // is linked (no new account, no linkage failure, no P2002).
    const linked = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Mixed",
      email: email.toUpperCase(),
      role: "STAFF",
    })
    expect(linked.linked).toBe(true)

    // The membership attached to the EXISTING account — no linkage failure.
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { userId_organizationId: { userId: user.id, organizationId: org.org.id } },
    })
    expect(membership.role).toBe("STAFF")

    // The invite row (if any) shows the normalized address.
    const invites = await prisma.staffInvite.findMany({
      where: { organizationId: org.org.id },
    })
    for (const row of invites) {
      expect(row.email).toBe(email)
    }
  })

  it("C-AC52: registration, invitation and acceptance compare the same normalized address", async () => {
    // Registration normalizes.
    const suffix = randomBytes(4).toString("hex")
    const registered = await registerOrganization({
      name: `Reg ${suffix}`,
      businessName: `Biz ${suffix}`,
      email: `Reg-${suffix}@VIA.TEST`,
      password: "reg-password-123",
    })
    expect(registered.user.email).toBe(`reg-${suffix}@via.test`)

    // A second registration attempt with different casing is the SAME account.
    await expect(
      registerOrganization({
        name: `Reg2 ${suffix}`,
        businessName: `Biz2 ${suffix}`,
        email: `  REG-${suffix}@via.test  `,
        password: "reg-password-123",
      })
    ).rejects.toThrow(/already exists/)

    // Invitation persistence normalizes.
    const invited = await inviteStaffMember(registered.org.id, registered.user.id, {
      name: "Norm",
      email: `  NORM-${suffix}@Via.Test  `,
      role: "STAFF",
    })
    if (invited.linked) throw new Error("expected token invite")
    const row = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: registered.org.id },
    })
    expect(row.email).toBe(`norm-${suffix}@via.test`)

    // Acceptance binds to the invited (normalized) address.
    const { membership, user } = await acceptStaffInvite(invited.inviteToken, "norm-password-1")
    expect(user.email).toBe(`norm-${suffix}@via.test`)
    expect(membership.organizationId).toBe(registered.org.id)
  })
})

describe("P1-C audit invariants (C-AC43, C-AC44 — invite events)", () => {
  it("C-AC43: RESCIND_INVITE rejects a null actor (D-G matrix)", async () => {
    const org = await createOrganizationFixture()
    await expect(
      logAuditEvent(org.org.id, null, "RESCIND_INVITE", "target", {})
    ).rejects.toThrow("Audit events require an authenticated actor.")
  })

  it("C-AC44: forced audit failure rolls back rescission — revokedAt unchanged, no audit", async () => {
    const org = await createOrganizationFixture()
    const invite = await inviteStaffMember(org.org.id, org.user.id, {
      name: "Rollback",
      email: `rollback-${randomBytes(3).toString("hex")}@via.test`,
      role: "STAFF",
    })
    if (invite.linked) throw new Error("expected token invite")
    const row = await prisma.staffInvite.findFirstOrThrow({
      where: { organizationId: org.org.id, email: { contains: "rollback-" } },
    })

    await installAuditKillTrigger(org.org.id, "RESCIND_INVITE")
    await expect(rescindInvitation(org.org.id, org.user.id, row.id)).rejects.toThrow(
      /forced audit failure/
    )

    const unchanged = await prisma.staffInvite.findUniqueOrThrow({ where: { id: row.id } })
    expect(unchanged.revokedAt).toBeNull()
    expect(await auditRowsFor(org.org.id, "RESCIND_INVITE")).toHaveLength(0)
  })
})
