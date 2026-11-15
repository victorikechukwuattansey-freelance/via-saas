import { prisma } from "@via-saas/database"
import { cookies } from "next/headers"

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

  if (!session || !session.user.memberships[0]) return null

  const membership = session.user.memberships[0]
  
  return {
    userId: session.userId,
    orgId: membership.organizationId,
    locationId: membership.organization.stores[0].locations[0].id,
    role: membership.role,
    user: session.user
  }
}
