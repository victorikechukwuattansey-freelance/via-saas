import { getSessionContext } from "@/lib/auth-helpers"
import { loadStockCountsPage } from "@/lib/stock-counts"
import { redirect } from "next/navigation"
import Link from "next/link"
import { OpenCountForm } from "./OpenCountForm"

/**
 * P1-D / P1-22: stock count list (plan §6.3, PD-AC16).
 *
 * - The loader derives the caller's role from their Membership row, so a
 *   STAFF member sees neither counts nor location lists (the sidebar hides
 *   the entry too; this is the server-side control).
 * - Filters and pagination are server-side and fail closed: an out-of-scope
 *   ?location= or a malformed cursor renders an empty list, never an error.
 */
export default async function StockCountsPage({
  searchParams,
}: {
  searchParams: { status?: string; location?: string; cursor?: string }
}) {
  const context = await getSessionContext()
  if (!context) redirect("/login")

  const page = await loadStockCountsPage({
    orgId: context.orgId,
    actorId: context.userId,
    statusParam: searchParams?.status ?? null,
    locationParam: searchParams?.location ?? null,
    cursorParam: searchParams?.cursor ?? null,
  })

  if (!page.authorized) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Stock Counts</h1>
        <p className="text-sm text-slate-500">
          You do not have access to stock counts. Ask an Owner or Manager if you need them.
        </p>
      </div>
    )
  }

  const buildPageUrl = (cursor?: string) => {
    const params = new URLSearchParams()
    if (searchParams?.status) params.set("status", searchParams.status)
    if (searchParams?.location) params.set("location", searchParams.location)
    if (cursor) params.set("cursor", cursor)
    const query = params.toString()
    return query ? `/stock-counts?${query}` : "/stock-counts"
  }

  const statusStyles: Record<string, string> = {
    OPEN: "bg-blue-50 text-blue-700 border-blue-200",
    APPROVED: "bg-green-50 text-green-700 border-green-200",
    CANCELLED: "bg-slate-100 text-slate-600 border-slate-200",
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Stock Counts</h1>
        <p className="text-slate-500">
          Physical counts per location. Approving a count corrects inventory to the counted
          quantities.
        </p>
      </div>

      <OpenCountForm locations={page.openableLocations} />

      <form className="flex items-center gap-2" action="/stock-counts" method="get">
        <select
          name="status"
          defaultValue={searchParams?.status ?? ""}
          className="border border-slate-300 rounded-md text-sm px-3 py-2 bg-white"
        >
          <option value="">All statuses</option>
          <option value="OPEN">Open</option>
          <option value="APPROVED">Approved</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select
          name="location"
          defaultValue={searchParams?.location ?? ""}
          className="border border-slate-300 rounded-md text-sm px-3 py-2 bg-white"
        >
          <option value="">All my locations</option>
          {page.filterLocations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
              {location.archived ? " (archived)" : ""}
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

      {(page.unauthorizedLocation || page.invalidStatus || page.invalidCursor) && (
        <p className="text-sm text-slate-500 italic">No matching stock counts.</p>
      )}

      {page.rows.length === 0 ? (
        !page.unauthorizedLocation && !page.invalidStatus && !page.invalidCursor ? (
          <p className="text-sm text-slate-500 italic">No stock counts yet.</p>
        ) : null
      ) : (
        <>
          <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Count</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Location</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Opened</th>
                  <th className="px-4 py-2 text-right font-medium text-slate-500">Counted</th>
                  <th className="px-4 py-2 text-left font-medium text-slate-500">Opened by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {page.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-2">
                      <Link href={`/stock-counts/${row.id}`} className="text-blue-600 hover:underline">
                        #{row.countNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {row.locationName}
                      {row.locationArchived && (
                        <span className="ml-2 text-xs text-amber-700">archived</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${
                          statusStyles[row.status] ?? "bg-slate-100 text-slate-600 border-slate-200"
                        }`}
                      >
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-slate-600">
                      {row.openedAt.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">
                      {row.countedLines}/{row.lineCount}
                    </td>
                    <td className="px-4 py-2 text-slate-600">{row.createdByName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-4 text-sm">
            {page.nextCursor && (
              <Link
                href={buildPageUrl(page.nextCursor)}
                className="border border-slate-300 rounded-md px-3 py-2 hover:bg-slate-50"
              >
                Older counts →
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
