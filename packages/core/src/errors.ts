// packages/core/src/errors.ts
import { prisma } from "@via-saas/database"

export class DomainError extends Error {
  constructor(
    public readonly code:
      | "VALIDATION"
      | "EMPTY_CART"
      | "ITEM_UNAVAILABLE"
      | "INSUFFICIENT_STOCK"
      | "ORDER_NOT_FOUND"
      | "FORBIDDEN"
      | "EMAIL_TAKEN"
      | "ALREADY_MEMBER"
      | "INVALID_INVITE"
      | "CONFLICT",
    message: string
  ) {
    super(message)
    this.name = "DomainError"
  }
}

// Maps domain errors to user-safe messages; anything else collapses to a
// generic fallback so internals (ids, SQL, provider messages) never leak.
export function toSafeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DomainError) return error.message
  if (error instanceof Error && error.message === "Stock level cannot go below zero.") {
    return error.message
  }
  return fallback
}
