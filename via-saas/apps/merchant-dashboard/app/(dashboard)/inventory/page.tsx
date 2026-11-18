import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { loadInventoryHistoryPage } from "@/lib/inventory-history"
import { redirect } from "next/navigation"
import Link from "next/link"

/**
 * P1-D / P1-20: inventory movement history (plan §6.5).
 *
 * - The location filter offers ONLY the caller's accessible locations (E-11,
 *   PD-AC10); a tampered ?location= fails closed to an empty list via
 *   loadInventoryHistoryPage (PD-AC7/8).
 * - Typed reference display: SALE/RETURN → order link, initial creation
 *   → "Initial stock", legacy free text → plain text; unresolvable
 *   references render a safe fallback (PD-AC9).
 * - Bounded cursor pagination with deterministic ordering server-side
 *   (PD-AC35); this page only renders the loader's result.
 */
export default async function InventoryHistoryPage({
  searchParams,
}: {
  searchParams: { variant?: string; location?: string; cursor?: string }
}) {
  const context = await getSessionContext()
  if (!context) redirect("/login")

  // Accessible locations for the filter dropdown (E-11 resolution).
  const accessibleLocations = await prisma.location.findMany({
    where: { id: { in: context.accessibleLocationIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })

  // Variant filter options: the org's own variants (PD-AC7), newest last.
  const orgVariants = await prisma.productVariant.findMany({
    where: { product: { organizationId: context.orgId } },
    select: { id: true, name: true, product: { select: { name: true } } },
    orderBy: [{ product: { name: "asc" } }, { name: "asc" }],
  })

  const result = await loadInventoryHistoryPage({
    orgId: context.orgId,
    accessibleLocationIds: context.accessibleLocationIds,
    variantParam: searchParams?.variant ?? null,
    locationParam: searchParams?.location ?? null,
    cursorParam: searchParams?.cursor ?? null,
  })

  const { rows, nextCursor, variant } = result

  const buildPageUrl = (cursor?: string) => {
    const params = new URLSearchParams()
    if (searchParams?.variant) params.set("variant", searchParams.variant)
    if (searchParams?.location) params.set("location", searchParams.location)
    if (cursor) params.set("cursor", cursor)
    return `/inventory?${params.toString()}`
  }

  const typeLabels: Record<string, string> = {
    SALE: "Sale",
    RETURN: "Return",
    ADDED: "Added",
    REMOVED: "Removed",
    TRANSFER: "Transfer",
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Inventory History</h1>
        <p className="text-slate-500">
          {variant
            ? `Movements for ${variant.productName} — ${variant.name}.`
            : "Stock movement ledger across your accessible locations."}
        </p>
      </div>

      {/* Filters — location options restricted to accessible locations (E-11). */}
      <form className="flex items-center gap-2" action="/inventory" method="get">
        <select
          name="variant"
          defaultValue={searchParams?.variant ?? ""}
          className="border border-slate-300 rounded-md text-sm px-3 py-2 bg-white"
        >
          <option value="">All variants</option>
          {orgVariants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.product.name} — {v.name}
            </option>
          ))}
        </select>
        <select
          name="location"
          defaultValue={searchParams?.location ?? ""}
          className="border border-slate-300 rounded-md text-sm px-3 py-2 bg-white"
        >
          <option value="">All my locations</option>
          {accessibleLocations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="border border-slate-300 rounded-md text-sm px-3 py-2 hover:bg-slate-50"
        >
          Filter
        </button>
      </form>

      {(result.unauthorizedLocation || result.invalidVariant || result.invalidCursor) && (
        <p className="text-sm text-slate-500 italic">No matching history.</p>
      )}

      {rows.length === 0 ? (
        !result.unauthorizedLocation && !result.invalidVariant && !result.invalidCursor ? (
          <p className="text-sm text-slate-500 italic">No stock movements yet.</p>
        ) : null
      ) : (
        <>
          <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">When</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Type</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Quantity</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Product</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Location</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Actor</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-2 whitespace-nowrap text-slate-600">
                      {row.createdAt.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-slate-700">{typeLabels[row.type] ?? row.type}</td>
                    <td
                      className={
                        row.quantity < 0
                          ? "px-4 py-2 font-medium text-red-600"
                          : "px-4 py-2 font-medium text-green-600"
                      }
                    >
                      {row.quantity > 0 ? `+${row.quantity}` : row.quantity}
                    </td>
                    <td className="px-4 py-2 text-slate-700">
                      {row.productName} — {row.variantName}
                    </td>
                    <td className="px-4 py-2 text-slate-600">{row.locationName}</td>
                    <td className="px-4 py-2 text-slate-600">{row.actorName ?? "System"}</td>
                    <td className="px-4 py-2">
                      {row.reference.kind === "order" ? (
                        <Link
                          href={row.reference.href}
                          className="text-blue-600 hover:underline"
                        >
                          {row.reference.label}
                        </Link>
                      ) : row.reference.kind === "count" ? (
                        /* P1-22: a corrective stock-count movement links to
                           the count detail. */
                        <Link
                          href={row.reference.href}
                          className="text-blue-600 hover:underline"
                        >
                          {row.reference.label}
                        </Link>
                      ) : row.reference.kind === "initial" ? (
                        <span className="text-slate-400">{row.reference.label}</span>
                      ) : (
                        /* Safe fallback: legacy reason text or an
                           unresolvable reference renders as plain text. */
                        <span className="text-slate-600">{row.reference.label}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-4 text-sm">
            {nextCursor && (
              <Link
                href={buildPageUrl(nextCursor)}
                className="border border-slate-300 rounded-md px-3 py-2 hover:bg-slate-50"
              >
                Older movements →
              </Link>
            )}
            {searchParams?.cursor && (
              <Link href={buildPageUrl()} className="text-slate-500 hover:underline">
                Back to latest
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  )
}
