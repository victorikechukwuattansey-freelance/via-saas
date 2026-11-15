import { prisma } from "@via-saas/database"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export async function GET() {
  const token = cookies().get("session_token")?.value
  const session = await prisma.session.findUnique({
    where: { token },
    include: { user: { include: { memberships: true } } }
  })

  const orgId = session?.user.memberships[0]?.organizationId
  if (!orgId) return NextResponse.json([])

  const products = await prisma.product.findMany({
    where: { organizationId: orgId },
    include: { variants: { include: { inventory: true } } }
  })

  return NextResponse.json(products)
}
