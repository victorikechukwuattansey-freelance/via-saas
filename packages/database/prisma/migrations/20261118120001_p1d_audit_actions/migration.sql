/*
  P1-D Migration D3 (PD-D5, R-5): widen AuditAction.

  Four additive values (owner-approved: three from PD-D5, the fourth from the
  R-5 correction pass):
    ADJUST_INVENTORY     - replaces the UPDATE_PRODUCT-with-metadata event
                           written by adjustInventory (§6.6).
    STOCK_COUNT_START    - a count was opened (auto-populated).
    STOCK_COUNT_APPROVE  - a count was approved (corrective movements).
    STOCK_COUNT_CANCEL   - a count was cancelled (no stock effect).

  SEQUENCING GUARANTEE (R4 §8, same discipline as migration
  20261116120000_p1b_orders_a): PostgreSQL cannot USE a new enum value inside
  the transaction that adds it. No statement in this file references any of
  the values - the code that writes them runs later, after this migration
  commits. Adding several values in one transaction is permitted because none
  is used here.

  Downgrade requires recreating the type (documented in plan §13); no
  pre-created downgrade migration exists.

  Additive and non-destructive: existing AuditLog rows and their actions are
  untouched.
*/

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'ADJUST_INVENTORY';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'STOCK_COUNT_START';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'STOCK_COUNT_APPROVE';

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'STOCK_COUNT_CANCEL';
