/*
  P1-C Migration C2 (additive): location lifecycle.
  - Adds Location.archivedAt (soft deactivation; NULL = active). Archive is a
    display/activity deactivation, NOT a stock event: all inventory rows,
    orders, stock movements, and carts are retained untouched (C-AC27).
    Restore clears the field (audited).
  - Adds the (storeId, name) unique index (approved C-D11a): DB-enforced
    per-store name uniqueness. Pre-checked before apply (P1-C section
    14.3.2); duplicate legacy names would abort the migration by design
    (never silently renamed).
  - AMENDED at implementation (owner-approved): adds Location.createdAt and
    Store.createdAt — the plan's deterministic ordering ("createdAt, then
    id", sections 9.1/9.5/10.2, C-AC56) assumed these columns exist; the
    schema had none. NOT NULL DEFAULT now() backfills existing rows
    consistently; new rows receive their true creation time.
*/

-- AddColumn
ALTER TABLE "Location" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Store" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AddColumn
ALTER TABLE "Location" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Location_storeId_name_key" ON "Location"("storeId", "name");
