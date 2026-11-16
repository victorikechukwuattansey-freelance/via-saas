/*
  P1-B Migration A (additive, D-G sequencing — part 1 of 2):
  - Widen AuditAction with the order-side X-2 events: CREATE_ORDER,
    CANCEL_ORDER, PAYMENT_RECORDED (existing five values untouched).
  - Order.idempotencyKey + Order.requestFingerprint + org-scoped unique index
    (D-C checkout idempotency).
  - Order.paymentMethod PaymentMethod (new enum CASH/TRANSFER, D-D); nullable
    — existing records remain valid (NULL).
  - AuditLog.actorId NOT NULL -> nullable (D-G), via drop-FK / alter / recreate-FK
    so the FK contract (ON DELETE RESTRICT, same name) is preserved exactly.

  SEQUENCING GUARANTEE (R4 §8): the newly added enum values are NOT used
  anywhere in this migration (no CHECK, no statement referencing them).
  PostgreSQL 15 permits ALTER TYPE ... ADD VALUE inside a transaction, but a
  new value cannot be USED until the transaction that adds it commits. The
  CHECK constraint that references CREATE_ORDER therefore lives in the
  SEPARATE, LATER migration 20261116120001_p1b_orders_b — its own commit
  boundary — which must run only after this migration has completed
  successfully. No statement here relies on undocumented transaction-wrapping
  behavior.

  Additive and non-destructive: every existing AuditLog row has a non-null
  actorId (the helper required one), so the relaxation affects new rows only.
*/

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER');

-- AlterEnum (widening only — the new values are not referenced in this file)
ALTER TYPE "AuditAction" ADD VALUE 'CREATE_ORDER';
ALTER TYPE "AuditAction" ADD VALUE 'CANCEL_ORDER';
ALTER TYPE "AuditAction" ADD VALUE 'PAYMENT_RECORDED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "idempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN     "requestFingerprint" TEXT;
ALTER TABLE "Order" ADD COLUMN     "paymentMethod" "PaymentMethod";

-- CreateIndex (D-C: org-scoped idempotency-key uniqueness; NULLs are distinct)
CREATE UNIQUE INDEX "Order_organizationId_idempotencyKey_key" ON "Order"("organizationId", "idempotencyKey");

-- AuditLog.actorId relaxation (D-G): preserve the FK shape exactly.
-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

-- AddForeignKey (recreated with the original name and behavior)
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
