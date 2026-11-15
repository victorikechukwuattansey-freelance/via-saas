import { prisma } from "@via-saas/database"
import { logAuditEvent } from "./audit"

export async function processCheckout(
  orgId: string, 
  locationId: string, 
  actorId: string, 
  items: { variantId: string; quantity: number; price: number }[],
  paymentMethod: "CASH" | "TRANSFER",
  customerId?: string
) {
  const totalAmount = items.reduce((sum, item) => sum + (item.price * item.quantity), 0)

  try {
    // Attempt to process the order and deduct inventory atomically
    return await prisma.$transaction(async (tx) => {
      // 1. Atomically deduct inventory. If any item doesn't have enough stock, this throws an error.
      for (const item of items) {
        const updateResult = await tx.inventory.updateMany({
          where: { 
            locationId, 
            variantId: item.variantId, 
            quantity: { gte: item.quantity } // The magic check
          },
          data: { quantity: { decrement: item.quantity } }
        })

        if (updateResult.count === 0) {
          throw new Error(`INSUFFICIENT_STOCK_${item.variantId}`)
        }
      }

      // 2. Create the Order (Status: FULFILLED because stock was successfully deducted)
      const order = await tx.order.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId,
          orderNumber: `ORD-${Math.floor(Math.random() * 10000)}`,
          status: "FULFILLED",
          paymentStatus: paymentMethod === "CASH" ? "PAID" : "UNPAID",
          totalAmount,
        }
      })

      // 3. Create Order Items & Stock Movements
      for (const item of items) {
        await tx.orderItem.create({
          data: { orderId: order.id, variantId: item.variantId, quantity: item.quantity, unitPrice: item.price }
        })

        await tx.stockMovement.create({
          data: {
            locationId,
            variantId: item.variantId,
            actorId,
            type: "SALE",
            quantity: -item.quantity,
            referenceId: order.id
          }
        })
      }

      return order
    })
  } catch (error: any) {
    // If the error is a stock issue, we handle the "ATTENTION" state
    if (error.message.includes("INSUFFICIENT_STOCK")) {
      console.warn("Stock conflict detected. Creating ATTENTION order.")
      
      // Create the order as ATTENTION *without* deducting stock
      return await prisma.order.create({
        data: {
          organizationId: orgId,
          locationId,
          customerId,
          orderNumber: `ORD-${Math.floor(Math.random() * 10000)}`,
          status: "ATTENTION",
          paymentStatus: paymentMethod === "CASH" ? "PAID" : "UNPAID",
          totalAmount,
          items: {
            create: items.map(item => ({
              variantId: item.variantId,
              quantity: item.quantity,
              unitPrice: item.price
            }))
          }
        }
      })
    }
    
    // If it's a database check constraint error (P2004), catch it as a fallback
    if (error.code === 'P2004') {
       console.error("Database constraint prevented negative stock.")
       throw new Error("Stock level cannot go below zero.")
    }

    throw error // Throw other unexpected errors
  }
}

export async function resolveAttentionOrder(orgId: string, actorId: string, orderId: string, action: "FULFILL" | "CANCEL") {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true }
    })

    if (!order || order.status !== "ATTENTION") {
      throw new Error("Order not found or not in ATTENTION state.")
    }

    if (action === "CANCEL") {
      // Refund the order
      return tx.order.update({
        where: { id: orderId },
        data: {
          status: "CANCELLED",
          paymentStatus: order.paymentStatus === "PAID" ? "REFUNDED" : "UNPAID"
        }
      })
    }

    if (action === "FULFILL") {
      // Deduct inventory now (assuming the merchant restocked their physical shelves)
      for (const item of order.items) {
        const updateResult = await tx.inventory.updateMany({
          where: { 
            locationId: order.locationId, 
            variantId: item.variantId, 
            quantity: { gte: item.quantity } 
          },
          data: { quantity: { decrement: item.quantity } }
        })

        if (updateResult.count === 0) {
          throw new Error(`STILL_INSUFFICIENT_STOCK_${item.variantId}`)
        }
        
        await tx.stockMovement.create({
          data: {
            locationId: order.locationId,
            variantId: item.variantId,
            actorId: "SYSTEM", // or pass current user
            type: "SALE",
            quantity: -item.quantity,
            referenceId: order.id
          }
        })
      }

      await logAuditEvent(orgId, actorId, "RESOLVE_ORDER", order.id, { resolution: action })

      return tx.order.update({
        where: { id: orderId },
        data: { status: "FULFILLED" }
      })
    }
  })
}
