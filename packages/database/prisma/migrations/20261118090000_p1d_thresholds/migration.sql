-- P1-D migration D1 (P1-21): nullable low-stock threshold per variant.
-- Additive only: a nullable column, no backfill, no data rewrites.
-- NULL = threshold disabled (exact legacy semantics preserved).
-- Evaluation is read-time (quantity <= threshold at a location); negative
-- values are rejected server-side (R-8), so no CHECK constraint is required
-- for legacy rows — existing rows are all NULL after this migration.
ALTER TABLE "ProductVariant" ADD COLUMN "lowStockThreshold" INTEGER;
