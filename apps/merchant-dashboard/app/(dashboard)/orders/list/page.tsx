import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { loadOrdersPage } from "@/lib/orders"
import { redirect } from "next/navigation"
import Link from "next/link"
import { ResolveButton } from "./ResolveButton"
import { VoidButton } from "../components/VoidButton"
import { RecordPaymentButton } from "../components/RecordPaymentButton"

/**
 * P1-B (B7): bounded, paginated order list with a location filter.
 *
 * - Pagination is bounded server-side (ORDERS_PAGE_SIZE, deterministic
 *   createdAt desc + id ordering — B-AC27); page/location params are parsed
 *   and clamped in loadOrdersPage (never an unbounded query).
 * - The location filter offers ONLY the caller's accessible locations
 *   (E-11); a tampered ?location= id fails closed to an empty list
 *   (B-AC28) via loadOrdersPage.
 */
export default async function OrdersListPage({
  searchParams,
}: {
  searchParams: { page?: string; location?: string }
}) {
  const context = await getSessionContext()
  if (!context) redirect("/login")

  // Accessible locations for the filter dropdown (E-11 resolution).
  const accessibleLocations = await prisma.location.findMany({
    where: { id: { in: context.accessibleLocationIds } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })

  const result = await loadOrdersPage({
    orgId: context.orgId,
    accessibleLocationIds: context.accessibleLocationIds,
    pageParam: searchParams?.page ?? null,
    locationParam: searchParams?.location ?? null,
  })

  const { orders, page, totalPages, total } = result

  const buildPageUrl = (targetPage: number) => {
    const params = new URLSearchParams()
    if (searchParams?.location) params.set("location", searchParams.location)
    params.set("page", String(targetPage))
    return `/orders/list?${params.toString()}`
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Orders</h1>
          <p className="text-slate-500">Manage your sales and order history.</p>
        </div>
        <Link href="/orders">
          Open POS
        </Link>
      </div>

      {/* Location filter — restricted to accessible locations (E-11). */}
      <form className="flex items-center gap-2" action="/orders/list" method="get">
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

      {result.unauthorizedLocation && (
        <p className="text-sm text-red-600">
          You do not have access to that location. Showing nothing.
        </p>
      )}

      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr className="text-left">
              <th className="px-4 py-3 font-medium">Order</th>
              <th className="px-4 py-3 font-medium">Date</th>
              <th className="px-4 py-3 font-medium">Items</th>
              <th className="px-4 py-3 font-medium">Total</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No orders found.
                </td>
              </tr>
            ) : (
              orders.map((order) => {
                const voidable = order.status === "FULFILLED" && order.paymentStatus === "UNPAID"
                return (
                  <tr key={order.id} className="border-t border-slate-100">
                    <td className="px-4 py-3">
                      <Link
                        href={`/orders/${order.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {order.orderNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(order.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {order.items.reduce((sum, item) => sum + item.quantity, 0)}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      ₦{Number(order.totalAmount).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-slate-700">{order.status}</span>
                      {" · "}
                      <span className="text-slate-500">
                        {order.paymentStatus}
                        {order.paymentMethod ? ` (${order.paymentMethod})` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2 justify-end">
                        {order.status === "ATTENTION" && <ResolveButton orderId={order.id} />}
                        {voidable && (
                          <>
                            <VoidButton orderId={order.id} />
                            <RecordPaymentButton orderId={order.id} />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination — bounded and deterministic (B-AC27). */}
      <div className="flex justify-between items-center text-sm text-slate-500">
        <span>
          Page {page} of {totalPages} · {total} order{total === 1 ? "" : "s"}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link href={buildPageUrl(page - 1)} className="hover:underline">
              ← Previous
            </Link>
          )}
          {page < totalPages && (
            <Link href={buildPageUrl(page + 1)} className="hover:underline">
              Next →
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
