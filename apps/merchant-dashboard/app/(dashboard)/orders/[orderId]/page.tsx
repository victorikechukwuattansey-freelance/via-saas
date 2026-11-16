import { getSessionContext, canAccessLocation } from "@/lib/auth-helpers"
import { loadOrderDetail } from "@/lib/orders"
import { notFound } from "next/navigation"
import Link from "next/link"
import { ResolveButton } from "../list/ResolveButton"
import { VoidButton } from "../components/VoidButton"
import { RecordPaymentButton } from "../components/RecordPaymentButton"
import { PrintButton } from "./PrintButton"
import "./print.css"

/**
 * P1-B (B2 / P1-08): order detail + receipt-record page.
 *
 * TENANT + LOCATION AUTHORIZATION (B-AC7, E-11):
 *  - loadOrderDetail is org-scoped: cross-org and nonexistent ids both fail
 *    closed to notFound (no existence leak).
 *  - An order that exists but sits in a location the caller cannot access is
 *    ALSO treated as not found (fail closed, same message pattern).
 */
export default async function OrderDetailPage({ params }: { params: { orderId: string } }) {
  const context = await getSessionContext()
  if (!context) notFound()

  const loaded = await loadOrderDetail(context.orgId, params.orderId)
  if (!loaded) notFound()

  // Location authorization: the detail view is additionally fail-closed on
  // the caller's accessible locations (E-11). Cross-org already returned
  // null above; this blocks same-org-but-unauthorized-location access.
  if (!canAccessLocation(context, loaded.order.locationId)) notFound()

  const { order, movements } = loaded

  const canVoid = order.status === "FULFILLED" && order.paymentStatus === "UNPAID"
  const canRecordPayment = order.status === "FULFILLED" && order.paymentStatus === "UNPAID"
  const isAttention = order.status === "ATTENTION"

  return (
    <div className="space-y-6">
      <div className="no-print flex justify-between items-center">
        <div>
          <Link href="/orders/list" className="text-sm text-blue-600 hover:underline">
            ← Back to orders
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">Order {order.orderNumber}</h1>
          <p className="text-slate-500">
            {order.status} · {order.paymentStatus}
            {order.paymentMethod ? ` · ${order.paymentMethod}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {canVoid && <VoidButton orderId={order.id} />}
          {canRecordPayment && <RecordPaymentButton orderId={order.id} />}
          {isAttention && <ResolveButton orderId={order.id} />}
        </div>
      </div>

      {/* Receipt record — the only block that prints. */}
      <div className="receipt-sheet bg-white rounded-lg border border-slate-200 shadow-sm p-6 max-w-2xl">
        <div className="flex justify-between items-start border-b border-slate-200 pb-4">
          <div>
            <div className="text-lg font-bold text-slate-900">Order {order.orderNumber}</div>
            <div className="text-sm text-slate-500">
              {new Date(order.createdAt).toLocaleString()}
            </div>
          </div>
          <div className="text-right text-sm">
            <div>
              Status: <span className="font-semibold">{order.status}</span>
            </div>
            <div>
              Payment: <span className="font-semibold">{order.paymentStatus}</span>
              {order.paymentMethod ? ` (${order.paymentMethod})` : ""}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm py-4 border-b border-slate-200">
          <div>
            <dt className="text-slate-500">Location</dt>
            <dd className="font-medium text-slate-900">{order.location.name}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Customer</dt>
            <dd className="font-medium text-slate-900">
              {order.customer
                ? `${order.customer.name}${order.customer.phone ? ` · ${order.customer.phone}` : ""}`
                : "—"}
            </dd>
          </div>
        </dl>

        <table className="w-full text-sm py-4">
          <thead>
            <tr className="text-left text-slate-500 border-b border-slate-200">
              <th className="py-2 font-medium">Item</th>
              <th className="py-2 font-medium text-right">Qty</th>
              <th className="py-2 font-medium text-right">Unit price</th>
              <th className="py-2 font-medium text-right">Line total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id} className="border-b border-slate-100">
                <td className="py-2">
                  <div className="font-medium text-slate-900">{item.variant.product.name}</div>
                  <div className="text-slate-500">
                    {item.variant.name}
                    {item.variant.sku ? ` · SKU ${item.variant.sku}` : ""}
                    {item.variant.barcode ? ` · ${item.variant.barcode}` : ""}
                  </div>
                </td>
                <td className="py-2 text-right">{item.quantity}</td>
                <td className="py-2 text-right">₦{Number(item.unitPrice).toLocaleString()}</td>
                <td className="py-2 text-right">
                  ₦{(Number(item.unitPrice) * item.quantity).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="py-2 text-right font-semibold">
                Total
              </td>
              <td className="py-2 text-right font-bold text-base">
                ₦{Number(order.totalAmount).toLocaleString()}
              </td>
            </tr>
          </tfoot>
        </table>

        {/* P1-B data-integrity evidence block (screen only): the stock
            movements behind this order, with acting user and timestamps. */}
        <div className="no-print border-t border-slate-200 pt-4 mt-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Stock movements</h2>
          {movements.length === 0 ? (
            <p className="text-sm text-slate-500">No stock movements recorded.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {movements.map((movement) => (
                <li key={movement.id} className="flex justify-between text-slate-600">
                  <span>
                    <span className="font-medium text-slate-900">{movement.type}</span>{" "}
                    {movement.quantity > 0 ? "+" : ""}
                    {movement.quantity} · {movement.variant.name}
                  </span>
                  <span>
                    {new Date(movement.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="no-print text-xs text-slate-400 mt-4 flex justify-between">
          <span>Order ID: {order.id}</span>
          <span>Last updated: {new Date(order.updatedAt).toLocaleString()}</span>
        </div>
      </div>

      <div className="no-print">
        <PrintButton />
      </div>
    </div>
  )
}
