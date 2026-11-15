import { prisma } from "@via-saas/database"
import { getSessionContext } from "@/lib/auth-helpers"
import { NextResponse } from "next/server"

export async function GET() {
  // Centralized session + expiry + membership resolution (E-8).
  const context = await getSessionContext()
  if (!context) return NextResponse.json([])

  const products = await prisma.product.findMany({
    where: { organizationId: context.orgId },
    include: { variants: { include: { inventory: true } } }
  })

  return NextResponse.json(products)
}
