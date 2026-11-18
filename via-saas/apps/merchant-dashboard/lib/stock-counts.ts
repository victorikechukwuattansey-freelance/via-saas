import { prisma } from "@via-saas/database"
import type { Prisma, StockCountStatus } from "@prisma/client"

/**
 * P1-D / P1-22 data loaders for the stock-count surfaces (plan §6.3).
 *
 * Kept as plain functions so the authorization/pagination rules are
 * unit-testable (PD-AC16, PD-AC21, PD-AC35) without rendering React — the
 * same discipline as lib/orders.ts and lib/inventory-history.ts.
 *
 * AUTHORIZATION MODEL (plan §7, PD-D2/PD-AC16):
 * - The acting role is read from the caller's Membership row SERVER-SIDE
 *   inside each loader. It is never accepted as an argument, so no caller can
 *   claim OWNER. A STAFF member (or a non-member) gets no count data at all —
 *   view and manage are both denied, and the denial is indistinguishable from
 *   "nothing to show" so no organization/count existence leaks (PD-AC21).
 * - Location scope: a membership carrying a non-empty `allowedLocationIds`
 *   list is restricted to those locations (E-11). An empty list means
 *   "unrestricted within the organization".
 * - Counts are HISTORICAL records, so the list/detail scope deliberately does
 *   NOT filter on `Location.archivedAt`: an approved count at a location that
 *   was archived afterwards must stay auditable, and a count that was OPEN
 *   when its location was archived must stay reachable so it can still be
 *   cancelled (approval of it is rejected by the core, cancellation is not).
 *   Archival only removes a location from the "open a new count here" list.
 * - Every query is organization-scoped through the count's own
 *   `organizationId`, so a forged count id from another organization resolves
 *   to null exactly like a nonexistent id (no existence leak).
 */

export const STOCK_COUNTS_PAGE_SIZE = 20
export const STOCK_COUNTS_MAX_PAGE_SIZE = 50

/** Deterministic ordering: newest first, id as the tiebreak so equal
 * timestamps can never shuffle between pages (PD-AC35 discipline). */
export const STOCK_COUNTS_ORDER_BY = [
  { openedAt: "desc" as const },
  { id: "desc" as const },
]

const COUNT_MANAGER_ROLES = ["OWNER", "MANAGER"] as const

const STATUSES: StockCountStatus[] = ["OPEN", "APPROVED", "CANCELLED"]

/**
 * Cursor encoding: "<openedAt ISO>__<count id>". Count ids are cuids (no
 * "__") and ISO timestamps contain no "__", so one split is unambiguous and
 * the round-trip is lossless.
 */
export function encodeCountsCursor(row: { openedAt: Date; id: string }): string {
  return `${row.openedAt.toISOString()}__${row.id}`
}

/**
 * Parses a raw cursor. Absent, malformed, or fabricated cursors return null
 * and the caller fails closed to an empty page — never a 500, never an
 * unbounded query.
 */
export function parseCountsCursor(raw: string | undefined | null): {
  openedAt: Date
  id: string
} | null {
  if (raw === undefined || raw === null || raw === "") return null
  if (raw.length > 512) return null
  const separator = raw.lastIndexOf("__")
  if (separator <= 0 || separator === raw.length - 2) return null
  const idPart = raw.slice(separator + 2)
  if (!idPart) return null
  const openedAt = new Date(raw.slice(0, separator))
  if (Number.isNaN(openedAt.getTime())) return null
  return { openedAt, id: idPart }
}

/** Bounded page size: <1 or unparseable falls back to the default, anything
 * above the fixed maximum is clamped. */
export function parseCountsPageSizeParam(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return STOCK_COUNTS_PAGE_SIZE
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) return STOCK_COUNTS_PAGE_SIZE
  return Math.min(parsed, STOCK_COUNTS_MAX_PAGE_SIZE)
}

/** Recognizes only the three real statuses; anything else is reported as an
 * invalid filter (the caller renders an empty list rather than everything). */
export function parseCountsStatusParam(raw: string | undefined | null): {
  status: StockCountStatus | null
  invalid: boolean
} {
  if (raw === undefined || raw === null || raw === "") return { status: null, invalid: false }
  if ((STATUSES as string[]).includes(raw)) {
    return { status: raw as StockCountStatus, invalid: false }
  }
  return { status: null, invalid: true }
}

export type CountsViewer = {
  role: "OWNER" | "MANAGER"
  /** Empty = unrestricted within the organization. */
  allowedLocationIds: string[]
}

/**
 * Reads the caller's membership for this organization and applies the
 * OWNER/MANAGER rule. Returns null for a non-member AND for a STAFF member —
 * the two cases are deliberately indistinguishable to the caller.
 */
export async function resolveCountsViewer(
  orgId: string,
  actorId: string
): Promise<CountsViewer | null> {
  const membership = await prisma.membership.findFirst({
    where: { userId: actorId, organizationId: orgId },
    select: { role: true, allowedLocationIds: true },
  })
  if (!membership) return null
  if (!(COUNT_MANAGER_ROLES as readonly string[]).includes(membership.role)) return null
  return {
    role: membership.role as CountsViewer["role"],
    allowedLocationIds: membership.allowedLocationIds,
  }
}

/** Applies the membership's location restriction to a location id. */
export function viewerCanAccessLocation(viewer: CountsViewer, locationId: string): boolean {
  return viewer.allowedLocationIds.length === 0 || viewer.allowedLocationIds.includes(locationId)
}

export type StockCountListRow = {
  id: string
  countNumber: number
  status: StockCountStatus
  locationId: string
  locationName: string
  locationArchived: boolean
  openedAt: Date
  approvedAt: Date | null
  cancelledAt: Date | null
  createdByName: string | null
  approvedByName: string | null
  lineCount: number
  countedLines: number
}

export type StockCountListPage = {
  /** False when the caller is not an OWNER/MANAGER of this organization. */
  authorized: boolean
  rows: StockCountListRow[]
  nextCursor: string | null
  pageSize: number
  /** Filter parameters echo for the form. */
  status: StockCountStatus | null
  location: string | null
  invalidStatus: boolean
  /** A ?location= outside the caller's scope: fails closed, exposes nothing. */
  unauthorizedLocation: boolean
  invalidCursor: boolean
  /** Locations the caller may OPEN a count at: accessible + still active. */
  openableLocations: { id: string; name: string }[]
  /** Locations the caller may filter by: accessible (archived included). */
  filterLocations: { id: string; name: string; archived: boolean }[]
}

const EMPTY_PAGE: StockCountListPage = {
  authorized: true,
  rows: [],
  nextCursor: null,
  pageSize: STOCK_COUNTS_PAGE_SIZE,
  status: null,
  location: null,
  invalidStatus: false,
  unauthorizedLocation: false,
  invalidCursor: false,
  openableLocations: [],
  filterLocations: [],
}

/**
 * Loads one bounded page of the organization's stock counts.
 *
 * Pagination is keyset-based with a fixed maximum page size; the "+1 row"
 * read detects the next page without a count query (PD-AC35 discipline).
 * Line totals are resolved with ONE batched groupBy for the whole page, so
 * the list never issues a per-row query.
 */
export async function loadStockCountsPage(params: {
  orgId: string
  actorId: string
  statusParam?: string | null
  locationParam?: string | null
  cursorParam?: string | null
  pageSizeParam?: string | null
}): Promise<StockCountListPage> {
  const pageSize = parseCountsPageSizeParam(params.pageSizeParam)
  const { status, invalid } = parseCountsStatusParam(params.statusParam)
  const cursor = parseCountsCursor(params.cursorParam)
  const invalidCursor = Boolean(params.cursorParam) && cursor === null

  const viewer = await resolveCountsViewer(params.orgId, params.actorId)
  if (!viewer) {
    // STAFF / non-member: no rows and no location lists — nothing leaks.
    return { ...EMPTY_PAGE, authorized: false, pageSize }
  }

  const locations = await prisma.location.findMany({
    where: { store: { organizationId: params.orgId } },
    select: { id: true, name: true, archivedAt: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  })
  const scoped = locations.filter((location) => viewerCanAccessLocation(viewer, location.id))
  const scopedIds = scoped.map((location) => location.id)

  const openableLocations = scoped
    .filter((location) => location.archivedAt === null)
    .map((location) => ({ id: location.id, name: location.name }))
  const filterLocations = scoped.map((location) => ({
    id: location.id,
    name: location.name,
    archived: location.archivedAt !== null,
  }))

  const locationParam = params.locationParam ?? null
  const unauthorizedLocation = Boolean(locationParam) && !scopedIds.includes(locationParam as string)

  const base: StockCountListPage = {
    ...EMPTY_PAGE,
    pageSize,
    status,
    location: locationParam,
    invalidStatus: invalid,
    unauthorizedLocation,
    invalidCursor,
    openableLocations,
    filterLocations,
  }
  if (invalid || invalidCursor || unauthorizedLocation) return base

  const where: Prisma.StockCountWhereInput = {
    organizationId: params.orgId,
    locationId: { in: locationParam ? [locationParam] : scopedIds },
    ...(status ? { status } : {}),
    ...(cursor
      ? {
          OR: [
            { openedAt: { lt: cursor.openedAt } },
            { openedAt: cursor.openedAt, id: { lt: cursor.id } },
          ],
        }
      : {}),
  }

  const fetched = await prisma.stockCount.findMany({
    where,
    orderBy: STOCK_COUNTS_ORDER_BY,
    take: pageSize + 1,
    include: {
      location: { select: { name: true, archivedAt: true } },
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  })

  const hasMore = fetched.length > pageSize
  const counts = hasMore ? fetched.slice(0, pageSize) : fetched

  // ONE batched query for every page row's counted-line total (no N+1).
  const countedByCount = new Map<string, number>()
  if (counts.length > 0) {
    const grouped = await prisma.stockCountLine.groupBy({
      by: ["countId"],
      where: {
        countId: { in: counts.map((count) => count.id) },
        countedQty: { not: null },
      },
      _count: { _all: true },
    })
    for (const group of grouped) {
      countedByCount.set(group.countId, group._count._all)
    }
  }

  const rows: StockCountListRow[] = counts.map((count) => ({
    id: count.id,
    countNumber: count.countNumber,
    status: count.status,
    locationId: count.locationId,
    locationName: count.location.name,
    locationArchived: count.location.archivedAt !== null,
    openedAt: count.openedAt,
    approvedAt: count.approvedAt,
    cancelledAt: count.cancelledAt,
    createdByName: count.createdBy?.name ?? null,
    approvedByName: count.approvedBy?.name ?? null,
    lineCount: count._count.lines,
    countedLines: countedByCount.get(count.id) ?? 0,
  }))

  return {
    ...base,
    rows,
    nextCursor:
      hasMore && rows.length > 0 ? encodeCountsCursor(rows[rows.length - 1]) : null,
  }
}

export type StockCountDetailLine = {
  id: string
  variantId: string
  productName: string
  variantName: string
  sku: string | null
  productArchived: boolean
  /** Opening snapshot — never updated after the count opens (PD-AC29). */
  expectedQty: number
  /** The physical observation; null until entered. */
  countedQty: number | null
  /** Current authoritative balance at the count's location (display only). */
  currentQty: number | null
}

export type StockCountDetail = {
  count: {
    id: string
    countNumber: number
    status: StockCountStatus
    organizationId: string
    locationId: string
    locationName: string
    locationArchived: boolean
    openedAt: Date
    approvedAt: Date | null
    cancelledAt: Date | null
    createdByName: string | null
    approvedByName: string | null
  }
  lines: StockCountDetailLine[]
}

/**
 * Loads one count with its lines, scoped to the organization AND to the
 * caller's permitted locations. A cross-organization id, a nonexistent id,
 * an inaccessible location, and a STAFF caller all resolve to null — the
 * caller renders notFound() for every one of them (no existence leak).
 */
export async function loadStockCountDetail(params: {
  orgId: string
  actorId: string
  countId: string
}): Promise<StockCountDetail | null> {
  const viewer = await resolveCountsViewer(params.orgId, params.actorId)
  if (!viewer) return null

  const count = await prisma.stockCount.findFirst({
    where: { id: params.countId, organizationId: params.orgId },
    include: {
      location: { select: { name: true, archivedAt: true } },
      createdBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  })
  if (!count) return null
  if (!viewerCanAccessLocation(viewer, count.locationId)) return null

  const lines = await prisma.stockCountLine.findMany({
    where: { countId: count.id },
    include: {
      variant: {
        select: { name: true, sku: true, product: { select: { name: true, archivedAt: true } } },
      },
    },
    orderBy: [{ variant: { name: "asc" } }, { id: "asc" }],
  })

  // ONE batched read for the current balances of every line's variant.
  const inventories = await prisma.inventory.findMany({
    where: {
      locationId: count.locationId,
      variantId: { in: lines.map((line) => line.variantId) },
    },
    select: { variantId: true, quantity: true },
  })
  const currentByVariant = new Map(inventories.map((row) => [row.variantId, row.quantity]))

  return {
    count: {
      id: count.id,
      countNumber: count.countNumber,
      status: count.status,
      organizationId: count.organizationId,
      locationId: count.locationId,
      locationName: count.location.name,
      locationArchived: count.location.archivedAt !== null,
      openedAt: count.openedAt,
      approvedAt: count.approvedAt,
      cancelledAt: count.cancelledAt,
      createdByName: count.createdBy?.name ?? null,
      approvedByName: count.approvedBy?.name ?? null,
    },
    lines: lines.map((line) => ({
      id: line.id,
      variantId: line.variantId,
      productName: line.variant.product.name,
      variantName: line.variant.name,
      sku: line.variant.sku,
      productArchived: line.variant.product.archivedAt !== null,
      expectedQty: line.expectedQty,
      countedQty: line.countedQty,
      currentQty: currentByVariant.get(line.variantId) ?? null,
    })),
  }
}
