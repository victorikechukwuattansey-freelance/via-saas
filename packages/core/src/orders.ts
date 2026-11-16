import { prisma } from "@via-saas/database"
import { Prisma, type Order } from "@prisma/client"
import { logAuditEvent } from "./audit"
import { DomainError } from "./errors"

type PricedItem = {
  variantId: string
  quantity: number
  unitPrice: Prisma.Decimal
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

export async function processCheckout(
  orgId: string,
  locationId: string,
  actorId: string | null, // null = system-originated (storefront); never a fake user id
  items: { variantId: string; quantity: number }[],
  paymentMethod: "CASH" | "TRANSFER",
  customerId?: string
) {
  if (paymentMethod !== "CASH" && paymentMethod !== "TRANSFER") {
    throw new DomainError("VALIDATION", "Unsupported payment method.")
  }

  // Tenant authorization: the checkout location must belong to the organization.
  const location = await prisma.location.findFirst({
    where: { id: locationId, store: { organizationId: orgId } },
    select: { id: true },
  })
  if (!location) {
    throw new DomainError("FORBIDDEN", "Invalid checkout location.")
  }

  // Server-authoritative pricing + item ownership (see resolvePricedItems).
  const pricedItems = await resolvePricedItems(orgId, items)
  const totalAmount = computeTotal(pricedItems)

  try {
    // Attempt to process the order and deduct inventory atomically
    return await prisma.$transaction(async (tx) => {
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

      return order
    })
  } catch (error: unknown) {
    // If the error is a stock issue, we handle the "ATTENTION" state
    if (error instanceof DomainError && error.code === "INSUFFICIENT_STOCK") {
      // Create the order as ATTENTION *without* deducting stock
      // (in its own transaction so the order number allocation is race-safe).
      return prisma.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            organizationId: orgId,
            locationId,
            customerId,
            orderNumber: await allocateOrderNumber(tx, orgId),
            status: "ATTENTION",
            paymentStatus: paymentMethod === "CASH" ? "PAID" : "UNPAID",
            totalAmount,
            items: {
              create: pricedItems.map((item) => ({
                variantId: item.variantId,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
              })),
            },
          },
        })
        return order
      })
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
      return tx.order.update({
        where: { id: order.id },
        data: {
          status: "CANCELLED",
          paymentStatus:
            order.paymentStatus === "PAID" ? "REFUNDED" : order.paymentStatus,
        },
      })
    }

    if (action === "FULFILL") {
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

      await logAuditEvent(orgId, actorId, "RESOLVE_ORDER", order.id, { resolution: action })

      return tx.order.update({
        where: { id: order.id },
        data: { status: "FULFILLED" },
      })
    }

    throw new DomainError("VALIDATION", "Unsupported resolution action.")
  })
}
