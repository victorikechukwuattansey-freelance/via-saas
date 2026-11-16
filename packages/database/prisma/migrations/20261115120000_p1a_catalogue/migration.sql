/*
  P1-A catalogue (P1.1):
  - Category + Product.categoryId (SetNull)
  - Product.archivedAt (soft archival; history is never destroyed)
  - ProductImage (URL-only images, decision D-3)
  - ProductVariant.organizationId denormalized; SKU and barcode uniqueness
    moves from GLOBAL to PER-ORGANIZATION composite uniques (decision D-2).

  Additive and non-destructive: the denormalized organizationId is added as
  nullable, backfilled from the parent product, then made NOT NULL before any
  new unique index is created. Pre-migration checks on the dev database
  confirmed zero duplicate SKUs and zero duplicate barcodes.
*/

-- DropIndex
-- Global SKU uniqueness retired in favour of per-org composite uniqueness.
DROP INDEX "ProductVariant_sku_key";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "categoryId" TEXT;

-- AlterTable (nullable first — the table already contains rows)
ALTER TABLE "ProductVariant" ADD COLUMN     "organizationId" TEXT;

-- Backfill: copy organizationId from the parent product.
UPDATE "ProductVariant" AS "pv"
SET "organizationId" = "p"."organizationId"
FROM "Product" AS "p"
WHERE "pv"."productId" = "p"."id";

-- Enforce NOT NULL only after the backfill has populated every row.
ALTER TABLE "ProductVariant" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Category_organizationId_idx" ON "Category"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organizationId_name_key" ON "Category"("organizationId", "name");

-- CreateIndex
CREATE INDEX "ProductImage_productId_idx" ON "ProductImage"("productId");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex (created AFTER the backfill, per-org uniqueness, NULLs distinct)
CREATE UNIQUE INDEX "ProductVariant_organizationId_sku_key" ON "ProductVariant"("organizationId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_organizationId_barcode_key" ON "ProductVariant"("organizationId", "barcode");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
