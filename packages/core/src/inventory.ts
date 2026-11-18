// packages/core/src/inventory.ts
// P1-D / P1-19 — the single-writer E.1 inventory mutation contract (§6.1 of
// docs/VIA_P1D_IMPLEMENTATION_PLAN.md).
//
// Every non-creation Inventory quantity change MUST route through
// mutateInventory. Inside the CALLER's transaction the helper performs:
//   1. in-transaction tenant + state verification (fail-closed);
//   2. a guarded quantity update (negative stock impossible — the guard is
//      part of the UPDATE's WHERE, so check and write are one statement);
//   3. the caller-supplied error mapping on failure (§6.1.1 — each call site
//      keeps its exact shipped error code AND message);
//   4. EXACTLY ONE StockMovement for the mutation.
// Audit responsibility remains with the caller (existing events unchanged;
// the PD-D5 audit migration belongs to a later phase of the plan).
//
// The helper never opens its own transaction: the caller's transaction is
// the atomicity boundary for quantity change + movement, and a throw rolls
// the caller's whole transaction back (all-lines-or-nothing checkout, etc.).
import type { Prisma } from "@prisma/client"
import { DomainError } from "./errors"

/** Caller-supplied (code, message) pair preserving a call site's shipped error exactly (§6.1.1). */
export type InventoryMutationError = {
  code: "INSUFFICIENT_STOCK" | "VALIDATION" | "FORBIDDEN"
  message: string
}

export type MutateInventoryInput = {
  /** Caller's organization — verified in-transaction, never trusted from the client. */
  orgId: string
  locationId: string
  variantId: string
  /** Signed quantity change; negative = removal. */
  delta: number
  /** Movement type. TRANSFER arrives with P1-F and is intentionally absent. */
  type: "ADDED" | "REMOVED" | "SALE" | "RETURN"
  /** Acting user id, or null for system-origin mutations (storefront checkout). */
  actorId: string | null
  /** Movement reference: order id | count id | manual reason (display-typed in P1-20). */
  referenceId: string | null
  /**
   * Per-caller error mapping (§6.1.1).
   * - `insufficient` fires when the guarded update matches no row — a missing
   *   row or insufficient stock; the caller knows which reading applies
   *   (e.g. RETURN restoration maps this to VALIDATION, decrements to
   *   INSUFFICIENT_STOCK).
   * - `unauthorized` fires on tenant/active-state failure. Omit it to use the
   *   fail-closed default below (defense-in-depth paths that verified callers
   *   cannot reach).
   */
  errors: {
    unauthorized?: InventoryMutationError
    insufficient: InventoryMutationError
  }
}

/**
 * Defense-in-depth default for tenant/active-state failures. Verified callers
 * pre-validate ownership and state before invoking the helper, so this is
 * unreachable through them; it exists so a future caller cannot forget to
 * fail closed.
 */
const DEFAULT_UNAUTHORIZED: InventoryMutationError = {
  code: "FORBIDDEN",
  message: "You are not authorized to modify this inventory.",
}

export async function mutateInventory(
  tx: Prisma.TransactionClient,
  input: MutateInventoryInput
): Promise<void> {
  const { orgId, locationId, variantId, delta, type, actorId, referenceId, errors } = input

  if (!Number.isInteger(delta) || delta === 0) {
    throw new DomainError("VALIDATION", "Inventory delta must be a non-zero whole number.")
  }

  // 1. TENANT + STATE CHECK (in-tx, fail-closed).
  //    C-D20: ADDED/REMOVED/SALE require the location to be ACTIVE; RETURN may
  //    target a since-archived location (restoration invariant — P1-B C8/C16:
  //    restoration is never blocked or redirected by archival).
  const [variant, location] = await Promise.all([
    tx.productVariant.findFirst({
      where: { id: variantId, product: { organizationId: orgId } },
      select: { id: true },
    }),
    tx.location.findFirst({
      where: {
        id: locationId,
        store: { organizationId: orgId },
        ...(type === "RETURN" ? {} : { archivedAt: null }),
      },
      select: { id: true },
    }),
  ])
  if (!variant || !location) {
    const { code, message } = errors.unauthorized ?? DEFAULT_UNAUTHORIZED
    throw new DomainError(code, message)
  }

  // 2. GUARDED UPDATE. The negative-stock guard lives in the WHERE clause, so
  //    the check and the write are one atomic statement (no check-then-write
  //    race). A missing Inventory row matches zero rows and lands in the
  //    error branch below (creation-side rows are always made through the
  //    creation sites, which write the initial ledger movement — §6.7).
  const updateResult = await tx.inventory.updateMany({
    where: {
      locationId,
      variantId,
      ...(delta < 0 ? { quantity: { gte: Math.abs(delta) } } : {}),
    },
    data: { quantity: { increment: delta } },
  })

  // 3. count === 0 → the caller's exact shipped error. Thrown inside the
  //    caller's transaction → the caller's whole transaction rolls back.
  if (updateResult.count === 0) {
    throw new DomainError(errors.insufficient.code, errors.insufficient.message)
  }

  // 4. EXACTLY ONE StockMovement for this mutation — same transaction, so
  //    quantity change and ledger entry commit or roll back together.
  await tx.stockMovement.create({
    data: {
      locationId,
      variantId,
      actorId: actorId ?? null, // null = system-originated movement
      type,
      quantity: delta,
      referenceId: referenceId ?? null,
    },
  })

  // 5. Audit responsibility remains with the caller (plan §6.1 step 5).
}
