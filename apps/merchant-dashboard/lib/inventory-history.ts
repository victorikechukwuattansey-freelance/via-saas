import { prisma } from "@via-saas/database"
import type { Prisma, StockMovement } from "@prisma/client"

/**
 * P1-D / P1-20 data loader for the inventory history page (plan §6.5).
 *
 * Kept as plain functions so the pagination/filtering/authorization rules
 * are unit-testable (PD-AC7..PD-AC11, PD-AC35) without rendering React —
 * same discipline as lib/orders.ts (B-AC27/B-AC28).
 *
 * Authorization model (plan §6.5, R-7 — BOTH query stages):
 * - The movement query is tenant-scoped through the movement's
 *   location → store → organization chain AND location-constrained to the
 *   actor's accessibleLocationIds — a STAFF member sees only their explicitly
 *   accessible locations (PD-AC8/10), and a forged location id can never
 *   expose another organization's ledger (F4 defense-in-depth predicate).
 * - The reference-resolution query (orders) is org-scoped AND
 *   location-constrained to the same accessible set, so resolution can never
 *   leak a cross-org or inaccessible-location record (PD-AC9). A reference
 *   that does not resolve renders a safe fallback instead of failing.
 *
 * Pagination (R-7, PD-AC35): bounded cursor pagination with a FIXED maximum
 * page size and deterministic keyset ordering (createdAt DESC, id DESC —
 * the id tiebreak makes equal-timestamp rows stable across pages).
 * Reference resolution (R-7, PD-AC9): ONE batched findMany({ id: { in } })
 * per page for the page's resolvable references — never a per-row lookup.
 * P1-22 count references (ADDED/REMOVED with referenceId = count id) are
 * resolved by a second batched probe in the same page; a reference that is
 * not a count id of this organization falls back to the legacy reason text.
 */

export const INVENTORY_HISTORY_PAGE_SIZE = 25
export const INVENTORY_HISTORY_MAX_PAGE_SIZE = 50

/** Deterministic ordering (PD-AC35): createdAt desc + id tiebreaker, so
 * equal-timestamp rows can never shuffle between pages. */
export const INVENTORY_HISTORY_ORDER_BY = [
  { createdAt: "desc" as const },
  { id: "desc" as const },
]

/**
 * Cursor encoding: "<createdAt ISO>__<movement id>". Movement ids are cuids
 * (no "__" in them) and the ISO timestamp contains no "__", so a single
 * split is unambiguous. All StockMovement.createdAt values are written
 * client-side by Prisma at millisecond precision, so the ISO round-trip is
 * lossless and the keyset predicate reproduces the page order exactly.
 */
export function encodeHistoryCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}__${row.id}`
}

/**
 * Parses a raw cursor parameter. Returns null for absent, malformed, or
 * fabricated cursors — the caller fails closed to an empty page (never a
 * 500, never an unbounded query; same fail-closed discipline as
 * parseOrdersPageParam's clamp).
 */
export function parseHistoryCursor(raw: string | undefined | null): {
  createdAt: Date
  id: string
} | null {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw !== "string" || raw.length > 512) return null
  const separator = raw.lastIndexOf("__")
  if (separator <= 0 || separator === raw.length - 2) return null
  const stampPart = raw.slice(0, separator)
  const idPart = raw.slice(separator + 2)
  if (!idPart) return null
  const createdAt = new Date(stampPart)
  if (Number.isNaN(createdAt.getTime())) return null
  return { createdAt, id: idPart }
}

/**
 * Parses the page-size parameter into a bounded value. Non-numeric or <1
 * falls back to the default; anything above the fixed maximum is clamped —
 * a client can never request an unbounded page.
 */
export function parseHistoryPageSizeParam(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return INVENTORY_HISTORY_PAGE_SIZE
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) return INVENTORY_HISTORY_PAGE_SIZE
  return Math.min(parsed, INVENTORY_HISTORY_MAX_PAGE_SIZE)
}

/** Typed reference display (§6.5): each possible rendering of a movement's
 * referenceId. `unresolved` is the safe fallback (plain text) for deleted,
 * foreign, or legacy-garbage references — it never fails the page. */
export type HistoryReference =
  | { kind: "order"; label: string; href: string }
  | { kind: "count"; label: string; href: string }
  | { kind: "initial"; label: "Initial stock" }
  | { kind: "reason"; label: string }
  | { kind: "unresolved"; label: string }

export type HistoryRow = {
  id: string
  type: StockMovement["type"]
  quantity: number
  createdAt: Date
  /** Actor's display name; null for system-origin movements (storefront). */
  actorName: string | null
  variantName: string
  productName: string
  locationName: string
  reference: HistoryReference
}

export type InventoryHistoryPage = {
  rows: HistoryRow[]
  /** Cursor for the next (older) page; null when this is the last page. */
  nextCursor: string | null
  pageSize: number
  /** The filtered variant (org-verified), or null for the unfiltered view. */
  variant: { id: string; name: string; productName: string } | null
  /** Fail-closed flags (B-AC28 discipline): tampered params expose nothing. */
  unauthorizedLocation: boolean
  invalidVariant: boolean
  invalidCursor: boolean
}

const MOVEMENT_INCLUDE = {
  actor: { select: { name: true } },
  variant: { select: { name: true, product: { select: { name: true } } } },
  location: { select: { name: true } },
} satisfies Prisma.StockMovementInclude

/** The movement row shape the loader returns (relations narrowed). */
type MovementWithRelations = Prisma.StockMovementGetPayload<{
  include: typeof MOVEMENT_INCLUDE
}>

/**
 * Resolves the page's SALE/RETURN order references in ONE batched query
 * (R-7, PD-AC9): findMany({ id: { in } }), org-scoped and
 * location-constrained to the actor's accessible locations. References that
 * miss (deleted, cross-org, inaccessible-location, or legacy junk) fall back
 * to plain text — no existence leak, no per-row lookups, no N+1.
 */
async function resolveOrderReferences(
  orgId: string,
  accessibleLocationIds: string[],
  orderIds: string[]
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>()
  if (orderIds.length === 0) return resolved

  const orders = await prisma.order.findMany({
    where: {
      id: { in: orderIds },
      organizationId: orgId,
      locationId: { in: accessibleLocationIds },
    },
    select: { id: true, orderNumber: true },
  })
  for (const order of orders) {
    resolved.set(order.id, order.orderNumber)
  }
  return resolved
}

/**
 * Resolves the page's ADDED/REMOVED count references in ONE batched query
 * (P1-22, PD-AC24): findMany({ id: { in } }), organization-scoped and
 * location-constrained to the same accessible set. A reference that is not a
 * count id of this organization (legacy free-text reason) resolves to nothing
 * and renders as plain text — no existence leak, no per-row lookups.
 */
async function resolveCountReferences(
  orgId: string,
  accessibleLocationIds: string[],
  countIds: string[]
): Promise<Map<string, number>> {
  const resolved = new Map<string, number>()
  if (countIds.length === 0) return resolved

  const counts = await prisma.stockCount.findMany({
    where: {
      id: { in: countIds },
      organizationId: orgId,
      locationId: { in: accessibleLocationIds },
    },
    select: { id: true, countNumber: true },
  })
  for (const count of counts) {
    resolved.set(count.id, count.countNumber)
  }
  return resolved
}

/** Builds the typed reference display for one movement (§6.5 rules). */
function buildReference(
  movement: Pick<StockMovement, "type" | "referenceId">,
  orderNumbers: Map<string, string>,
  countNumbers: Map<string, number>
): HistoryReference {
  if (movement.referenceId === null) {
    // Initial-creation movements (P1-D PD-D3) carry referenceId: null.
    if (movement.type === "ADDED") return { kind: "initial", label: "Initial stock" }
    // A legacy SALE/RETURN/REMOVED row with no reference is an anomaly —
    // safe neutral fallback.
    return { kind: "unresolved", label: "—" }
  }
  if (movement.type === "SALE" || movement.type === "RETURN") {
    const orderNumber = orderNumbers.get(movement.referenceId)
    if (orderNumber) {
      return { kind: "order", label: `Order ${orderNumber}`, href: `/orders/${movement.referenceId}` }
    }
    // Deleted/foreign/legacy-text reference → safe plain-text fallback.
    return { kind: "unresolved", label: movement.referenceId }
  }
  // ADDED/REMOVED: a resolved count id links to the count detail; anything
  // else (legacy manual-adjustment reason) renders as plain text.
  const countNumber = countNumbers.get(movement.referenceId)
  if (countNumber !== undefined) {
    return {
      kind: "count",
      label: `Stock count #${countNumber}`,
      href: `/stock-counts/${movement.referenceId}`,
    }
  }
  return { kind: "reason", label: movement.referenceId }
}

/**
 * Loads one bounded page of the org's inventory movement history.
 *
 * AUTHORIZATION (PD-AC7/8/10): the movement query is constrained to the
 * actor's accessibleLocationIds. A tampered ?location= outside that set
 * fails closed to an empty page; a tampered ?variant= that is not an
 * org-owned variant fails closed to an empty page.
 */
export async function loadInventoryHistoryPage(params: {
  orgId: string
  accessibleLocationIds: string[]
  variantParam?: string | null
  locationParam?: string | null
  cursorParam?: string | null
  pageSizeParam?: string | null
}): Promise<InventoryHistoryPage> {
  const pageSize = parseHistoryPageSizeParam(params.pageSizeParam)

  const unauthorizedLocation = Boolean(params.locationParam) &&
    !params.accessibleLocationIds.includes(params.locationParam as string)

  // Org-scoped variant verification (PD-AC7): a cross-org or nonexistent
  // variant id filters nothing and exposes nothing.
  let variant: InventoryHistoryPage["variant"] = null
  let invalidVariant = false
  if (params.variantParam) {
    const found = await prisma.productVariant.findFirst({
      where: { id: params.variantParam, product: { organizationId: params.orgId } },
      select: { id: true, name: true, product: { select: { name: true } } },
    })
    if (found) {
      variant = { id: found.id, name: found.name, productName: found.product.name }
    } else {
      invalidVariant = true
    }
  }

  const cursor = parseHistoryCursor(params.cursorParam)
  const invalidCursor = Boolean(params.cursorParam) && cursor === null

  const empty: InventoryHistoryPage = {
    rows: [],
    nextCursor: null,
    pageSize,
    variant,
    unauthorizedLocation,
    invalidVariant,
    invalidCursor,
  }
  if (unauthorizedLocation || invalidVariant || invalidCursor) return empty

  const where: Prisma.StockMovementWhereInput = {
    // F4 closure (defense in depth): the ledger is org-bounded through its
    // location → store → organization chain, so a movement can never be read
    // even if a caller passed a location id outside the caller's org. The
    // accessible-location constraint below remains the primary restriction
    // (PD-AC8/AC10) — this predicate narrows, never broadens.
    location: { store: { organizationId: params.orgId } },
    locationId: { in: params.accessibleLocationIds },
    ...(variant ? { variantId: variant.id } : {}),
    ...(cursor
      ? {
          // Keyset continuation (createdAt DESC, id DESC): strictly older
          // than the cursor row, with the id tiebreak for equal timestamps.
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        }
      : {}),
  }

  // One row over the page size detects the next page without a count query.
  const fetched = await prisma.stockMovement.findMany({
    where,
    orderBy: INVENTORY_HISTORY_ORDER_BY,
    take: pageSize + 1,
    include: MOVEMENT_INCLUDE,
  })

  const hasMore = fetched.length > pageSize
  const movements = hasMore ? fetched.slice(0, pageSize) : fetched

  // Batched reference resolution for THIS page (R-7): collect the page's
  // resolvable candidate ids, then a single findMany({ id: { in } }).
  const orderIds = movements
    .filter((m) => (m.type === "SALE" || m.type === "RETURN") && m.referenceId !== null)
    .map((m) => m.referenceId as string)
  const orderNumbers = await resolveOrderReferences(
    params.orgId,
    params.accessibleLocationIds,
    orderIds
  )

  // P1-22: the same batched treatment for ADDED/REMOVED count references —
  // one probe per page, skipped entirely when the page has no candidates.
  const countIds = movements
    .filter((m) => (m.type === "ADDED" || m.type === "REMOVED") && m.referenceId !== null)
    .map((m) => m.referenceId as string)
  const countNumbers = await resolveCountReferences(
    params.orgId,
    params.accessibleLocationIds,
    countIds
  )

  const rows: HistoryRow[] = movements.map((m: MovementWithRelations) => ({
    id: m.id,
    type: m.type,
    quantity: m.quantity,
    createdAt: m.createdAt,
    actorName: m.actor?.name ?? null,
    variantName: m.variant.name,
    productName: m.variant.product.name,
    locationName: m.location.name,
    reference: buildReference(m, orderNumbers, countNumbers),
  }))

  return {
    rows,
    nextCursor: hasMore && rows.length > 0
      ? encodeHistoryCursor(rows[rows.length - 1])
      : null,
    pageSize,
    variant,
    unauthorizedLocation,
    invalidVariant,
    invalidCursor,
  }
}
