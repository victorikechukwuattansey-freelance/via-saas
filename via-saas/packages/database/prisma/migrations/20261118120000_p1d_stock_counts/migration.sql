/*
  P1-D Migration D2 (P1-22): stock counts.

  Additive only: two new tables plus their enums, indexes and foreign keys.
  No existing table, column, row, or constraint is touched, and no data is
  backfilled - pre-P1-D databases simply gain two empty tables.

  Contents (plan §6.3/§9):
  - StockCountStatus enum (OPEN | APPROVED | CANCELLED) - the approved state
    machine; there is no fourth state.
  - StockCount: org/location ownership, sequential per-org count number,
    lifecycle timestamps, creator/approver attribution.
  - StockCountLine: one line per (count, variant) with the opening
    expectedQty snapshot and the entered countedQty (nullable until entered).
  - @@unique([countId, variantId]) (R-1) + @@index([countId]) - the duplicate
    -line guarantee is enforced by the database, not just the application.
  - Indexes on StockCount organizationId / locationId / status (plan §9), plus
    @@unique([organizationId, countNumber]) so the sequential number can never
    collide even under a concurrent opening.

  SEQUENCING: this migration introduces no AuditAction values, so it carries
  no enum-usage hazard. The AuditAction widening is migration D3 (a separate
  transaction boundary) and uses none of the values it adds.
*/

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('OPEN', 'APPROVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "countNumber" INTEGER NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "countedQty" INTEGER,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockCount_organizationId_idx" ON "StockCount"("organizationId");

-- CreateIndex
CREATE INDEX "StockCount_locationId_idx" ON "StockCount"("locationId");

-- CreateIndex
CREATE INDEX "StockCount_status_idx" ON "StockCount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_organizationId_countNumber_key" ON "StockCount"("organizationId", "countNumber");

-- CreateIndex
CREATE INDEX "StockCountLine_countId_idx" ON "StockCountLine"("countId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_variantId_key" ON "StockCountLine"("countId", "variantId");

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCount" ADD CONSTRAINT "StockCount_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
