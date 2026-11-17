import { Prisma } from "@prisma/client"
import { prisma } from "@via-saas/database"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { logAuditEvent } from "./audit"
import { DomainError } from "./errors"

const INVITE_TTL_HOURS = 48

/**
 * C-D18a (approved): the canonical email normalization — trim + lowercase —
 * applied IDENTICALLY at registration, login, invitation creation, and
 * acceptance account matching, so every path compares the same normalized
 * value. (Invite creation already normalized; registration and login were
 * aligned in P1-C.)
 */
export function normalizeEmail(email: string): string {
  return email?.trim().toLowerCase()
}

export function generateStoreSlug(businessName: string): string {
  const base =
    businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "store"
  // Short random suffix guarantees uniqueness without extra round-trips;
  // the DB unique index is the backstop.
  const suffix = crypto.randomBytes(3).toString("hex")
  return `${base}-${suffix}`
}

export async function registerOrganization(data: { name: string, businessName: string, email: string, password: string }) {
  // C-D18a: registration normalizes to match the invitation path.
  const email = normalizeEmail(data.email)
  const existingUser = await prisma.user.findUnique({ where: { email } })
  if (existingUser) throw new DomainError("EMAIL_TAKEN", "An account with this email already exists.")

  const passwordHash = await bcrypt.hash(data.password, 10)

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { name: data.name, email, passwordHash } })
    const org = await tx.organization.create({ data: { name: data.businessName, subscriptionPlan: "GROWTH" } })
    const store = await tx.store.create({
      data: { name: data.businessName, organizationId: org.id, slug: generateStoreSlug(data.businessName) },
    })
    const location = await tx.location.create({ data: { name: "Main Location", storeId: store.id } })

    await tx.membership.create({
      data: { userId: user.id, organizationId: org.id, role: "OWNER", allowedLocationIds: [] }
    })

    return { user, org, location }
  })
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Supersedes (auto-rescinds, approved C-D7a) every PENDING token invite for
 * (organizationId, email) inside the caller's transaction, writing one
 * RESCIND_INVITE audit per superseded row with `supersededBy` metadata
 * (C12: every terminal invite transition is audited). Applied on BOTH the
 * token-invite and the LINKED_EXISTING_USER reinvitation paths (section 8.5).
 */
async function supersedePendingInvites(
  tx: Prisma.TransactionClient,
  orgId: string,
  actorId: string,
  email: string,
  supersededBy: string,
  excludeId?: string
): Promise<void> {
  const now = new Date()
  const pending = await tx.staffInvite.findMany({
    where: {
      organizationId: orgId,
      email,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, role: true },
  })
  if (pending.length === 0) return

  await tx.staffInvite.updateMany({
    where: {
      id: { in: pending.map((p) => p.id) },
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    data: { revokedAt: now },
  })

  for (const invite of pending) {
    await logAuditEvent(
      orgId,
      actorId,
      "RESCIND_INVITE",
      invite.id,
      {
        email,
        role: invite.role,
        mode: "TOKEN_INVITE",
        supersededBy,
      },
      tx
    )
  }
}

/**
 * Invites a staff member.
 *
 * SECURITY (replaces the removed hardcoded default password):
 * - If the email already belongs to a system user who is NOT yet a member of
 *   this organization, they are linked directly (they already have a password).
 * - Otherwise a StaffInvite is created: a 256-bit single-use token is returned
 *   to the caller EXACTLY ONCE; only its SHA-256 hash is stored. The invite
 *   expires (INVITE_TTL_HOURS) and expires/accepted/revoked tokens are useless.
 * - No password is ever generated, logged, or transmitted by the server.
 *
 * P1-C (approved C-D7a): reinvitation SUPERSEDES pending invites — at most
 * one live token per (org, email), on both paths (section 8.5).
 */
export async function inviteStaffMember(
  orgId: string,
  actorId: string,
  data: { name: string, email: string, role: "MANAGER" | "STAFF", locationId?: string }
) {
  const name = data.name?.trim()
  const email = data.email?.trim().toLowerCase()

  if (!name || !email || !EMAIL_PATTERN.test(email)) {
    throw new DomainError("VALIDATION", "A valid name and email are required.")
  }
  if (data.role !== "MANAGER" && data.role !== "STAFF") {
    throw new DomainError("VALIDATION", "Role must be MANAGER or STAFF.")
  }

  // TENANT AUTHORIZATION: restricted location must belong to this organization
  // AND be active — archived locations can never be granted (P1-16, section 9.4).
  if (data.locationId) {
    const location = await prisma.location.findFirst({
      where: { id: data.locationId, store: { organizationId: orgId }, archivedAt: null },
      select: { id: true },
    })
    if (!location) {
      throw new DomainError("FORBIDDEN", "Invalid location for this business.")
    }
  }

  const existingUser = await prisma.user.findUnique({ where: { email } })

  if (existingUser) {
    const existingMembership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId: existingUser.id, organizationId: orgId } },
    })
    if (existingMembership) {
      throw new DomainError("ALREADY_MEMBER", "User is already a member of this organization.")
    }

    // Direct-link path (LINKED_EXISTING_USER): supersede stale pending
    // invites in the SAME transaction as the membership creation.
    return prisma.$transaction(async (tx) => {
      const membership = await tx.membership.create({
        data: {
          userId: existingUser.id,
          organizationId: orgId,
          role: data.role,
          allowedLocationIds: data.locationId ? [data.locationId] : [],
        },
      })

      await supersedePendingInvites(tx, orgId, actorId, email, membership.id)

      await logAuditEvent(orgId, actorId, "INVITE_STAFF", existingUser.id, {
        email,
        role: data.role,
        mode: "LINKED_EXISTING_USER",
      }, tx)

      return { linked: true as const }
    })
  }

  const rawToken = crypto.randomBytes(32).toString("hex")
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex")
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000)

  // Token path: create the new invite, then supersede any pending invites
  // for the same (org, email) — same transaction, RESCIND_INVITE audits with
  // supersededBy = the new invite id.
  const result = await prisma.$transaction(async (tx) => {
    const invite = await tx.staffInvite.create({
      data: {
        organizationId: orgId,
        name,
        email,
        role: data.role,
        allowedLocationIds: data.locationId ? [data.locationId] : [],
        tokenHash,
        expiresAt,
      },
    })

    await supersedePendingInvites(tx, orgId, actorId, email, invite.id, invite.id)

    await logAuditEvent(orgId, actorId, "INVITE_STAFF", email, {
      email,
      role: data.role,
      mode: "TOKEN_INVITE",
    }, tx)

    // The raw token leaves the server once, to be embedded in a setup link.
    return { linked: false as const, inviteToken: rawToken, expiresAt }
  })

  return result
}

/**
 * Accepts a staff invite: sets the account password and creates the membership.
 * Single-use (acceptedAt), time-limited (expiresAt), hashed-token lookup.
 *
 * P1-C hardening (section 8.4): acceptance claims the invite via a CONDITIONAL
 * in-transaction transition (acceptedAt IS NULL AND revokedAt IS NULL AND not
 * expired) — a concurrent rescission and acceptance produce exactly one
 * winner; at most one membership is ever created. A revoked invite is never
 * acceptable, regardless of any other field.
 */
export async function acceptStaffInvite(rawToken: string, password: string) {
  if (!rawToken) throw new DomainError("INVALID_INVITE", "This invitation link is invalid.")

  if (!password || password.length < 8) {
    throw new DomainError("VALIDATION", "Password must be at least 8 characters.")
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex")

  const invite = await prisma.staffInvite.findUnique({ where: { tokenHash } })
  if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) {
    throw new DomainError("INVALID_INVITE", "This invitation link is invalid, used, or expired.")
  }

  return prisma.$transaction(async (tx) => {
    // Conditional single-winner claim (section 8.4): one of {accept, revoke}
    // wins; the loser's writes roll back with its whole transaction.
    const claim = await tx.staffInvite.updateMany({
      where: {
        id: invite.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { acceptedAt: new Date() },
    })
    if (claim.count === 0) {
      throw new DomainError("INVALID_INVITE", "This invitation link is invalid, used, or expired.")
    }

    // The invite email must still be free — guards against a raced registration
    // between invite creation and acceptance. (C-D18a: invites persist a
    // normalized address, so this lookup is exact.)
    let user = await tx.user.findUnique({ where: { email: invite.email } })

    if (!user) {
      const passwordHash = await bcrypt.hash(password, 10)
      user = await tx.user.create({
        data: { name: invite.name, email: invite.email, passwordHash },
      })
    }

    const existingMembership = await tx.membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: invite.organizationId } },
    })
    if (existingMembership) {
      throw new DomainError("ALREADY_MEMBER", "You are already a member of this organization.")
    }

    const membership = await tx.membership.create({
      data: {
        userId: user.id,
        organizationId: invite.organizationId,
        role: invite.role,
        allowedLocationIds: invite.allowedLocationIds,
      },
    })

    return { membership, user }
  })
}

/** Derived invitation state (section 8.1): REVOKED > ACCEPTED > EXPIRED > PENDING. */
export type InvitationState = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED"

export type InvitationView = {
  id: string
  name: string
  email: string
  role: string
  allowedLocationIds: string[]
  createdAt: Date
  expiresAt: Date
  state: InvitationState
}

function deriveInvitationState(
  invite: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date
): InvitationState {
  if (invite.revokedAt) return "REVOKED"
  if (invite.acceptedAt) return "ACCEPTED"
  if (invite.expiresAt <= now) return "EXPIRED"
  return "PENDING"
}

/**
 * Lists the organization's invitations (OWNER only, approved C-D8b: all
 * rows with derived states). SECURITY: the SHA-256 tokenHash and any raw
 * token are NEVER returned — hash-only storage is locked by frozen tests.
 */
export async function listInvitations(
  orgId: string,
  actorId: string
): Promise<InvitationView[]> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: actorId, organizationId: orgId } },
    select: { role: true },
  })
  if (!membership || membership.role !== "OWNER") {
    throw new DomainError("FORBIDDEN", "Only Owners can view invitations.")
  }

  const invites = await prisma.staffInvite.findMany({
    where: { organizationId: orgId },
    orderBy: { createdAt: "desc" },
    take: 100,
  })
  const now = new Date()

  return invites.map((invite) => ({
    id: invite.id,
    name: invite.name,
    email: invite.email,
    role: invite.role,
    allowedLocationIds: invite.allowedLocationIds,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    state: deriveInvitationState(invite, now),
  }))
}

/**
 * Rescinds a PENDING invitation (OWNER only, approved C-D8b/i).
 *
 * Semantics: conditional in-transaction transition
 * `acceptedAt IS NULL AND revokedAt IS NULL -> revokedAt = now`. A re-rescind
 * of an already-revoked invite is an idempotent success (no second audit —
 * exactly one event per state change); an accepted invite reports "already
 * used"; cross-org ids fail closed with the uniform no-leak error.
 */
export async function rescindInvitation(
  orgId: string,
  actorId: string,
  inviteId: string
): Promise<{ alreadyRevoked: boolean }> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: actorId, organizationId: orgId } },
    select: { role: true },
  })
  if (!membership || membership.role !== "OWNER") {
    throw new DomainError("FORBIDDEN", "Only Owners can rescind invitations.")
  }

  return prisma.$transaction(async (tx) => {
    // Org-scoped fetch: a cross-org invite id is indistinguishable from a
    // nonexistent one (uniform error).
    const invite = await tx.staffInvite.findFirst({
      where: { id: inviteId, organizationId: orgId },
      select: { id: true, email: true, role: true, acceptedAt: true, revokedAt: true },
    })
    if (!invite) {
      throw new DomainError("NOT_FOUND", "Invitation not found.")
    }
    if (invite.acceptedAt) {
      throw new DomainError("VALIDATION", "This invitation has already been used.")
    }
    if (invite.revokedAt) {
      // C-D8i: idempotent success, no state change, no second audit event.
      return { alreadyRevoked: true }
    }

    const rescinded = await tx.staffInvite.updateMany({
      where: {
        id: invite.id,
        organizationId: orgId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    })
    if (rescinded.count === 0) {
      // Lost a race with a concurrent accept — report the safe state.
      throw new DomainError("VALIDATION", "This invitation has already been used.")
    }

    await logAuditEvent(
      orgId,
      actorId,
      "RESCIND_INVITE",
      invite.id,
      { email: invite.email, role: invite.role, mode: "TOKEN_INVITE" },
      tx
    )

    return { alreadyRevoked: false }
  })
}
