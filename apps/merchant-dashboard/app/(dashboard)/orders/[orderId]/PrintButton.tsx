"use client"

import { Button } from "@via-saas/ui"

/** Screen-only print trigger for the receipt record (B-AC8). */
export function PrintButton() {
  return (
    <Button variant="outline" onClick={() => window.print()}>
      Print receipt
    </Button>
  )
}
