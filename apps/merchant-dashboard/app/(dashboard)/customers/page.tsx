import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { redirect } from "next/navigation"
import { Users } from "lucide-react"

export default async function CustomersPage() {
  const context = await getSessionContext()
  
  // RBAC Guard: Staff cannot view customers
  if (!context || context.role === "STAFF") {
    redirect("/")
  }

  const customers = await prisma.customer.findMany({
    where: { organizationId: context.orgId },
    include: {
      _count: { select: { orders: true } }
    }
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Customers</h1>
        <p className="text-slate-500">View your customer database and order history.</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm">
              <th className="p-4 font-medium">Customer Name</th>
              <th className="p-4 font-medium">Contact</th>
              <th className="p-4 font-medium">Total Orders</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-12 text-center text-slate-500">
                  <Users className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                  No customers yet. Customers are created during Storefront checkout.
                </td>
              </tr>
            ) : (
              customers.map((customer) => (
                <tr key={customer.id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="p-4 font-medium text-slate-900">{customer.name}</td>
                  <td className="p-4 text-sm text-slate-600">
                    <p>{customer.email || "No email"}</p>
                    <p>{customer.phone || "No phone"}</p>
                  </td>
                  <td className="p-4 text-slate-900 font-semibold">
                    {customer._count.orders} order(s)
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
