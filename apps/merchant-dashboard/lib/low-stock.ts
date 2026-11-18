import { prisma } from "@via-saas/database"

/**
 * P1-D / P1-21 low-stock indicators (plan §6.4) — read-time evaluation.
 *
 * There is NO persisted derived low-stock state: a variant is low at a
 * location when its current authoritative Inventory.quantity is
 * <= the variant's lowStockThreshold (PD-D6). NULL threshold never flags.
 * A threshold of 0 flags only out-of-stock rows (quantities are never
 * negative — the P1-19 guarded update forbids it).
 *
 * Authorization (R-9 / PD-AC14): the query is constrained to the actor's
 * accessibleLocationIds (org-resolved by the session) and re-verifies the
 * org via the variant's product organizationId (defense-in-depth). Archived
 * products and their variants are excluded (R-9, PD-AC34).
 *
 * Kept as plain functions so the evaluation/authorization rules are
 * unit-testable (PD-AC33/34) without rendering React — same discipline as
 * lib/orders.ts and lib/inventory-history.ts.
 */

export type LowStockEntry = {
  variantId: string
  variantName: string
  productId: string
  productName: string
  locationId: string
  locationName: string
  quantity: number
  threshold: number
}

/** Read-time rule (PD-D6/R-8): low iff quantity <= threshold; NULL never flags. */
export function isLowStock(quantity: number, threshold: number | null): boolean {
  return threshold !== null && quantity <= threshold
}

/**
 * Lists the org's low-stock variants across the actor's accessible
 * locations, evaluated at request time. Deterministic order
 * (productName, variantName, locationName) for stable UI rendering.
 */
export async function loadLowStock(params: {
  orgId: string
  accessibleLocationIds: string[]
}): Promise<LowStockEntry[]> {
  if (!params.orgId || params.accessibleLocationIds.length === 0) return []

  const rows = await prisma.inventory.findMany({
    where: {
      locationId: { in: params.accessibleLocationIds },
      variant: {
        // R-9: archived products and their variants are excluded; the
        // organizationId re-verification keeps the query tenant-scoped
        // even against a forged accessible-location list.
        lowStockThreshold: { not: null },
        product: { organizationId: params.orgId, archivedAt: null },
      },
    },
    select: {
      quantity: true,
      locationId: true,
      location: { select: { name: true } },
      variant: {
        select: {
          id: true,
          name: true,
          lowStockThreshold: true,
          product: { select: { id: true, name: true } },
        },
      },
    },
  })

  const entries: LowStockEntry[] = []
  for (const row of rows) {
    const threshold = row.variant.lowStockThreshold
    if (threshold === null) continue // NULL threshold never flags (PD-D6)
    if (row.quantity <= threshold) {
      entries.push({
        variantId: row.variant.id,
        variantName: row.variant.name,
        productId: row.variant.product.id,
        productName: row.variant.product.name,
        locationId: row.locationId,
        locationName: row.location.name,
        quantity: row.quantity,
        threshold,
      })
    }
  }

  entries.sort(
    (a, b) =>
      a.productName.localeCompare(b.productName) ||
      a.variantName.localeCompare(b.variantName) ||
      a.locationName.localeCompare(b.locationName)
  )
  return entries
}

/** Variant ids that currently have at least one low-stock row at the
 * accessible locations — used by the Products page badge/filter. */
export async function loadLowStockVariantIds(params: {
  orgId: string
  accessibleLocationIds: string[]
}): Promise<Set<string>> {
  const entries = await loadLowStock(params)
  return new Set(entries.map((entry) => entry.variantId))
}
