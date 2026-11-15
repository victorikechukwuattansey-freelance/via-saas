import { prisma } from "@via-saas/database"
import bcrypt from "bcryptjs"
import crypto from "crypto"
import { logAuditEvent } from "./audit"
import { DomainError } from "./errors"

const INVITE_TTL_HOURS = 48

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
  const existingUser = await prisma.user.findUnique({ where: { email: data.email } })
  if (existingUser) throw new DomainError("EMAIL_TAKEN", "An account with this email already exists.")

  const passwordHash = await bcrypt.hash(data.password, 10)

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { name: data.name, email: data.email, passwordHash } })
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
 * Invites a staff member.
 *
 * SECURITY (replaces the removed hardcoded default password):
 * - If the email already belongs to a system user who is NOT yet a member of
 *   this organization, they are linked directly (they already have a password).
 * - Otherwise a StaffInvite is created: a 256-bit single-use token is returned
 *   to the caller EXACTLY ONCE; only its SHA-256 hash is stored. The invite
 *   expires (INVITE_TTL_HOURS) and expires/accepted tokens are useless.
 * - No password is ever generated, logged, or transmitted by the server.
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

  // TENANT AUTHORIZATION: restricted location must belong to this organization.
  if (data.locationId) {
    const location = await prisma.location.findFirst({
      where: { id: data.locationId, store: { organizationId: orgId } },
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

    await prisma.membership.create({
      data: {
        userId: existingUser.id,
        organizationId: orgId,
        role: data.role,
        allowedLocationIds: data.locationId ? [data.locationId] : [],
      },
    })

    await logAuditEvent(orgId, actorId, "INVITE_STAFF", existingUser.id, {
      email,
      role: data.role,
      mode: "LINKED_EXISTING_USER",
    })

    return { linked: true as const }
  }

  const rawToken = crypto.randomBytes(32).toString("hex")
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex")
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000)

  await prisma.staffInvite.create({
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

  await logAuditEvent(orgId, actorId, "INVITE_STAFF", email, {
    email,
    role: data.role,
    mode: "TOKEN_INVITE",
  })

  // The raw token leaves the server once, to be embedded in a setup link.
  return { linked: false as const, inviteToken: rawToken, expiresAt }
}

/**
 * Accepts a staff invite: sets the account password and creates the membership.
 * Single-use (acceptedAt), time-limited (expiresAt), and hashed-token lookup.
 */
export async function acceptStaffInvite(rawToken: string, password: string) {
  if (!rawToken) throw new DomainError("INVALID_INVITE", "This invitation link is invalid.")

  if (!password || password.length < 8) {
    throw new DomainError("VALIDATION", "Password must be at least 8 characters.")
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex")

  const invite = await prisma.staffInvite.findUnique({ where: { tokenHash } })
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    throw new DomainError("INVALID_INVITE", "This invitation link is invalid, used, or expired.")
  }

  return prisma.$transaction(async (tx) => {
    // The invite email must still be free — guards against a raced registration
    // between invite creation and acceptance.
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

    await tx.staffInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    })

    return { membership, user }
  })
}
