"use client"

import { useState } from "react"
import { Button } from "@via-saas/ui"
import { voidOrder } from "../cancel/actions"
import { useRouter } from "next/navigation"

/**
 * P1-B (D-A): void button for FULFILLED + UNPAID orders. The confirmation
 * dialog explains the consequence (stock is restored, status CANCELLED).
 */
export function VoidButton({ orderId, className }: { orderId: string; className?: string }) {
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()

  const handleVoid = async () => {
    if (!window.confirm(
      "Void this order? Stock will be restored and the order marked CANCELLED."
    )) return

    setIsLoading(true)
    const res = await voidOrder(orderId)
    setIsLoading(false)

    if (res.error) {
      window.alert(res.error)
    } else {
      router.refresh()
    }
  }

  return (
    <Button
      size="sm"
      variant="destructive"
      onClick={handleVoid}
      disabled={isLoading}
      className={className}
    >
      {isLoading ? "Voiding…" : "Void"}
    </Button>
  )
}
