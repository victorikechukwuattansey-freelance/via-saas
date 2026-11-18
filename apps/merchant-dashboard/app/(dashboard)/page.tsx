import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { loadLowStock } from "@/lib/low-stock"
import { redirect } from "next/navigation"
import { AlertCircle } from "lucide-react"

export default async function DashboardHome() {
  const context = await getSessionContext()
  if (!context) redirect("/login")

  // 1. Fetch Today's Sales (assuming Paid orders)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  
  const todaySales = await prisma.order.aggregate({
    where: {
      organizationId: context.orgId,
      createdAt: { gte: today },
      paymentStatus: "PAID"
    },
    _sum: { totalAmount: true }
  })

  // 2. Fetch Pending/Attention Orders
  const attentionOrders = await prisma.order.count({
    where: {
      organizationId: context.orgId,
      status: "ATTENTION"
    }
  })

  const pendingOrders = await prisma.order.count({
    where: {
      organizationId: context.orgId,
      status: "PENDING"
    }
  })

  const salesTotal = todaySales._sum.totalAmount ? Number(todaySales._sum.totalAmount) : 0

  // P1-D (P1-21): low-stock banner, read-time evaluated across the actor's
  // accessible locations (PD-AC13/14); archived products excluded (R-9).
  const lowStock = await loadLowStock({
    orgId: context.orgId,
    accessibleLocationIds: context.accessibleLocationIds,
  })
  const LOW_STOCK_LIST_CAP = 8
  const shownLowStock = lowStock.slice(0, LOW_STOCK_LIST_CAP)
  const hiddenLowStockCount = lowStock.length - shownLowStock.length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Welcome back, {context.user.name.split(" ")[0]}
        </h1>
        <p className="text-slate-500 mt-1">
          Here is what is happening in your business today.
        </p>
      </div>

      {/* Needs Attention Banner (Dynamic) */}
      {attentionOrders > 0 && (
        <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md flex items-start justify-between">
          <div className="flex gap-3">
            <AlertCircle className="text-red-600 mt-0.5" />
            <div>
              <h3 className="text-red-800 font-medium">You have {attentionOrders} orders with stock conflicts.</h3>
              <p className="text-red-600 text-sm mt-1">Action is required to resolve these orders.</p>
            </div>
          </div>
          <a href="/orders" className="bg-red-100 text-red-800 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-red-200 transition-colors">
            Resolve Now
          </a>
        </div>
      )}

      {/* Low Stock Banner (P1-21, read-time across accessible locations) */}
      {lowStock.length > 0 && (
        <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-md flex items-start justify-between">
          <div className="flex gap-3">
            <AlertCircle className="text-amber-600 mt-0.5" />
            <div>
              <h3 className="text-amber-800 font-medium">
                You have {lowStock.length} low-stock {lowStock.length === 1 ? "alert" : "alerts"}.
              </h3>
              <ul className="text-amber-700 text-sm mt-1 space-y-0.5">
                {shownLowStock.map((entry) => (
                  <li key={`${entry.variantId}-${entry.locationId}`}>
                    {entry.productName} — {entry.variantName} · {entry.locationName}:{" "}
                    {entry.quantity} left (threshold {entry.threshold})
                  </li>
                ))}
                {hiddenLowStockCount > 0 && (
                  <li className="italic">+{hiddenLowStockCount} more — see Products</li>
                )}
              </ul>
            </div>
          </div>
          <a
            href="/products"
            className="bg-amber-100 text-amber-800 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-amber-200 transition-colors"
          >
            Review Stock
          </a>
        </div>
      )}

      {/* Quick Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Today's Sales</p>
          <p className="text-2xl font-bold text-slate-900 mt-2">₦{salesTotal.toLocaleString()}</p>
        </div>
        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Pending Orders</p>
          <p className="text-2xl font-bold text-slate-900 mt-2">{pendingOrders}</p>
        </div>
        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Low Stock Alerts</p>
          <p className={`text-2xl font-bold mt-2 ${lowStock.length > 0 ? "text-amber-600" : "text-slate-900"}`}>
            {lowStock.length}
          </p>
        </div>
      </div>
    </div>
  )
}
