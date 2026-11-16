"use client"

import { useState } from "react"
import { Button } from "@via-saas/ui"
import { createProduct } from "./actions"

export function CreateProductForm() {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    const res = await createProduct(new FormData(e.currentTarget))
    setIsLoading(false)
    if (res.error) {
      setError(res.error)
    } else {
      e.currentTarget.reset()
    }
  }

  return (
    <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Add New Product</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div>
          <label className="text-sm font-medium">Product Name</label>
          <input name="name" type="text" className="w-full px-3 py-2 border rounded-md mt-1" required />
        </div>
        <div>
          <label className="text-sm font-medium">Description</label>
          <input name="description" type="text" className="w-full px-3 py-2 border rounded-md mt-1" />
        </div>
        <div>
          <label className="text-sm font-medium">SKU (Optional, unique in your business)</label>
          <input name="sku" type="text" placeholder="e.g. WM-001" className="w-full px-3 py-2 border rounded-md mt-1" />
        </div>
        <div>
          <label className="text-sm font-medium">Price (₦)</label>
          <input name="price" type="number" step="0.01" className="w-full px-3 py-2 border rounded-md mt-1" required />
        </div>
        <div>
          <label className="text-sm font-medium">Cost (₦, optional)</label>
          <input name="cost" type="number" step="0.01" placeholder="Leave blank if not tracked" className="w-full px-3 py-2 border rounded-md mt-1" />
        </div>
        <div>
          <label className="text-sm font-medium">Initial Stock</label>
          <input name="stock" type="number" className="w-full px-3 py-2 border rounded-md mt-1" required />
        </div>
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? "Saving..." : "Save Product"}
        </Button>
      </form>
    </div>
  )
}
