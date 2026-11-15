"use client"

import { useState } from "react"
import { Button } from "@via-saas/ui"
import { resolveOrder } from "../resolve/actions"
import { useRouter } from "next/navigation"

export function ResolveButton({ orderId }: { orderId: string }) {
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()

  const handleResolve = async (action: "FULFILL" | "CANCEL") => {
    if (!confirm(`Are you sure you want to ${action.toLowerCase()} this order?`)) return
    
    setIsLoading(true)
    const res = await resolveOrder(orderId, action)
    setIsLoading(false)

    if (res.error) {
      alert(res.error)
    } else {
      router.refresh()
    }
  }

  return (
    <div className="flex gap-2">
      <Button size="sm" onClick={() => handleResolve("FULFILL")} disabled={isLoading}>
        Fulfill
      </Button>
      <Button size="sm" variant="destructive" onClick={() => handleResolve("CANCEL")} disabled={isLoading}>
        Cancel
      </Button>
    </div>
  )
}
