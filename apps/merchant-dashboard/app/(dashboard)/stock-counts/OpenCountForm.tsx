"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@via-saas/ui"
import { openCount } from "./actions"

/**
 * P1-D / P1-22: opens a count at one accessible ACTIVE location.
 *
 * The location list is computed server-side (accessible locations minus
 * archived ones) and passed in — the form never offers a location the caller
 * cannot count, and the action re-checks accessibility anyway.
 */
export function OpenCountForm({ locations }: { locations: { id: string; name: string }[] }) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (locations.length === 0) {
    return (
      <p className="text-sm text-slate-500 italic">
        Open an active location before starting a stock count.
      </p>
    )
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsLoading(true)
    setError(null)

    const formData = new FormData(event.currentTarget)
    const result = await openCount(formData)

    setIsLoading(false)
    if ("error" in result) {
      setError(result.error)
      return
    }
    router.push(`/stock-counts/${result.countId}`)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3 bg-white border border-slate-200 rounded-lg p-4"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="locationId" className="text-xs font-medium text-slate-600">
          Location
        </label>
        <select
          id="locationId"
          name="locationId"
          className="border border-slate-300 rounded-md text-sm px-3 py-2 bg-white min-w-56"
          required
          defaultValue={locations[0].id}
        >
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" size="sm" disabled={isLoading}>
        {isLoading ? "Opening..." : "Start stock count"}
      </Button>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-slate-500 basis-full">
        One line is created automatically for every variant that holds inventory at the location.
      </p>
    </form>
  )
}
