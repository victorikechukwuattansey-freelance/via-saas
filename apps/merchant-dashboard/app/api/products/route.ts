import { prisma } from "@via-saas/database"
import { getSessionContext } from "@/lib/auth-helpers"
import { NextResponse } from "next/server"

export async function GET() {
  // Centralized session + expiry + membership resolution (E-8).
  const context = await getSessionContext()
  if (!context) return NextResponse.json([])

  // POS publication contract (P1-A): the POS grid sells exactly what the
  // storefront can sell — PUBLISHED products that are not archived. Draft and
  // archived products never appear for sale; their history is untouched.
  const products = await prisma.product.findMany({
    where: {
      organizationId: context.orgId,
      status: "PUBLISHED",
      archivedAt: null,
    },
    include: { variants: { include: { inventory: true } } }
  })

  return NextResponse.json(products)
}
