"use client"

import { useState } from "react"
import { Button } from "@via-saas/ui"
import { recordPayment } from "../payment/actions"
import { useRouter } from "next/navigation"

/**
 * P1-B (D-B/D-D): "Record payment received" button for TRANSFER + UNPAID +
 * FULFILLED orders. This is a merchant confirmation that money was received —
 * it does not verify a bank transfer or move money.
 */
export function RecordPaymentButton({ orderId, className }: { orderId: string; className?: string }) {
  const [isLoading, setIsLoading] = useState(false)
  const router = useRouter()

  const handleRecord = async () => {
    if (!window.confirm(
      "Record payment as RECEIVED for this order? Confirm only after verifying the bank transfer yourself."
    )) return

    setIsLoading(true)
    const res = await recordPayment(orderId)
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
      onClick={handleRecord}
      disabled={isLoading}
      className={className}
    >
      {isLoading ? "Recording…" : "Record payment"}
    </Button>
  )
}
