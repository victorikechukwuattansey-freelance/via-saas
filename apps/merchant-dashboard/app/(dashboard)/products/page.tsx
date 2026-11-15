import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { redirect } from "next/navigation"
import { Button } from "@via-saas/ui"
import { createProduct } from "./actions"
import { AdjustStockForm } from "./AdjustStockForm"

export default async function ProductsPage() {
  const context = await getSessionContext()
  if (!context) redirect("/login")

  // Fetch Products for this Organization ONLY (Tenant Isolation)
  const products = await prisma.product.findMany({
    where: { organizationId: context.orgId },
    include: {
      variants: {
        include: {
          inventory: true // To show stock levels
        }
      }
    }
  })

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-slate-900">Product Catalogue</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: Add Product Form */}
        <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm h-fit">
          <h2 className="text-lg font-semibold mb-4">Add New Product</h2>
          <form action={async (formData) => {
            "use server"
            await createProduct(formData)
          }} className="space-y-4">
            <div>
              <label className="text-sm font-medium">Product Name</label>
              <input name="name" type="text" className="w-full px-3 py-2 border rounded-md mt-1" required />
            </div>
            <div>
              <label className="text-sm font-medium">SKU (Optional)</label>
              <input name="sku" type="text" placeholder="e.g. WM-001" className="w-full px-3 py-2 border rounded-md mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Price (₦)</label>
              <input name="price" type="number" step="0.01" className="w-full px-3 py-2 border rounded-md mt-1" required />
            </div>
            <div>
              <label className="text-sm font-medium">Initial Stock</label>
              <input name="stock" type="number" className="w-full px-3 py-2 border rounded-md mt-1" required />
            </div>
            <Button type="submit" className="w-full">Save Product</Button>
          </form>
        </div>

        {/* Right: Product List */}
        <div className="md:col-span-2 space-y-4">
          {products.length === 0 ? (
            <div className="text-center p-12 bg-white rounded-lg border border-slate-200 text-slate-500">
              No products yet. Add your first product to get started.
            </div>
          ) : (
            products.map((product) => {
              const variant = product.variants[0]
              const stock = variant.inventory[0]?.quantity || 0
              
              return (
                <div key={product.id} className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm flex flex-col">
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-semibold text-slate-900">{product.name}</h3>
                      <p className="text-sm text-slate-500">SKU: {variant.sku || "N/A"}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-slate-900">₦{Number(variant.sellingPrice).toLocaleString()}</p>
                      <p className={`text-sm ${stock > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {stock} in stock
                      </p>
                    </div>
                  </div>
                  
                  {/* The Adjust Stock Form */}
                  <div className="mt-2">
                    <AdjustStockForm variantId={variant.id} />
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
