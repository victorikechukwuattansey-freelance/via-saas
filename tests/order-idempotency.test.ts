// P1-B checkout idempotency (D-C / P1-08 support) — B-AC21..24.
//
// Covers: same-key sequential replay AND parallel concurrency (exactly one
// order), mismatched-payload conflict, failed checkout frees the key (both
// pre-transaction validation failures and in-transaction rollback), POS
// always-keyed vs unkeyed public API behavior, and fingerprint stability.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@via-saas/database";
import { AuditAction, Prisma } from "@prisma/client"; // ← AuditAction must be here
import { processCheckout } from "@via-saas/core";
import { buildApp } from "../apps/api/src/app";
import {
  createOrganizationFixture,
  createProductFixture,
  type OrgFixture,
  type VariantFixture,
} from "./helpers";

const app = buildApp();

let org: OrgFixture;
let productA: VariantFixture;
let productB: VariantFixture;

beforeAll(async () => {
  // Clear any stale triggers left by parallel test files
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS p1b_fail_audit_insert() CASCADE`,
  );
  await app.ready();
  org = await createOrganizationFixture({ locationCount: 1 });
  productA = await createProductFixture(org.org.id, org.locations[0].id, {
    price: 5000,
    stock: 100,
  });
  productB = await createProductFixture(org.org.id, org.locations[0].id, {
    price: 3000,
    stock: 100,
  });
});

describe("B-AC21 — same key + same payload returns the original order", () => {
  it("sequential replay returns the SAME order; no duplicate order, no second audit", async () => {
    const key = `idem-seq-${Date.now()}-${Math.random()}`;
    const payload = {
      items: [{ variantId: productA.variantId, quantity: 2 }],
      paymentMethod: "TRANSFER" as const,
    };

    const first = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      payload.items,
      payload.paymentMethod,
      undefined,
      key,
    );
    const replay = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      payload.items,
      payload.paymentMethod,
      undefined,
      key,
    );

    expect(replay.id).toBe(first.id);
    expect(replay.orderNumber).toBe(first.orderNumber);

    const ordersWithKey = await prisma.order.count({
      where: { organizationId: org.org.id, idempotencyKey: key },
    });
    expect(ordersWithKey).toBe(1);

    // Exactly one CREATE_ORDER audit event for the replayed order.
    const audits = await prisma.auditLog.findMany({
      where: { targetId: first.id, action: "CREATE_ORDER" },
    });
    expect(audits).toHaveLength(1);
  });

  it("fingerprint is stable across submission-order and customer-resolution cosmetics", async () => {
    const key = `idem-fp-${Date.now()}-${Math.random()}`;
    // Same items, reversed order → same fingerprint → replay (not conflict).
    const first = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [
        { variantId: productA.variantId, quantity: 1 },
        { variantId: productB.variantId, quantity: 2 },
      ],
      "TRANSFER",
      undefined,
      key,
    );
    const replay = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [
        { variantId: productB.variantId, quantity: 2 },
        { variantId: productA.variantId, quantity: 1 },
      ],
      "TRANSFER",
      undefined,
      key,
    );
    expect(replay.id).toBe(first.id);
  });

  it("parallel concurrency: exactly one order is created; both callers receive the original", async () => {
    // 1. CAPTURE STOCK RIGHT HERE (before the concurrent calls)
    const invBefore = await prisma.inventory.findUnique({
      where: {
        locationId_variantId: {
          locationId: org.locations[0].id,
          variantId: productA.variantId,
        },
      },
    });
    const stockBefore = invBefore!.quantity;

    const key = "parallel-key-123";

    // 2. FIRE CONCURRENT REQUESTS
    //    Fingerprint is computed server-side from the payload — no need to
    //    construct it in the test. Same key + same payload → one order.
    const [r1, r2] = await Promise.all([
      processCheckout(
        org.org.id,
        org.locations[0].id,
        org.user.id,
        [{ variantId: productA.variantId, quantity: 1 }],
        "CASH",
        undefined,
        key,
      ),
      processCheckout(
        org.org.id,
        org.locations[0].id,
        org.user.id,
        [{ variantId: productA.variantId, quantity: 1 }],
        "CASH",
        undefined,
        key,
      ),
    ]);

    expect(r1.id).toBe(r2.id); // Both callers receive the same order

    // 3. ASSERT EXACTLY ONE DEDUCTION
    const invAfter = await prisma.inventory.findUnique({
      where: {
        locationId_variantId: {
          locationId: org.locations[0].id,
          variantId: productA.variantId,
        },
      },
    });
    expect(invAfter?.quantity).toBe(stockBefore - 1);

    // 4. Exactly one CREATE_ORDER audit.
    const audits = await prisma.auditLog.findMany({
      where: { targetId: r1.id, action: AuditAction.CREATE_ORDER },
    });
    expect(audits).toHaveLength(1);
  });
});

describe("B-AC22 — same key + different payload returns a conflict", () => {
  it("rejects a different cart with the same key; no new order", async () => {
    const key = `idem-conf-${Date.now()}-${Math.random()}`;
    const first = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: productA.variantId, quantity: 1 }],
      "TRANSFER",
      undefined,
      key,
    );

    await expect(
      processCheckout(
        org.org.id,
        org.locations[0].id,
        org.user.id,
        [{ variantId: productA.variantId, quantity: 2 }],
        "TRANSFER",
        undefined,
        key,
      ),
    ).rejects.toThrow(
      "This order was already submitted with different details.",
    );

    // Also conflicts on a different payment method.
    await expect(
      processCheckout(
        org.org.id,
        org.locations[0].id,
        org.user.id,
        [{ variantId: productA.variantId, quantity: 1 }],
        "CASH",
        undefined,
        key,
      ),
    ).rejects.toThrow(
      "This order was already submitted with different details.",
    );

    const ordersWithKey = await prisma.order.findMany({
      where: { organizationId: org.org.id, idempotencyKey: key },
    });
    expect(ordersWithKey).toHaveLength(1);
    expect(ordersWithKey[0].id).toBe(first.id);
  });

  it("keys are organization-scoped: the same key in another org is independent", async () => {
    const otherOrg = await createOrganizationFixture();
    const otherProduct = await createProductFixture(
      otherOrg.org.id,
      otherOrg.locations[0].id,
      { price: 5000, stock: 10 },
    );
    const key = `idem-scope-${Date.now()}-${Math.random()}`;

    const first = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: productA.variantId, quantity: 1 }],
      "TRANSFER",
      undefined,
      key,
    );
    const second = await processCheckout(
      otherOrg.org.id,
      otherOrg.locations[0].id,
      otherOrg.user.id,
      [{ variantId: otherProduct.variantId, quantity: 1 }],
      "TRANSFER",
      undefined,
      key,
    );

    expect(second.id).not.toBe(first.id);
  });
});

describe("B-AC23 — failed checkout does not reserve an unusable key", () => {
  it("pre-transaction failure (unavailable item) leaves the key free for a corrected retry", async () => {
    const key = `idem-retry-${Date.now()}-${Math.random()}`;

    await expect(
      processCheckout(
        org.org.id,
        org.locations[0].id,
        org.user.id,
        [{ variantId: "no-such-variant", quantity: 1 }],
        "TRANSFER",
        undefined,
        key,
      ),
    ).rejects.toThrow();

    // Nothing was persisted with the key.
    const withKey = await prisma.order.findMany({
      where: { organizationId: org.org.id, idempotencyKey: key },
    });
    expect(withKey).toHaveLength(0);

    // Corrected retry with the SAME key succeeds.
    const retry = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: productA.variantId, quantity: 1 }],
      "TRANSFER",
      undefined,
      key,
    );
    expect(retry.idempotencyKey).toBe(key);
  });

  it("in-transaction rollback (forced audit failure) frees the key for a corrected retry", async () => {
    const key = `idem-tx-${Date.now()}-${Math.random()}`;

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION p1b_fail_audit_idem() RETURNS trigger AS $$
      BEGIN
        IF NEW."metadata"->>'source' = 'DASHBOARD' THEN
          RAISE EXCEPTION 'forced audit failure (idempotency test)';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER p1b_kill_audit_idem BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION p1b_fail_audit_idem()`,
    );

    try {
      await expect(
        processCheckout(
          org.org.id,
          org.locations[0].id,
          org.user.id,
          [{ variantId: productA.variantId, quantity: 1 }],
          "TRANSFER",
          undefined,
          key,
        ),
      ).rejects.toThrow(/forced audit failure/);

      // The whole transaction rolled back: no order carries the key.
      const withKey = await prisma.order.findMany({
        where: { organizationId: org.org.id, idempotencyKey: key },
      });
      expect(withKey).toHaveLength(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS p1b_kill_audit_idem ON "AuditLog"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS p1b_fail_audit_idem()`,
      );
    }

    // Corrected retry with the SAME key now succeeds.
    const retry = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: productA.variantId, quantity: 1 }],
      "TRANSFER",
      undefined,
      key,
    );
    expect(retry.idempotencyKey).toBe(key);
    expect(retry.requestFingerprint).not.toBeNull();
  });

  it("an ATTENTION order consumes the key but remains replayable (no unusable key)", async () => {
    const attentionProduct = await createProductFixture(
      org.org.id,
      org.locations[0].id,
      { price: 1000, stock: 1 },
    );
    const key = `idem-att-${Date.now()}-${Math.random()}`;

    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "TRANSFER",
      undefined,
      key,
    );
    expect(order.status).toBe("ATTENTION");
    expect(order.idempotencyKey).toBe(key);

    // Replay with the same key returns the same ATTENTION order.
    const replay = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: attentionProduct.variantId, quantity: 5 }],
      "TRANSFER",
      undefined,
      key,
    );
    expect(replay.id).toBe(order.id);
  });
});

describe("B-AC24 — POS always keyed; unkeyed public API keeps M1 behavior", () => {
  it("unkeyed public-API checkouts create independent orders (no universal idempotency claimed)", async () => {
    const base = {
      storeSlug: org.store.slug,
      items: [{ variantId: productA.variantId, quantity: 1 }],
      customer: { name: "Ada Unkeyed", phone: "08077770001" },
      paymentMethod: "TRANSFER",
      cartToken: `tok-${Date.now()}`,
    };

    const r1 = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: base,
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: base,
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().orderNumber).not.toBe(r1.json().orderNumber);

    // Both orders are unkeyed.
    const unkeyed = await prisma.order.findMany({
      where: { organizationId: org.org.id, idempotencyKey: null },
    });
    const numbers = [r1.json().orderNumber, r2.json().orderNumber];
    expect(unkeyed.filter((o) => numbers.includes(o.orderNumber))).toHaveLength(
      2,
    );
  });

  it("a keyed public-API checkout is idempotent through the same HTTP path", async () => {
    const key = `idem-api-${Date.now()}-${Math.random()}`;
    const base = {
      storeSlug: org.store.slug,
      items: [{ variantId: productA.variantId, quantity: 1 }],
      customer: { name: "Ada Keyed", phone: "08077770002" },
      paymentMethod: "TRANSFER",
      cartToken: `tok-${Date.now()}`,
      idempotencyKey: key,
    };

    const r1 = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: base,
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: base,
    });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().orderNumber).toBe(r1.json().orderNumber);

    const withKey = await prisma.order.count({
      where: { organizationId: org.org.id, idempotencyKey: key },
    });
    expect(withKey).toBe(1);
  });
});
