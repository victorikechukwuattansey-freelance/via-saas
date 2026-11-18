"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { approveCount, cancelCount, saveCounts } from "../actions"

export type EntryLine = {
  id: string
  productName: string
  variantName: string
  sku: string | null
  expectedQty: number
  countedQty: number | null
  currentQty: number | null
  productArchived: boolean
}

/**
 * P1-D / P1-22: counted-quantity entry, approval and cancellation for an OPEN
 * count (plan §6.3).
 *
 * Three explicit actions, one form:
 *  - Save counts: persists the typed values (blank = leave unchanged).
 *  - Approve: saves any typed values, then runs approval, which applies one
 *    corrective movement per non-zero delta in a single transaction.
 *  - Cancel: terminal, no stock effect.
 *
 * The action results are surfaced inline; the server re-verifies role,
 * organization, location and the OPEN precondition on every call, so this
 * component is a convenience layer only.
 */
export function CountEntryForm({ countId, lines }: { countId: string; lines: EntryLine[] }) {
  const router = useRouter()
  const [pending, setPending] = useState<"save" | "approve" | "cancel" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (
    kind: "save" | "approve" | "cancel",
    action: (formData: FormData) => Promise<{ error: string } | { success: true; correctedLines?: number }>,
    formData: FormData
  ) => {
    setPending(kind)
    setError(null)
    setNotice(null)

    const result = await action(formData)
    setPending(null)

    if ("error" in result) {
      setError(result.error)
      router.refresh()
      return
    }
    if (kind === "cancel") {
      setNotice("Stock count cancelled.")
    } else if (kind === "approve") {
      const corrected = result.correctedLines ?? 0
      setNotice(
        corrected === 0
          ? "Stock count approved — no quantities needed correcting."
          : `Stock count approved — ${corrected} line${corrected === 1 ? "" : "s"} corrected.`
      )
    } else {
      setNotice("Counted quantities saved.")
    }
    router.refresh()
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await run("save", saveCounts, new FormData(event.currentTarget))
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <input type="hidden" name="countId" value={countId} />

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
          {notice}
        </p>
      )}

      <div className="overflow-x-auto bg-white rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-slate-500">Product</th>
              <th className="px-4 py-2 text-left font-medium text-slate-500">SKU</th>
              <th className="px-4 py-2 text-right font-medium text-slate-500">Expected</th>
              <th className="px-4 py-2 text-right font-medium text-slate-500">Current</th>
              <th className="px-4 py-2 text-right font-medium text-slate-500">Counted</th>
              <th className="px-4 py-2 text-right font-medium text-slate-500">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((line) => {
              const variance =
                line.countedQty === null || line.currentQty === null
                  ? null
                  : line.countedQty - line.currentQty
              return (
                <tr key={line.id}>
                  <td className="px-4 py-2 text-slate-700">
                    {line.productName} — {line.variantName}
                    {line.productArchived && (
                      <span className="ml-2 text-xs font-medium text-amber-700">archived</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{line.sku ?? "—"}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{line.expectedQty}</td>
                  <td className="px-4 py-2 text-right text-slate-600">{line.currentQty ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    <label className="sr-only" htmlFor={`qty:${line.id}`}>
                      Counted quantity for {line.productName} — {line.variantName}
                    </label>
                    <input
                      id={`qty:${line.id}`}
                      name={`qty:${line.id}`}
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      defaultValue={line.countedQty ?? ""}
                      className="w-24 text-sm px-2 py-1 border border-slate-300 rounded text-right"
                    />
                  </td>
                  <td
                    className={
                      variance === null || variance === 0
                        ? "px-4 py-2 text-right text-slate-400"
                        : variance > 0
                          ? "px-4 py-2 text-right font-medium text-green-600"
                          : "px-4 py-2 text-right font-medium text-red-600"
                    }
                  >
                    {variance === null ? "—" : variance > 0 ? `+${variance}` : variance}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending !== null}
          className="border border-slate-300 rounded-md text-sm px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
        >
          {pending === "save" ? "Saving..." : "Save counts"}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={(event) =>
            run("approve", approveCount, new FormData(event.currentTarget.form as HTMLFormElement))
          }
          className="rounded-md bg-slate-900 text-white text-sm px-3 py-2 hover:bg-slate-800 disabled:opacity-50"
        >
          {pending === "approve" ? "Approving..." : "Approve count"}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={(event) =>
            run("cancel", cancelCount, new FormData(event.currentTarget.form as HTMLFormElement))
          }
          className="text-sm text-red-600 hover:underline disabled:opacity-50"
        >
          {pending === "cancel" ? "Cancelling..." : "Cancel count"}
        </button>
        <p className="text-xs text-slate-500">
          Approval applies one corrective movement per line whose counted quantity differs from the
          current balance.
        </p>
      </div>
    </form>
  )
}
