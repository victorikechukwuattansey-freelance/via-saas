"use client"

import { useState } from "react"
import { Button } from "@via-saas/ui"
import { createCategory, deleteCategory } from "./actions"

type CategoryView = {
  id: string
  name: string
  productCount: number
}

export function CategoryManager({ categories }: { categories: CategoryView[] }) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget   // ← capture before await
    setIsLoading(true)
    setError(null)
    const res = await createCategory(new FormData(form))
    setIsLoading(false)
    if (res.error) {
      setError(res.error)
    } else {
      form.reset()         // ← use captured reference
    }
  }

  return (
    <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm h-fit space-y-3">
      <h2 className="text-lg font-semibold">Categories</h2>
      {error && <p className="text-xs text-red-600">{error}</p>}

      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          name="name"
          type="text"
          placeholder="e.g. Tyres"
          className="flex-1 px-3 py-2 border rounded-md text-sm"
          required
        />
        <Button type="submit" size="sm" disabled={isLoading}>
          {isLoading ? "..." : "Add"}
        </Button>
      </form>

      {categories.length === 0 ? (
        <p className="text-sm text-slate-500">No categories yet.</p>
      ) : (
        <ul className="space-y-1">
          {categories.map((category) => (
            <li key={category.id} className="flex justify-between items-center text-sm">
              <span>
                {category.name}
                <span className="text-slate-400"> · {category.productCount}</span>
              </span>
              <button
                onClick={() => {
                  if (!confirm(`Remove category "${category.name}"? Products keep all their history and just become uncategorized.`)) return
                  const formData = new FormData()
                  formData.set("categoryId", category.id)
                  void deleteCategory(formData).then((res) => {
                    if (res.error) setError(res.error)
                  })
                }}
                className="text-xs text-red-500 hover:underline"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
