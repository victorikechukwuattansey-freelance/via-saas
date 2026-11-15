"use client"

import { useState } from "react"
import { Button } from "@via-saas/ui"
import { adjustStock } from "./adjust-actions"

export function AdjustStockForm({ variantId }: { variantId: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    const formData = new FormData(e.currentTarget)
    const res = await adjustStock(formData)
    
    setIsLoading(false)
    if (res.error) {
      setError(res.error)
    } else {
      setIsOpen(false)
    }
  }

  if (!isOpen) {
    return (
      <button 
        onClick={() => setIsOpen(true)}
        className="text-xs text-blue-600 hover:underline font-medium"
      >
        Adjust Stock
      </button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2">
      <input type="hidden" name="variantId" value={variantId} />
      {error && <p className="text-xs text-red-600">{error}</p>}
      
      <div className="flex gap-2">
        <input 
          name="adjustment" 
          type="number" 
          placeholder="e.g. 10 or -5" 
          className="w-24 text-sm px-2 py-1 border rounded" 
          required 
        />
        <input 
          name="reason" 
          type="text" 
          placeholder="Reason (e.g. Restock)" 
          className="flex-1 text-sm px-2 py-1 border rounded" 
          required 
        />
      </div>
      
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => setIsOpen(false)} className="text-xs text-slate-500">Cancel</button>
        <Button type="submit" size="sm" disabled={isLoading}>
          {isLoading ? "Saving..." : "Save"}
        </Button>
      </div>
    </form>
  )
}
