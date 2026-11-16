/**
 * P1-B (B6 / P1-11): POS SKU/barcode scan-to-cart lookup.
 *
 * Contract (R4 §B6):
 *  - The lookup is EXACT and CASE-INSENSITIVE on SKU and barcode. There is
 *    deliberately NO partial/fuzzy search: scanning is exact-value matching.
 *  - Inputs are org-scoped products (the /api/products POS feed — the same
 *    PUBLISHED + non-archived set the storefront can sell); the feed already
 *    carries variant sku/barcode scalars, so no route change is needed.
 *  - Per-organization uniqueness (P1-A D-2) guarantees a non-null SKU or
 *    barcode is unique WITHIN its own column, but a scanned value can still
 *    match MORE THAN ONE variant when one variant's SKU equals another
 *    variant's barcode. Multi-match resolves deterministically (product
 *    name, then variant name) and reports `ambiguous: true` so the POS can
 *    surface an explicit notice instead of silently guessing.
 */

export type PosVariant = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  sellingPrice: string
  inventory: { quantity: number }[]
}

export type PosProduct = {
  id: string
  name: string
  variants: PosVariant[]
}

export type PosSearchResult =
  | { found: true; ambiguous: boolean; notice: string | null; variant: PosVariant; product: PosProduct }
  | { found: false }

/**
 * Finds the variant matching an exact SKU or barcode (case-insensitive).
 * Returns not-found for blank input; never throws.
 */
export function findVariantByCode(
  products: PosProduct[],
  rawCode: string
): PosSearchResult {
  const code = rawCode.trim().toLowerCase()
  if (!code) return { found: false }

  const matches: { product: PosProduct; variant: PosVariant }[] = []
  for (const product of products) {
    for (const variant of product.variants) {
      const sku = variant.sku?.trim().toLowerCase() ?? null
      const barcode = variant.barcode?.trim().toLowerCase() ?? null
      if (sku === code || barcode === code) {
        matches.push({ product, variant })
      }
    }
  }

  if (matches.length === 0) return { found: false }

  // Deterministic resolution: product name, then variant name (both
  // case-insensitive, stable tiebreak on variant id).
  matches.sort((a, b) => {
    const byProduct = a.product.name.localeCompare(b.product.name, undefined, {
      sensitivity: "base",
    })
    if (byProduct !== 0) return byProduct
    const byVariant = a.variant.name.localeCompare(b.variant.name, undefined, {
      sensitivity: "base",
    })
    if (byVariant !== 0) return byVariant
    return a.variant.id.localeCompare(b.variant.id)
  })

  const chosen = matches[0]
  const ambiguous = matches.length > 1

  return {
    found: true,
    ambiguous,
    notice: ambiguous
      ? `Warning: "${rawCode.trim()}" matches ${matches.length} variants. Added the first match (${chosen.product.name} — ${chosen.variant.name}).`
      : null,
    variant: chosen.variant,
    product: chosen.product,
  }
}
