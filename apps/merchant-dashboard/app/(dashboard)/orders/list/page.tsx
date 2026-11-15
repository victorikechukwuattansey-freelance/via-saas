import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Button } from "@via-saas/ui"
import { ResolveButton } from "./ResolveButton"

export default async function OrdersListPage() {
  const context = await getSessionContext()
  if (!context) redirect("/login")

  const orders = await prisma.order.findMany({
    where: { organizationId: context.orgId },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        include: { variant: { include: { product: true } } }
      }
    }
  })

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Orders</h1>
          <p className="text-slate-500">Manage your sales and order history.</p>
        </div>
        <Link href="/orders">
          <Button>Open POS</Button>
        </Link>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm">
              <th className="p-4 font-medium">Order Number</th>
              <th className="p-4 font-medium">Date</th>
              <th className="p-4 font-medium">Items</th>
              <th className="p-4 font-medium">Total</th>
              <th className="p-4 font-medium">Status</th>
              <th className="p-4 font-medium">Payment</th>
            </tr>
          </thead>
          <tbody>
            {orders.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-slate-500">
                  No orders yet. Use the POS to create your first order.
                </td>
              </tr>
            ) : (
              orders.map((order) => (
                <tr key={order.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="p-4 font-medium text-slate-900">{order.orderNumber}</td>
                  <td className="p-4 text-slate-600">{order.createdAt.toLocaleDateString()}</td>
                  <td className="p-4 text-slate-600">
                    {order.items.length} item(s)
                  </td>
                  <td className="p-4 font-bold text-slate-900">₦{Number(order.totalAmount).toLocaleString()}</td>
                  <td className="p-4">
                     {order.status === "ATTENTION" ? (
                      <ResolveButton orderId={order.id} />
                    ) : (
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      order.status === 'FULFILLED' ? 'bg-green-100 text-green-700' : 
                      
                      'bg-slate-100 text-slate-700'
                    }`}>
                      {order.status}
                    </span>
                     )}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      order.paymentStatus === 'PAID' ? 'bg-green-100 text-green-700' : 
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {order.paymentStatus}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
