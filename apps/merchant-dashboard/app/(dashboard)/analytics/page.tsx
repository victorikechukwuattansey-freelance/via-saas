import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { redirect } from "next/navigation"
import { BarChart3, TrendingUp, Package, Clock } from "lucide-react"

export default async function AnalyticsPage() {
  const context = await getSessionContext()
  
  if (!context || context.role !== "OWNER") {
    redirect("/")
  }

  // 1. Fetch Total Revenue (Paid only)
  const totalRevenueData = await prisma.order.aggregate({
    where: { organizationId: context.orgId, paymentStatus: "PAID" },
    _sum: { totalAmount: true }
  })
  const totalRevenue = totalRevenueData._sum.totalAmount ? Number(totalRevenueData._sum.totalAmount) : 0

  // 2. Fetch Paid Orders Count
  const paidOrdersCount = await prisma.order.count({
    where: { organizationId: context.orgId, paymentStatus: "PAID" }
  })

  // 3. Fetch Pending (Unpaid) Orders Count
  const pendingOrdersCount = await prisma.order.count({
    where: { organizationId: context.orgId, paymentStatus: "UNPAID" }
  })

  // 4. Fetch Top Selling Products (Paid only, to match Revenue)
  const orderItems = await prisma.orderItem.findMany({
    where: { order: { organizationId: context.orgId, paymentStatus: "PAID" } },
    include: {
      variant: { include: { product: true } }
    }
  })

  const productSales = orderItems.reduce((acc, item) => {
    const productName = item.variant.product.name
    if (!acc[productName]) {
      acc[productName] = { quantity: 0, revenue: 0 }
    }
    acc[productName].quantity += item.quantity
    acc[productName].revenue += (Number(item.unitPrice) * item.quantity)
    return acc
  }, {} as Record<string, { quantity: number, revenue: number }>)

  const topProducts = Object.entries(productSales)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Business Analytics</h1>
        <p className="text-slate-500">Track your store's performance and top sellers.</p>
      </div>

      {/* High-Level Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-blue-100 text-blue-600 rounded-lg">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-500">Collected Revenue</p>
            <p className="text-2xl font-bold text-slate-900">₦{totalRevenue.toLocaleString()}</p>
          </div>
        </div>
        
        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-purple-100 text-purple-600 rounded-lg">
            <BarChart3 className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-500">Paid Orders</p>
            <p className="text-2xl font-bold text-slate-900">{paidOrdersCount}</p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-yellow-100 text-yellow-600 rounded-lg">
            <Clock className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-500">Unpaid Orders</p>
            <p className="text-2xl font-bold text-slate-900">{pendingOrdersCount}</p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm flex items-center gap-4">
          <div className="p-3 bg-green-100 text-green-600 rounded-lg">
            <Package className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-500">Items Sold (Paid)</p>
            <p className="text-2xl font-bold text-slate-900">
              {orderItems.reduce((sum, item) => sum + item.quantity, 0)}
            </p>
          </div>
        </div>
      </div>

      {/* Top Selling Products Table */}
      <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden mt-8">
        <div className="p-6 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-900">Top Selling Products</h2>
          <p className="text-sm text-slate-500">Your best performers based on paid units.</p>
        </div>
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm">
              <th className="p-4 font-medium">Product Name</th>
              <th className="p-4 font-medium">Units Sold</th>
              <th className="p-4 font-medium">Revenue Generated</th>
            </tr>
          </thead>
          <tbody>
            {topProducts.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-8 text-center text-slate-500">
                  No paid sales data available yet.
                </td>
              </tr>
            ) : (
              topProducts.map((product) => (
                <tr key={product.name} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="p-4 font-medium text-slate-900">{product.name}</td>
                  <td className="p-4 text-slate-600">{product.quantity} units</td>
                  <td className="p-4 font-bold text-green-600">₦{product.revenue.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
