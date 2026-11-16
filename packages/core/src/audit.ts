import { prisma } from "@via-saas/database"
import { AuditAction, Prisma } from "@prisma/client"
import { DomainError } from "./errors"

/**
 * The ONLY top-level metadata source value that may accompany a null actor.
 * Server-authorship rule (D-G): this value is stamped by the server-side
 * public storefront/API checkout path — it is NEVER accepted as a caller- or
 * client-controlled authorization claim. Merchant-authenticated callers
 * cannot pass it to obtain null-actor (system-origin) attribution.
 */
export const STOREFRONT_API_SOURCE = "STOREFRONT_API"

/**
 * P1-B central audit-writing path — the mandatory enforcement boundary for
 * the approved D-G null-actor attribution invariant:
 *
 *  - `actorId` may be null ONLY for public storefront/API checkout:
 *    action = CREATE_ORDER AND metadata.source (a TOP-LEVEL JSON key,
 *    read here at the top level of the metadata object) = "STOREFRONT_API".
 *  - Dashboard checkout, order cancellation, payment recording, and
 *    ATTENTION fulfillment/resolution all require a NON-NULL authenticated
 *    actor. No synthetic system user exists or may be created.
 *  - A merchant-authenticated (non-null actor) call claiming the
 *    STOREFRONT_API source is REJECTED — system-origin attribution cannot
 *    be claimed by an authenticated path.
 *  - Any other event (e.g. CANCEL_ORDER, RESOLVE_ORDER, PAYMENT_RECORDED,
 *    or the catalogue events) with a null actor is REJECTED.
 *
 * Transactional atomicity (E): an optional transaction client makes the
 * audit write commit or roll back together with the business mutation that
 * produced it. Callers MUST pass the transaction client when the audit is
 * coupled to a state change (P1-B order-side writes always do).
 *
 * The CHECK constraint `auditlog_actorid_null_only_public_checkout`
 * (migration 20261116120001_p1b_orders_b) is additive DEFENSE IN DEPTH for
 * the structural invariant only: the database cannot verify server
 * authorship of metadata.source, so this helper plus automated tests
 * (B-AC31) remain the mandatory enforcement boundary.
 */
export async function logAuditEvent(
  orgId: string,
  actorId: string | null,
  action: AuditAction,
  targetId?: string,
  metadata?: Prisma.InputJsonValue | null,
  tx?: Prisma.TransactionClient
) {
  // metadata.source is a TOP-LEVEL JSON key (R4 metadata contract). It is
  // read at the top level only — nested "source" values are not recognized.
  const source =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as { source?: unknown }).source
      : undefined

  if (actorId === null) {
    // Null-actor exception: public storefront/API checkout ONLY.
    if (action !== "CREATE_ORDER" || source !== STOREFRONT_API_SOURCE) {
      throw new DomainError(
        "VALIDATION",
        "Audit events require an authenticated actor."
      )
    }
  } else if (source === STOREFRONT_API_SOURCE) {
    // Server-authorship: no merchant-authenticated path may claim system
    // origin. (Client input never reaches metadata.source — it is derived
    // server-side from the checkout path; this guard is the backstop.)
    throw new DomainError(
      "FORBIDDEN",
      "System-origin attribution cannot be claimed by an authenticated actor."
    )
  }

  const client = tx ?? prisma

  // Append-only: We do not have UPDATE or DELETE functions for AuditLog
  await client.auditLog.create({
    data: {
      organizationId: orgId,
      actorId,
      action,
      targetId,
      metadata: metadata || {},
    }
  })
}
