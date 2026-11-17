import { prisma } from "@via-saas/database"
import { Prisma, type Order } from "@prisma/client"
import { createHash } from "node:crypto"
import { logAuditEvent, STOREFRONT_API_SOURCE } from "./audit"
import { DomainError } from "./errors"

type PricedItem = {
  variantId: string
  quantity: number
  unitPrice: Prisma.Decimal
}

/** Metadata contract (R4): source is a TOP-LEVEL JSON key, server-derived. */
type OrderAuditMetadata = {
  source: string
  orderNumber: string
  paymentMethod: "CASH" | "TRANSFER"
  itemCount: number
  total: number
}

/**
 * Allocates the next sequential order number for an organization.
 *
 * Runs INSIDE the checkout transaction: the UPDATE takes the row lock on
 * OrderCounter, so concurrent checkouts serialize and numbers are unique
 * per organization (DB-enforced by Order @@unique([organizationId, orderNumber])).
 */
export async function allocateOrderNumber(
  tx: Prisma.TransactionClient,
  orgId: string
): Promise<string> {
  const counter = await tx.orderCounter.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, lastNumber: 1001 },
    update: { lastNumber: { increment: 1 } },
  })
  return `ORD-${counter.lastNumber}`
}

/**
 * Resolves authoritative prices and ownership for cart items.
 *
 * SECURITY: client-supplied prices are never accepted. Unit prices come from
 * the database (variant.sellingPrice); variants must exist AND belong to the
 * organization. Duplicate variant entries are merged by summing quantities.
 */
async function resolvePricedItems(
  orgId: string,
  items: { variantId: string; quantity: number }[]
): Promise<PricedItem[]> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DomainError("EMPTY_CART", "The cart is empty.")
  }

  const merged = new Map<string, number>()
  for (const item of items) {
    if (
      !item ||
      typeof item.variantId !== "string" ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      throw new DomainError("VALIDATION", "Invalid cart items.")
    }
    merged.set(item.variantId, (merged.get(item.variantId) ?? 0) + item.quantity)
  }

  // Ownership + availability: the variant must exist under this organization
  // AND its product must be PUBLISHED and not archived (P1-A storefront/POS
  // publication contract). Drafts and archived products are not sellable;
  // their history is untouched.
  const variants = await prisma.productVariant.findMany({
    where: {
      id: { in: Array.from(merged.keys()) },
      product: {
        organizationId: orgId,
        status: "PUBLISHED",
        archivedAt: null,
      },
    },
    select: { id: true, sellingPrice: true },
  })

  if (variants.length !== merged.size) {
    throw new DomainError("ITEM_UNAVAILABLE", "One or more items in your cart are unavailable.")
  }

  const priceById = new Map(variants.map((v) => [v.id, v.sellingPrice]))

  return Array.from(merged.entries()).map(([variantId, quantity]) => ({
    variantId,
    quantity,
    unitPrice: priceById.get(variantId)!,
  }))
}

function computeTotal(items: PricedItem[]): Prisma.Decimal {
  return items.reduce(
    (acc, item) => acc.add(new Prisma.Decimal(item.unitPrice).mul(item.quantity)),
    new Prisma.Decimal(0)
  )
}

/**
 * D-C stable request fingerprint: a canonical SHA-256 hash over the
 * MEANINGFUL order input — sorted (variantId, quantity) list, paymentMethod,
 * resolved customerId, checkout locationId. Client-side cosmetics (key
 * casing, item submission order) do not affect it. Computed SERVER-SIDE and
 * persisted with the key.
 */
function computeRequestFingerprint(
  locationId: string,
  paymentMethod: "CASH" | "TRANSFER",
  customerId: string | undefined,
  pricedItems: PricedItem[]
): string {
  const sorted = [...pricedItems]
    .sort((a, b) => a.variantId.localeCompare(b.variantId))
    .map((item) => `${item.variantId}:${item.quantity}`)
    .join(",")
  const canonical = ["v1", locationId, paymentMethod, customerId ?? "", sorted].join("|")
  return createHash("sha256").update(canonical).digest("hex")
}

function isIdempotencyConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta?.target ?? "").includes("idempotencyKey")
  )
}

async function findOrderByIdempotencyKey(
  orgId: string,
  idempotencyKey: string
): Promise<Order | null> {
  return prisma.order.findUnique({
    where: {
      organizationId_idempotencyKey: {
        organizationId: orgId,
        idempotencyKey,
      },
    },
  })
}

/**
 * D-C concurrency settlement: the DB unique constraint is the backstop. When
 * a parallel request with the same key loses the race (P2002), it receives
 * the original order (same fingerprint) or a conflict (different
 * fingerprint) — never a duplicate.
 */
async function settleIdempotentRace(
  orgId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<Order> {
  const existing = await findOrderByIdempotencyKey(orgId, idempotencyKey)
  if (existing && existing.requestFingerprint === fingerprint) {
    return existing
  }
  throw new DomainError(
    "CONFLICT",
    "This order was already submitted with different details."
  )
}

export async function processCheckout(
  orgId: string,
  locationId: string,
  actorId: string | null, // null = system-originated (storefront); never a fake user id
  items: { variantId: string; quantity: number }[],
  paymentMethod: "CASH" | "TRANSFER",
  customerId?: string,
  idempotencyKey?: string | null // D-C: supplied by POS; public API optional
) {
  if (paymentMethod !== "CASH" && paymentMethod !== "TRANSFER") {
    throw new DomainError("VALIDATION", "Unsupported payment method.")
  }

  // D-C: keyed requests are idempotent; unkeyed requests keep M1 behavior
  // (no universal idempotency is claimed).
  let key: string | undefined
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "" || idempotencyKey.length > 200) {
      throw new DomainError("VALIDATION", "Invalid idempotency key.")
    }
    key = idempotencyKey
  }

  // Tenant authorization: the checkout location must belong to the organization
  // AND be active — an archived location is rejected outright (P1-16 pre-check,
  // C-D12 part 1 of 2; the in-tx re-check below is part 2 of 2).
  const location = await prisma.location.findFirst({
    where: { id: locationId, store: { organizationId: orgId }, archivedAt: null },
    select: { id: true },
  })
  if (!location) {
    throw new DomainError("FORBIDDEN", "Invalid checkout location.")
  }

  // Server-authoritative pricing + item ownership (see resolvePricedItems).
  const pricedItems = await resolvePricedItems(orgId, items)
  const totalAmount = computeTotal(pricedItems)

  // D-C: fingerprint is computed server-side over the resolved input.
  const fingerprint = key
    ? computeRequestFingerprint(locationId, paymentMethod, customerId, pricedItems)
    : null

  // D-C replay: same key + same meaningful payload -> return the original
  // order (sequential replay); same key + different payload -> conflict.
  if (key && fingerprint) {
    const existing = await findOrderByIdempotencyKey(orgId, key)
    if (existing) {
      if (existing.requestFingerprint === fingerprint) {
        return existing
      }
      throw new DomainError(
        "CONFLICT",
        "This order was already submitted with different details."
      )
    }
  }

  // Audit metadata contract (R4): source is a TOP-LEVEL JSON key derived
  // SERVER-SIDE from the checkout path — the public API passes a null actor
  // (system origin, stamped in app.ts); dashboard checkout passes the
  // authenticated merchant user. Client input can never control or spoof it.
  const auditMetadata = (orderNumber: string): OrderAuditMetadata => ({
    source: actorId === null ? STOREFRONT_API_SOURCE : "DASHBOARD",
    orderNumber,
    paymentMethod,
    itemCount: pricedItems.reduce((sum, item) => sum + item.quantity, 0),
    total: Number(totalAmount),
  })

  try {
    // Attempt to process the order and deduct inventory atomically
    return await prisma.$transaction(async (tx) => {
      // C-D12 (approved): in-transaction archived-location re-check — closes
      // the archive-vs-checkout race. The archive transition (L1, admin
      // domain) and this transaction's writes serialize at commit; the
      // re-check makes the invariant "no order lands on a location archived
      // at order-commit time" hard (C-AC28). One indexed point-read.
      const activeLocation = await tx.location.findFirst({
        where: { id: locationId, store: { organizationId: orgId }, archivedAt: null },
        select: { id: true },
      })
      if (!activeLocation) {
        throw new DomainError(
          "FORBIDDEN",
          "The checkout location is no longer active."
        )
      }

      // 1. Atomically deduct inventory. If any item doesn't have enough stock,
      //    this throws and the transaction rolls back.
      for (const item of pricedItems) {
        const updateResult = await tx.inventory.updateMany({
          where: {
            locationId,
            variantId: item.variantId,
            quantity: { gte: item.quantity }, // The magic check
          },
          data: { quantity: { decrement: item.quantity } },
        })

        if (updateResult.count === 0) {
          throw new DomainError(
            "INSUFFICIENT_STOCK",
            "Not enough stock for one or more items in your cart."
          )
        }
      }

      // 2. Create the Order (Status: FULFILLED because stock was successfully deducted)
      const order = await tx.order.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId,
          orderNumber: await allocateOrderNumber(tx, orgId),
          status: "FULFILLED",
          paymentStatus: paymentMethod === "CASH" ? "PAID" : "UNPAID",
          totalAmount,
          // D-D: the checkout method is persisted with the order.
          paymentMethod,
          // D-C: key + fingerprint are written in the SAME transaction as the
          // order — a failed checkout rolls all three back, so the key stays
          // usable for a corrected retry.
          idempotencyKey: key ?? null,
          requestFingerprint: fingerprint,
        },
      })

      // 3. Create Order Items & Stock Movements
      for (const item of pricedItems) {
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            variantId: item.variantId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          },
        })

        await tx.stockMovement.create({
          data: {
            locationId,
            variantId: item.variantId,
            actorId: actorId ?? null, // null = system-originated movement
            type: "SALE",
            quantity: -item.quantity,
            referenceId: order.id,
          },
        })
      }

      // 4. B1: exactly one CREATE_ORDER audit event, INSIDE the transaction —
      //    commits or rolls back together with the order. Dashboard checkout
      //    attributes to the authenticated actor; public storefront checkout
      //    is system origin (null actor + STOREFRONT_API source, approved D-G).
      await logAuditEvent(
        orgId,
        actorId,
        "CREATE_ORDER",
        order.id,
        auditMetadata(order.orderNumber),
        tx
      )

      return order
    })
  } catch (error: unknown) {
    // D-C concurrency: a parallel request with the same key won the unique
    // race. The loser's transaction rolled back (no partial state) and it
    // receives the original order or a conflict — never a duplicate.
    if (isIdempotencyConflict(error) && key && fingerprint) {
      return settleIdempotentRace(orgId, key, fingerprint)
    }

    // If the error is a stock issue, we handle the "ATTENTION" state
    if (error instanceof DomainError && error.code === "INSUFFICIENT_STOCK") {
      try {
        // Create the order as ATTENTION *without* deducting stock
        // (in its own transaction so the order number allocation is race-safe).
        return await prisma.$transaction(async (tx) => {
          const order = await tx.order.create({
            data: {
              organizationId: orgId,
              locationId,
              customerId,
              orderNumber: await allocateOrderNumber(tx, orgId),
              status: "ATTENTION",
              paymentStatus: paymentMethod === "CASH" ? "PAID" : "UNPAID",
              totalAmount,
              // D-D: the checkout method is persisted with the order.
              paymentMethod,
              idempotencyKey: key ?? null,
              requestFingerprint: fingerprint,
              items: {
                create: pricedItems.map((item) => ({
                  variantId: item.variantId,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice,
                })),
              },
            },
          })

          // B1: an order row was created in the ATTENTION branch too —
          // exactly one CREATE_ORDER audit event, transaction-bound.
          await logAuditEvent(
            orgId,
            actorId,
            "CREATE_ORDER",
            order.id,
            auditMetadata(order.orderNumber),
            tx
          )

          return order
        })
      } catch (attentionError: unknown) {
        if (isIdempotencyConflict(attentionError) && key && fingerprint) {
          return settleIdempotentRace(orgId, key, fingerprint)
        }
        throw attentionError
      }
    }

    // If it's a database check constraint error (P2004), catch it as a fallback
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2004"
    ) {
      throw new DomainError("INSUFFICIENT_STOCK", "Stock level cannot go below zero.")
    }

    throw error // Throw other unexpected errors
  }
}

export async function resolveAttentionOrder(
  orgId: string,
  actorId: string,
  orderId: string,
  action: "FULFILL" | "CANCEL"
): Promise<Order> {
  // Actor integrity: the actor must be a real member of this organization.
  // (Prevents fabricated user references from ever reaching the FK.)
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: actorId, organizationId: orgId } },
    select: { id: true },
  })
  if (!membership) {
    throw new DomainError("FORBIDDEN", "You are not authorized to resolve orders.")
  }

  return prisma.$transaction(async (tx) => {
    // TENANT AUTHORIZATION: the order must belong to the caller's organization.
    const order = await tx.order.findFirst({
      where: { id: orderId, organizationId: orgId },
      include: { items: true },
    })

    if (!order || order.status !== "ATTENTION") {
      throw new DomainError("ORDER_NOT_FOUND", "Order not found or not resolvable.")
    }

    if (action === "CANCEL") {
      // Refund the order (status-level refund; money movement arrives with P2)
      const cancelled = await tx.order.update({
        where: { id: order.id },
        data: {
          status: "CANCELLED",
          paymentStatus:
            order.paymentStatus === "PAID" ? "REFUNDED" : order.paymentStatus,
        },
      })

      // B1: the ATTENTION CANCEL branch now writes exactly one CANCEL_ORDER
      // audit event, INSIDE the transaction (previously unaudited).
      await logAuditEvent(
        orgId,
        actorId,
        "CANCEL_ORDER",
        order.id,
        {
          items: order.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          locationId: order.locationId,
        },
        tx
      )

      return cancelled
    }

    if (action === "FULFILL") {
      // C-D12 (approved): same in-transaction archived-location re-check as
      // checkout — an order resolved AFTER its location was archived must
      // not deduct stock there. The CANCEL branch above is intentionally
      // unrestricted (C8/C16: cancellation and RETURN are never blocked by
      // archival, and never redirected).
      const activeLocation = await tx.location.findFirst({
        where: { id: order.locationId, store: { organizationId: orgId }, archivedAt: null },
        select: { id: true },
      })
      if (!activeLocation) {
        throw new DomainError(
          "FORBIDDEN",
          "This order's location is archived and cannot be fulfilled."
        )
      }

      // Deduct inventory now (assuming the merchant restocked their physical shelves)
      for (const item of order.items) {
        const updateResult = await tx.inventory.updateMany({
          where: {
            locationId: order.locationId,
            variantId: item.variantId,
            quantity: { gte: item.quantity },
          },
          data: { quantity: { decrement: item.quantity } },
        })

        if (updateResult.count === 0) {
          throw new DomainError(
            "INSUFFICIENT_STOCK",
            "Still not enough stock to fulfill this order."
          )
        }

        // Actor integrity: record the REAL resolving user, never a fake id.
        await tx.stockMovement.create({
          data: {
            locationId: order.locationId,
            variantId: item.variantId,
            actorId, // verified above to be an actual User id passed by the caller
            type: "SALE",
            quantity: -item.quantity,
            referenceId: order.id,
          },
        })
      }

      // B1: the pre-existing RESOLVE_ORDER write is folded onto the
      // transactional mechanism (behavior preserved, atomicity improved).
      await logAuditEvent(orgId, actorId, "RESOLVE_ORDER", order.id, { resolution: action }, tx)

      return tx.order.update({
        where: { id: order.id },
        data: { status: "FULFILLED" },
      })
    }

    throw new DomainError("VALIDATION", "Unsupported resolution action.")
  })
}

/**
 * D-A — order cancellation (P1-09): only FULFILLED + UNPAID orders may be
 * voided. Effects in ONE transaction, concurrency-safe:
 *   - conditional status transition INSIDE the transaction (a status
 *     pre-check outside it is insufficient as the sole guard);
 *   - stock restored EXCLUSIVELY through RETURN StockMovement rows matched
 *     to the original SALE's variant, location and quantity, paired with
 *     the location-scoped inventory increment (never a direct stock edit);
 *   - paymentStatus REMAINS UNPAID (nothing was paid; nothing to refund);
 *   - exactly one CANCEL_ORDER audit event, transaction-bound.
 * PAID, CANCELLED and REFUNDED orders are rejected; ATTENTION orders keep
 * their dedicated resolution path (resolve-button semantics preserved).
 */
export async function cancelOrder(
  orgId: string,
  actorId: string,
  orderId: string,
  options?: { reason?: string }
): Promise<Order> {
  const reason = options?.reason
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    throw new DomainError("VALIDATION", "Invalid cancellation reason.")
  }

  // Actor integrity: the cancelling actor must be a real member of this org.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: actorId, organizationId: orgId } },
    select: { id: true },
  })
  if (!membership) {
    throw new DomainError("FORBIDDEN", "You are not authorized to cancel orders.")
  }

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, organizationId: orgId },
      include: { items: true },
    })

    // Fail closed with the uniform no-leak message pattern.
    if (!order) {
      throw new DomainError("ORDER_NOT_FOUND", "Order not found or not cancellable.")
    }
    if (order.status !== "FULFILLED" || order.paymentStatus !== "UNPAID") {
      throw new DomainError(
        "VALIDATION",
        "Only unpaid fulfilled orders can be cancelled."
      )
    }

    // Conditional transition INSIDE the transaction: only one concurrent
    // request can win; the loser observes count === 0 and aborts before
    // writing any RETURN movement (no double restoration possible).
    const transition = await tx.order.updateMany({
      where: {
        id: order.id,
        organizationId: orgId,
        status: "FULFILLED",
        paymentStatus: "UNPAID",
      },
      data: { status: "CANCELLED" },
    })
    if (transition.count === 0) {
      throw new DomainError("ORDER_NOT_FOUND", "Order not found or not cancellable.")
    }

    // Stock restoration: RETURN movements matched to the original SALE's
    // variant, location and quantity — the location where stock was actually
    // deducted (§4.7.6). Inventory is touched ONLY through the paired
    // location-scoped increment; never edited without a movement record.
    for (const item of order.items) {
      const restore = await tx.inventory.updateMany({
        where: { locationId: order.locationId, variantId: item.variantId },
        data: { quantity: { increment: item.quantity } },
      })
      if (restore.count === 0) {
        throw new DomainError("VALIDATION", "Inventory record missing for restoration.")
      }

      await tx.stockMovement.create({
        data: {
          locationId: order.locationId,
          variantId: item.variantId,
          actorId,
          type: "RETURN",
          quantity: item.quantity, // positive — restoration
          referenceId: order.id,
        },
      })
    }

    // Exactly one CANCEL_ORDER audit event, atomic with the void. The
    // optional cancel-reason (canonical D.5 item 3) rides in the metadata —
    // no new column.
    const auditMetadata: Prisma.InputJsonValue = {
      items: order.items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
      })),
      locationId: order.locationId,
      ...(reason !== undefined ? { reason } : {}),
    }
    await logAuditEvent(orgId, actorId, "CANCEL_ORDER", order.id, auditMetadata, tx)

    return tx.order.findUniqueOrThrow({ where: { id: order.id } })
  })
}

/**
 * D-B/D-D — "Record payment received": a merchant user's CONFIRMATION that
 * payment was received. It does NOT verify a bank transfer, query any
 * provider, or move money (provider verification remains P2 / blueprint F.4).
 *
 * Eligibility: TRANSFER + UNPAID + FULFILLED only. The state FULFILLED +
 * UNPAID uniquely identifies TRANSFER orders under the preserved M1
 * semantics (D-E: CASH is PAID at creation), so the guarded condition below
 * rejects ATTENTION, CANCELLED, PAID and REFUNDED orders; legacy pre-P1-B
 * TRANSFER orders carry a NULL paymentMethod and remain eligible through
 * this state condition. Effect: paymentStatus UNPAID -> PAID in one atomic,
 * concurrency-safe conditional transition; actor + timestamp recorded via
 * the audit event and updatedAt; exactly one PAYMENT_RECORDED audit event
 * in the same transaction.
 */
export async function recordPaymentReceived(
  orgId: string,
  actorId: string,
  orderId: string
): Promise<Order> {
  // Actor integrity: the recording actor must be a real member of this org.
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId: actorId, organizationId: orgId } },
    select: { id: true },
  })
  if (!membership) {
    throw new DomainError("FORBIDDEN", "You are not authorized to record payments.")
  }

  return prisma.$transaction(async (tx) => {
    const transition = await tx.order.updateMany({
      where: {
        id: orderId,
        organizationId: orgId,
        status: "FULFILLED",
        paymentStatus: "UNPAID",
      },
      data: { paymentStatus: "PAID" },
    })

    if (transition.count === 0) {
      const order = await tx.order.findFirst({
        where: { id: orderId, organizationId: orgId },
        select: { id: true },
      })
      if (!order) {
        throw new DomainError("ORDER_NOT_FOUND", "Order not found or not payable.")
      }
      throw new DomainError(
        "VALIDATION",
        "Only unpaid fulfilled orders can be marked as paid."
      )
    }

    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } })

    // Exactly one PAYMENT_RECORDED event, atomic with the transition —
    // no unaudited successful transition is possible.
    await logAuditEvent(
      orgId,
      actorId,
      "PAYMENT_RECORDED",
      order.id,
      { orderNumber: order.orderNumber, method: order.paymentMethod ?? null },
      tx
    )

    return order
  })
}
