import { prisma } from "@via-saas/database"
import type { Order, StockMovement } from "@prisma/client"

/**
 * P1-B data loaders for the order list (B7) and detail page (B2).
 * Kept as plain functions so the pagination/filtering/authorization rules
 * are unit-testable (B-AC27/B-AC28) without rendering React.
 */

export const ORDERS_PAGE_SIZE = 20

/** Deterministic ordering (B-AC27): createdAt desc + id tiebreaker, so
 * equal-timestamp rows can never shuffle between pages. */
export const ORDERS_ORDER_BY = [{ createdAt: "desc" as const }, { id: "desc" as const }]

const ORDERS_LIST_INCLUDE = {
  items: {
    include: { variant: { include: { product: true } } },
  },
} as const

export type OrderWithItems = Order & {
  items: { variantId: string; quantity: number; unitPrice: unknown }[]
}

/**
 * Parses a raw page parameter. Non-numeric, negative, or absurd values are
 * coerced to page 1 server-side — never an unbounded query, never a 500.
 */
export function parseOrdersPageParam(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return 1
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  // Absurd values are clamped; the real bound is applied against totalPages.
  if (parsed > 1_000_000) return 1
  return parsed
}

/**
 * Loads one bounded page of the org's orders.
 *
 * AUTHORIZATION (B-AC28, E-11): the location filter offers only the caller's
 * accessible locations. A hand-tampered ?location= outside the accessible
 * set yields NO rows (fail closed) — unauthorized location ids cannot
 * expose orders.
 */
export async function loadOrdersPage(params: {
  orgId: string
  accessibleLocationIds: string[]
  pageParam?: string | null
  locationParam?: string | null
}) {
  const page = parseOrdersPageParam(params.pageParam)

  const where: { organizationId: string; locationId?: string } = {
    organizationId: params.orgId,
  }

  let unauthorizedLocation = false
  const locationParam = params.locationParam
  if (locationParam) {
    if (params.accessibleLocationIds.includes(locationParam)) {
      where.locationId = locationParam
    } else {
      // Fail closed: an unauthorized location id exposes nothing.
      unauthorizedLocation = true
    }
  }

  const total = unauthorizedLocation
    ? 0
    : await prisma.order.count({ where })

  const totalPages = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE))
  // Clamp the requested page into the real page range.
  const safePage = Math.min(page, totalPages)
  const orders = unauthorizedLocation
    ? []
    : await prisma.order.findMany({
        where,
        orderBy: ORDERS_ORDER_BY,
        take: ORDERS_PAGE_SIZE,
        skip: (safePage - 1) * ORDERS_PAGE_SIZE,
        include: ORDERS_LIST_INCLUDE,
      })

  return {
    orders,
    page: safePage,
    requestedPage: page,
    pageSize: ORDERS_PAGE_SIZE,
    total,
    totalPages,
    locationFiltered: Boolean(locationParam) && !unauthorizedLocation,
    unauthorizedLocation,
  }
}

export type OrderDetail = {
  order: Order & {
    items: {
      id: string
      variantId: string
      quantity: number
      unitPrice: unknown
      variant: { id: string; name: string; sku: string | null; barcode: string | null; product: { id: string; name: string } }
    }[]
    location: { id: string; name: string }
    customer: { id: string; name: string; phone: string | null } | null
  }
  movements: (StockMovement & { variant: { id: string; name: string } })[]
}

/**
 * Loads one order for the detail/receipt-record page.
 *
 * TENANT AUTHORIZATION (B-AC7): org-scoped findFirst — cross-org and
 * nonexistent ids fail closed with the NOT_FOUND pattern (no existence
 * leak): both return null.
 */
export async function loadOrderDetail(
  orgId: string,
  orderId: string
): Promise<OrderDetail | null> {
  if (!orderId || typeof orderId !== "string") return null

  const order = await prisma.order.findFirst({
    where: { id: orderId, organizationId: orgId },
    include: {
      items: {
        include: {
          variant: { include: { product: { select: { id: true, name: true } } } },
        },
      },
      location: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true, phone: true } },
    },
  })

  if (!order) return null

  // Stock movements for this order (SALE + RETURN), newest last.
  const movements = await prisma.stockMovement.findMany({
    where: { referenceId: order.id },
    include: { variant: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
  })

  return { order, movements }
}
