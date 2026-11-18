import { getSessionContext } from "@/lib/auth-helpers"
import { loadStockCountDetail } from "@/lib/stock-counts"
import { notFound } from "next/navigation"
import Link from "next/link"
import { CountEntryForm } from "./CountEntryForm"

/**
 * P1-D / P1-22: stock count detail — entry, approval, cancellation (§6.3).
 *
 * Authorization is entirely server-side (PD-AC16/PD-AC21):
 *  - loadStockCountDetail derives the role from the Membership row and scopes
 *    the query to the organization AND the caller's permitted locations.
 *  - A STAFF caller, a cross-organization id, a nonexistent id, and an
 *    inaccessible location all resolve to null → notFound(). The four cases
 *    are indistinguishable, so no count existence leaks.
 */
export default async function StockCountDetailPage({ params }: { params: { countId: string } }) {
  const context = await getSessionContext()
  if (!context) notFound()

  const loaded = await loadStockCountDetail({
    orgId: context.orgId,
    actorId: context.userId,
    countId: params.countId,
  })
  if (!loaded) notFound()

  const { count, lines } = loaded
  const isOpen = count.status === "OPEN"
  const hasArchivedProduct = lines.some((line) => line.productArchived)
  const counted = lines.filter((line) => line.countedQty !== null).length

  return (
    <div className="space-y-6">
      <div>
        <Link href="/stock-counts" className="text-sm text-blue-600 hover:underline">
          ← Back to stock counts
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Stock Count #{count.countNumber}</h1>
        <p className="text-slate-500">
          {count.locationName}
          {count.locationArchived ? " (archived)" : ""} · {count.status} · opened{" "}
          {count.openedAt.toLocaleString()}
          {count.createdByName ? ` by ${count.createdByName}` : ""}
        </p>
        <p className="text-sm text-slate-500">
          {counted}/{lines.length} lines counted
          {count.approvedAt
            ? ` · approved ${count.approvedAt.toLocaleString()}${
                count.approvedByName ? ` by ${count.approvedByName}` : ""
              }`
            : ""}
          {count.cancelledAt ? ` · cancelled ${count.cancelledAt.toLocaleString()}` : ""}
        </p>
      </div>

      {isOpen && count.locationArchived && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          This count&apos;s location is archived, so the count cannot be approved. It can still be
          cancelled.
        </p>
      )}
      {isOpen && hasArchivedProduct && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          A product in this count has been archived. Restore it before approving, or cancel the
          count.
        </p>
      )}

      {lines.length === 0 ? (
        <p className="text-sm text-slate-500 italic">
          This count has no lines: the location held no inventory when it opened.
        </p>
      ) : isOpen ? (
        <CountEntryForm countId={count.id} lines={lines} />
      ) : (
        <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-slate-500">Product</th>
                <th className="px-4 py-2 text-left font-medium text-slate-500">SKU</th>
                <th className="px-4 py-2 text-right font-medium text-slate-500">Expected</th>
                <th className="px-4 py-2 text-right font-medium text-slate-500">Counted</th>
                <th className="px-4 py-2 text-right font-medium text-slate-500">Current</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="px-4 py-2 text-slate-700">
                    {line.productName} — {line.variantName}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{line.sku ?? "—"}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{line.expectedQty}</td>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {line.countedQty ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-slate-600">{line.currentQty ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
