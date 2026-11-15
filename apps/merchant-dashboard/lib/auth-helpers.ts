import { prisma } from "@via-saas/database"
import { cookies } from "next/headers"

/**
 * Resolves the authenticated session context for server components and
 * server actions.
 *
 * SECURITY:
 * - Expired sessions are treated as UNAUTHENTICATED (E-8) and are lazily
 *   deleted, so expiry is enforced on every path that uses this helper.
 * - `locationId` is derived ONLY from locations the membership is allowed to
 *   access (enforcement of Membership.allowedLocationIds, E-11). A membership
 *   with no accessible locations yields no context.
 * - `memberships[0]` is used as today; true multi-organization switching is a
 *   separate P1 item and remains a documented limitation.
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

  const membership = session.user.memberships[0]
  if (!membership) return null

  const allLocations = membership.organization.stores.flatMap((store) => store.locations)
  const restricted = membership.allowedLocationIds ?? []
  const accessibleLocations =
    restricted.length === 0 ? allLocations : allLocations.filter((loc) => restricted.includes(loc.id))

  if (accessibleLocations.length === 0) return null

  return {
    userId: session.userId,
    orgId: membership.organizationId,
    locationId: accessibleLocations[0].id,
    role: membership.role,
    accessibleLocationIds: accessibleLocations.map((loc) => loc.id),
    user: session.user
  }
}

export type SessionContext = NonNullable<Awaited<ReturnType<typeof getSessionContext>>>

/** Location-level authorization check (E-11). */
export function canAccessLocation(context: SessionContext, locationId: string): boolean {
  return context.accessibleLocationIds.includes(locationId)
}
