"use server"

import { revalidatePath } from "next/cache"
import {
  approveStockCount,
  cancelStockCount,
  enterStockCountLines,
  openStockCount,
  toSafeErrorMessage,
  type StockCountEntry,
} from "@via-saas/core"
import { canAccessLocation, getSessionContext } from "@/lib/auth-helpers"

/**
 * P1-D / P1-22 server actions for the stock-count surfaces (plan §6.3, §7).
 *
 * Wrapper responsibilities (the established two-layer pattern):
 *  - RBAC: counts are OWNER/MANAGER only (PD-D2). STAFF is rejected BEFORE
 *    any core call, so the safe unauthorized error is the whole response.
 *  - LOCATION AUTHORIZATION (E-11): the caller's accessible locations are
 *    checked before opening at a location.
 *  - Core (`packages/core/src/stock-counts.ts`) re-verifies organization
 *    scope, membership role, location state, and the OPEN precondition inside
 *    the transaction — the actions never trust the form.
 */

const UNAUTHORIZED_MESSAGE =
  "Unauthorized. Only Owners and Managers can manage stock counts."

type ActionFailure = { error: string }

async function requireCountManager() {
  const context = await getSessionContext()
  if (!context) {
    return {
      context: null,
      error: { error: "Your session has expired. Please log in again." } as ActionFailure,
    }
  }
  if (context.role !== "OWNER" && context.role !== "MANAGER") {
    return { context: null, error: { error: UNAUTHORIZED_MESSAGE } as ActionFailure }
  }
  return { context, error: null }
}

function readString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Collects the `qty:<lineId>` fields of a count form. A blank field means
 * "leave this line unchanged" — a save never silently clears an entered
 * quantity. Non-numeric text is passed through as NaN so the core's
 * whole-number validation produces the safe error.
 */
function readCountedEntries(formData: FormData): StockCountEntry[] {
  const entries: StockCountEntry[] = []
  formData.forEach((value, field) => {
    if (!field.startsWith("qty:") || typeof value !== "string") return
    const lineId = field.slice("qty:".length)
    if (!lineId) return
    const raw = value.trim()
    if (raw === "") return
    const parsed = Number(raw)
    entries.push({
      lineId,
      countedQty: Number.isInteger(parsed) ? parsed : Number.NaN,
    })
  })
  return entries
}

export async function openCount(formData: FormData) {
  const locationId = readString(formData.get("locationId"))
  const guard = await requireCountManager()
  if (guard.error) return guard.error
  const context = guard.context

  if (!locationId) {
    return { error: "Select a location to count." }
  }
  if (!canAccessLocation(context, locationId)) {
    return { error: "You are not authorized to manage stock counts at this location." }
  }

  try {
    const result = await openStockCount(context.orgId, context.userId, locationId)
    revalidatePath("/stock-counts")
    return { success: true as const, countId: result.id }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to open the stock count.") }
  }
}

export async function saveCounts(formData: FormData) {
  const countId = readString(formData.get("countId"))
  const guard = await requireCountManager()
  if (guard.error) return guard.error
  const context = guard.context

  if (!countId) return { error: "Stock count not found." }

  const entries = readCountedEntries(formData)
  if (entries.length === 0) return { error: "No counted quantities were submitted." }

  try {
    await enterStockCountLines(context.orgId, context.userId, countId, entries)
    revalidatePath("/stock-counts")
    revalidatePath(`/stock-counts/${countId}`)
    return { success: true as const }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to save the counted quantities.") }
  }
}

/**
 * Saves any quantities typed into the form and then approves the count.
 *
 * The two core calls are separate transactions by design: entry is a normal
 * edit of an OPEN count, so persisting it must not be lost if approval is
 * rejected (e.g. a product was archived). A rejected approval rolls back
 * atomically and leaves the count OPEN (PD-AC32), with the entry saved.
 */
export async function approveCount(formData: FormData) {
  const countId = readString(formData.get("countId"))
  const guard = await requireCountManager()
  if (guard.error) return guard.error
  const context = guard.context

  if (!countId) return { error: "Stock count not found." }

  try {
    const entries = readCountedEntries(formData)
    if (entries.length > 0) {
      await enterStockCountLines(context.orgId, context.userId, countId, entries)
    }
    const result = await approveStockCount(context.orgId, context.userId, countId)
    revalidatePath("/stock-counts")
    revalidatePath(`/stock-counts/${countId}`)
    revalidatePath("/inventory")
    revalidatePath("/products")
    revalidatePath("/")
    return { success: true as const, correctedLines: result.movements.length }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to approve the stock count.") }
  }
}

export async function cancelCount(formData: FormData) {
  const countId = readString(formData.get("countId"))
  const guard = await requireCountManager()
  if (guard.error) return guard.error
  const context = guard.context

  if (!countId) return { error: "Stock count not found." }

  try {
    await cancelStockCount(context.orgId, context.userId, countId)
    revalidatePath("/stock-counts")
    revalidatePath(`/stock-counts/${countId}`)
    return { success: true as const }
  } catch (error: unknown) {
    return { error: toSafeErrorMessage(error, "Failed to cancel the stock count.") }
  }
}
