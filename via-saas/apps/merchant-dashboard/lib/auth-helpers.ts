import { prisma } from "@via-saas/database"
import { cookies } from "next/headers"

/**
 * Resolves the authenticated session context for server components and
 * server actions.
 *
 * SECURITY:
 * - Expired sessions are treated as UNAUTHENTICATED (E-8) and are lazily
 *   deleted, so expiry is enforced on every path that uses this helper.
 * - `locationId` is derived ONLY from ACTIVE locations the membership is
 *   allowed to access (enforcement of Membership.allowedLocationIds, E-11,
 *   plus the P1-16 archived-location exclusion). A membership with no
 *   accessible ACTIVE locations yields no context.
 * - The client NEVER chooses the organization at resolution time: the active
 *   organization lives server-side on the Session row, set only by the
 *   membership-verified switch action (§10.3). Resolution RE-VERIFIES the
 *   active membership on every request (C11) and falls back deterministically
 *   when it is stale or ineligible — a stale activeOrganizationId never
 *   blocks resolution and never grants access (C-AC36/38).
 * - This function is READ-ONLY: the session row is never rewritten during
 *   resolution (fallback self-heals at the next switch/expiry).
 *
 * P1-C §10.2 resolution semantics (replaces the bare `memberships[0]`):
 *   1. load session + user + memberships (+organization→stores→locations)
 *   2. expired? → lazy delete + null                       [unchanged, E-8]
 *   3. zero memberships → null                             [unchanged]
 *   4. activeOrganizationId set AND its membership exists AND is eligible
 *      → use it; otherwise FALLBACK                        [C11]
 *   5. FALLBACK (C10, replaces memberships[0]): order memberships
 *      deterministically (organization.createdAt, then membership.id) and
 *      pick the FIRST ELIGIBLE (≥1 accessible active location); none
 *      eligible → null                                     [C-AC55]
 *   6. location expansion: archived excluded in BOTH modes; deterministic
 *      ordering (location.createdAt, then id) before the locationId pick
 *                                                          [C18, C-AC56]
 */
export async function getSessionContext() {
  const token = cookies().get("session_token")?.value
  if (!token) return null

  const session = await prisma.session.findUnique({
    where: { token },
    include: {
      user: {
        include: {
          memberships: {
            include: {
              organization: {
                include: { stores: { include: { locations: true } } }
              }
            }
          }
        }
      }
    }
  })

  if (!session || session.expiresAt < new Date()) {
    // Lazy cleanup of expired/invalid sessions
    await prisma.session.deleteMany({ where: { token } })
    return null
  }

  // C18: deterministic ordering — organization createdAt, then membership id.
  const orderedMemberships = [...session.user.memberships].sort((a, b) => {
    const byOrg = a.organization.createdAt.getTime() - b.organization.createdAt.getTime()
    if (byOrg !== 0) return byOrg
    return a.id.localeCompare(b.id)
  })

  /**
   * Location expansion with the P1-16 archived filter (both modes):
   * empty allowedLocationIds = all ACTIVE org locations; a restricted list
   * is intersected with the ACTIVE org locations. Result is ordered
   * deterministically (createdAt, then id) so `locationId` is stable (C18).
   * A membership that resolves to zero accessible locations is INELIGIBLE.
   */
  const resolveAccessible = (membership: (typeof orderedMemberships)[number]) => {
    const activeLocations = membership.organization.stores
      .flatMap((store) => store.locations)
      .filter((loc) => !loc.archivedAt)
    const restricted = membership.allowedLocationIds ?? []
    const accessible = (
      restricted.length === 0 ? activeLocations : activeLocations.filter((loc) => restricted.includes(loc.id))
    ).sort((a, b) => {
      const byCreated = a.createdAt.getTime() - b.createdAt.getTime()
      if (byCreated !== 0) return byCreated
      return a.id.localeCompare(b.id)
    })
    return accessible
  }

  const buildContext = (
    membership: (typeof orderedMemberships)[number],
    accessibleLocations: ReturnType<typeof resolveAccessible>
  ) => ({
    userId: session.userId,
    orgId: membership.organizationId,
    locationId: accessibleLocations[0].id,
    role: membership.role,
    accessibleLocationIds: accessibleLocations.map((loc) => loc.id),
    // Raw membership restriction, distinct from the resolved accessible list:
    // empty array means "all locations allowed" (no explicit authorization).
    rawAllowedLocationIds: membership.allowedLocationIds ?? [],
    user: session.user
  })

  // Step 4: active organization preference (C-D13/C11). The membership is
  // re-verified EVERY request; staleness/ineligibility falls through to the
  // deterministic fallback — never a block, never unauthorized access.
  const activeMembership =
    session.activeOrganizationId != null
      ? orderedMemberships.find((m) => m.organizationId === session.activeOrganizationId)
      : undefined

  if (activeMembership) {
    const accessible = resolveAccessible(activeMembership)
    if (accessible.length > 0) {
      return buildContext(activeMembership, accessible)
    }
    // Stale or ineligible active org → FALLBACK (C11/C-AC36).
  }

  // Step 5: eligible-first fallback (C10) — replaces `memberships[0]`.
  for (const membership of orderedMemberships) {
    const accessible = resolveAccessible(membership)
    if (accessible.length > 0) {
      return buildContext(membership, accessible)
    }
  }

  return null
}

export type SessionContext = NonNullable<Awaited<ReturnType<typeof getSessionContext>>>

/**
 * C-D13a (login initialization): given a user's memberships (with
 * organization → stores → locations loaded), returns the org id of the FIRST
 * ELIGIBLE membership under the §10.2 deterministic ordering
 * (organization.createdAt ASC, then membership.id ASC). Eligible =
 * ≥1 accessible ACTIVE location under the membership's scope. Returns null
 * when the user has no eligible organization (session is created with a null
 * activeOrganizationId and resolution falls through to null).
 */
export function pickInitialActiveOrganization<
  M extends {
    id: string
    organizationId: string
    allowedLocationIds: string[]
    organization: {
      createdAt: Date
      stores: { locations: { id: string; archivedAt: Date | null }[] }[]
    }
  }
>(memberships: M[]): string | null {
  const ordered = [...memberships].sort((a, b) => {
    const byOrg = a.organization.createdAt.getTime() - b.organization.createdAt.getTime()
    if (byOrg !== 0) return byOrg
    return a.id.localeCompare(b.id)
  })
  for (const membership of ordered) {
    if (isMembershipEligible(membership)) return membership.organizationId
  }
  return null
}

/** The §10.2 eligibility predicate shared by resolution and the switcher. */
function isMembershipEligible<
  M extends {
    allowedLocationIds: string[]
    organization: {
      stores: { locations: { id: string; archivedAt: Date | null }[] }[]
    }
  }
>(membership: M): boolean {
  const activeLocations = membership.organization.stores
    .flatMap((store) => store.locations)
    .filter((loc) => !loc.archivedAt)
  const restricted = membership.allowedLocationIds ?? []
  const accessible =
    restricted.length === 0
      ? activeLocations
      : activeLocations.filter((loc) => restricted.includes(loc.id))
  return accessible.length > 0
}

/**
 * The eligible organizations a user may switch between (§10.3 UI): the
 * user's memberships with ≥1 accessible ACTIVE location, in the
 * deterministic §10.2 order. Rendered by the top-bar switcher; a single
 * entry means the switcher renders static (no switching surface).
 */
export async function listEligibleOrganizations(
  userId: string
): Promise<{ organizationId: string; name: string }[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: {
      organization: { include: { stores: { include: { locations: true } } } },
    },
  })
  return memberships
    .filter(isMembershipEligible)
    .sort((a, b) => {
      const byOrg = a.organization.createdAt.getTime() - b.organization.createdAt.getTime()
      if (byOrg !== 0) return byOrg
      return a.id.localeCompare(b.id)
    })
    .map((m) => ({ organizationId: m.organizationId, name: m.organization.name }))
}

/** Location-level authorization check (E-11). */
export function canAccessLocation(context: SessionContext, locationId: string): boolean {
  return context.accessibleLocationIds.includes(locationId)
}

/**
 * Stock-adjustment permission (P1-A binding decision): OWNER and MANAGER may
 * always adjust stock. STAFF may only adjust when EXPLICITLY authorized —
 * i.e. the membership carries a non-empty allowedLocationIds list. A STAFF
 * membership with no restriction (access to all locations) is NOT an
 * authorization to move stock.
 */
export function canAdjustStock(context: SessionContext): boolean {
  if (context.role === "OWNER" || context.role === "MANAGER") return true
  return context.rawAllowedLocationIds.length > 0
}

/**
 * Catalogue-mutation permission (P1-A): product/variant/category/image edits,
 * archiving, and deletion are restricted to OWNER and MANAGER. STAFF members
 * sell and (when authorized) adjust stock; they do not restructure the
 * catalogue.
 */
export function canManageCatalogue(context: SessionContext): boolean {
  return context.role === "OWNER" || context.role === "MANAGER"
}
