ALTER TABLE "Inventory" ADD CONSTRAINT "inventory_quantity_non_negative" CHECK ("quantity" >= 0);
