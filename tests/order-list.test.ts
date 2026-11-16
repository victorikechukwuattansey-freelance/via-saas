// P1-B orders list + detail loaders — B-AC6..8, B-AC27..28.
//
// Covers: bounded pagination with deterministic ordering and safe page-param
// handling (B-AC27), unauthorized-location fail-closed behavior (B-AC28),
// and the order-detail loader's render data + fail-closed scoping (B-AC6/7).
// B-AC8 (print stylesheet) is verified by asserting the co-located CSS file
// exists and carries the print rules.
import { describe, expect, it, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "@via-saas/database";
import {
  loadOrderDetail,
  loadOrdersPage,
  parseOrdersPageParam,
  ORDERS_PAGE_SIZE,
} from "../apps/merchant-dashboard/lib/orders";
import { createOrganizationFixture, type OrgFixture } from "./helpers";

let org: OrgFixture;
const createdOrderIds: string[] = [];

beforeAll(async () => {
   // Clear any stale audit-kill triggers left by parallel test files
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS p1b_fail_audit_insert() CASCADE`)
  
  org = await createOrganizationFixture({ locationCount: 2 });

  // Seed 45 orders with IDENTICAL createdAt so the deterministic id
  // tiebreaker is genuinely exercised (B-AC27).
  const stamp = new Date("2026-11-16T10:00:00.000Z");
  const rows = Array.from({ length: 45 }, (_, i) => ({
    organizationId: org.org.id,
    locationId: org.locations[i % 2].id,
    orderNumber: `TEST-LST-${stamp.getTime()}-${String(i).padStart(3, "0")}`,
    status: "FULFILLED" as const,
    paymentStatus: "UNPAID" as const,
    totalAmount: (i + 1) * 100,
    createdAt: stamp,
  }));
  const inserted = await prisma.order.createMany({ data: rows });
  expect(inserted.count).toBe(45);

  const seeded = await prisma.order.findMany({
    where: {
      organizationId: org.org.id,
      orderNumber: { startsWith: "TEST-LST-" },
    },
    select: { id: true },
  });
  createdOrderIds.push(...seeded.map((o) => o.id));
});

describe("B-AC27 — pagination bounds and deterministic ordering", () => {
  it("parseOrdersPageParam coerces junk to page 1 and accepts sane values", () => {
    expect(parseOrdersPageParam(undefined)).toBe(1);
    expect(parseOrdersPageParam(null)).toBe(1);
    expect(parseOrdersPageParam("")).toBe(1);
    expect(parseOrdersPageParam("abc")).toBe(1);
    expect(parseOrdersPageParam("-3")).toBe(1);
    expect(parseOrdersPageParam("0")).toBe(1);
    expect(parseOrdersPageParam("999999999999")).toBe(1); // absurd → reset
    expect(parseOrdersPageParam("2")).toBe(2);
    expect(parseOrdersPageParam("10")).toBe(10);
  });

  it("returns bounded pages in deterministic order (createdAt desc + id tiebreaker)", async () => {
    const page1 = await loadOrdersPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
    });

    expect(page1.orders).toHaveLength(ORDERS_PAGE_SIZE);
    expect(page1.total).toBe(45);
    expect(page1.totalPages).toBe(3);
    expect(page1.page).toBe(1);

    // Ordering: createdAt equal → id desc tiebreaker.
    for (let i = 1; i < page1.orders.length; i++) {
      const prev = page1.orders[i - 1];
      const cur = page1.orders[i];
      expect(prev.createdAt.getTime()).toBeGreaterThanOrEqual(
        cur.createdAt.getTime(),
      );
      if (prev.createdAt.getTime() === cur.createdAt.getTime()) {
        expect(prev.id > cur.id).toBe(true);
      }
    }

    const page2 = await loadOrdersPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      pageParam: "2",
    });
    expect(page2.orders).toHaveLength(ORDERS_PAGE_SIZE);
    expect(page2.page).toBe(2);
    // Pages do not overlap.
    const p1Ids = new Set(page1.orders.map((o) => o.id));
    for (const order of page2.orders) expect(p1Ids.has(order.id)).toBe(false);

    const page3 = await loadOrdersPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      pageParam: "3",
    });
    expect(page3.orders).toHaveLength(5);
  });

  it("an out-of-range page is clamped to the last real page (never a 500, never unbounded)", async () => {
    const page99 = await loadOrdersPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      pageParam: "99",
    });
    expect(page99.page).toBe(3);
    expect(page99.orders.length).toBeGreaterThan(0);
  });
});

describe("B-AC28 — unauthorized location ids cannot expose orders", () => {
  it("a tampered ?location= outside the accessible set yields NO rows (fail closed)", async () => {
    // org.locations[1] is real but deliberately NOT in the accessible set.
    const result = await loadOrdersPage({
      orgId: org.org.id,
      accessibleLocationIds: [org.locations[0].id],
      locationParam: org.locations[1].id,
    });

    expect(result.orders).toHaveLength(0);
    expect(result.unauthorizedLocation).toBe(true);
  });

  it("a nonexistent location id also yields no rows (fail closed)", async () => {
    const result = await loadOrdersPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      locationParam: "loc-does-not-exist",
    });
    expect(result.orders).toHaveLength(0);
  });

  it("an accessible location filter returns only that location's orders", async () => {
    const result = await loadOrdersPage({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
      locationParam: org.locations[0].id,
    });
    expect(result.orders.length).toBeGreaterThan(0);
    for (const order of result.orders) {
      expect(order.locationId).toBe(org.locations[0].id);
    }
  });

  it("another organization's ids never leak data (org-scoped query)", async () => {
    const otherOrg = await createOrganizationFixture();
    const result = await loadOrdersPage({
      orgId: otherOrg.org.id,
      accessibleLocationIds: otherOrg.locations.map((l) => l.id),
    });
    // The other org's orders do not include any of the seeded ones.
    for (const order of result.orders) {
      expect(createdOrderIds).not.toContain(order.id);
    }
  });
});

describe("B-AC6/B-AC7 — order detail loader", () => {
  it("loads full render data for an org's own order: number, dates, status, payment status, item lines with snapshot prices, customer, location, movements (B-AC6)", async () => {
    // Build a real order through the normal path so items + movements exist.
    const { processCheckout } = await import("@via-saas/core");
    const { createProductFixture } = await import("./helpers");
    const product = await createProductFixture(
      org.org.id,
      org.locations[0].id,
      { price: 5000, stock: 20 },
    );

    // 1. CREATE THE CUSTOMER
    const customer = await prisma.customer.create({
      data: {
        organizationId: org.org.id,
        name: "Test Customer",
        phone: "1234567890",
      },
    });

    // 2. PASS customer.id AS THE 6TH ARGUMENT
    const order = await processCheckout(
      org.org.id,
      org.locations[0].id,
      org.user.id,
      [{ variantId: product.variantId, quantity: 2 }],
      "TRANSFER",
      customer.id, // <--- THIS was missing
    );

    const detail = await loadOrderDetail(org.org.id, order.id);
    expect(detail).not.toBeNull();

    const loaded = detail!;
    expect(loaded.order.orderNumber).toBe(order.orderNumber);
    expect(loaded.order.createdAt).toBeInstanceOf(Date);
    expect(loaded.order.status).toBe("FULFILLED");
    expect(loaded.order.paymentStatus).toBe("UNPAID");
    expect(loaded.order.paymentMethod).toBe("TRANSFER");
    expect(loaded.order.location.id).toBe(org.locations[0].id);
    expect(loaded.order.location.name).toBeTruthy();

    // 3. THIS ASSERTION WILL NOW PASS
    expect(loaded.order.customer).not.toBeNull();
    expect(loaded.order.customer?.name).toBe("Test Customer");

    expect(loaded.order.items).toHaveLength(1);
    expect(Number(loaded.order.items[0].unitPrice)).toBe(5000); // snapshot price
    expect(loaded.order.items[0].variant.product.name).toBeTruthy();
    // Movements: the SALE rows are visible (receipt-record evidence block).
    expect(loaded.movements).toHaveLength(1);
    expect(loaded.movements[0].type).toBe("SALE");
    expect(loaded.movements[0].quantity).toBe(-2);
    expect(loaded.movements[0].actorId).toBe(org.user.id);
  });
  it("fails closed on a cross-org order id — same uniform null as nonexistent (B-AC7)", async () => {
    const { processCheckout } = await import("@via-saas/core");
    const { createProductFixture } = await import("./helpers");
    const otherOrg = await createOrganizationFixture();
    const product = await createProductFixture(
      otherOrg.org.id,
      otherOrg.locations[0].id,
      { price: 1000, stock: 5 },
    );

    const foreignOrder = await processCheckout(
      otherOrg.org.id,
      otherOrg.locations[0].id,
      otherOrg.user.id,
      [{ variantId: product.variantId, quantity: 1 }],
      "CASH",
    );

    // Cross-org → null (no data, no existence leak).
    expect(await loadOrderDetail(org.org.id, foreignOrder.id)).toBeNull();
    // Nonexistent → null (indistinguishable from cross-org).
    expect(await loadOrderDetail(org.org.id, "no-such-order-id")).toBeNull();
  });

  it("rejects malformed ids without a query", async () => {
    expect(await loadOrderDetail(org.org.id, "")).toBeNull();
  });
});

describe("B-AC8 — detail page printable (print stylesheet present, no PDF generation)", () => {
  it("the co-located print.css exists and hides screen chrome for print", () => {
    const cssPath = resolve(
      __dirname,
      "../apps/merchant-dashboard/app/(dashboard)/orders/[orderId]/print.css",
    );
    expect(existsSync(cssPath)).toBe(true);

    const css = readFileSync(cssPath, "utf8");
    expect(css).toContain("@media print");
    expect(css).toMatch(/\.no-print/);
  });

  it("no PDF generation exists anywhere in the dashboard app (browser print only)", () => {
    const { readdirSync, statSync } = require("node:fs");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
          const content = readFileSync(full, "utf8");
          if (/pdfkit|jspdf|puppeteer|generate-pdf/i.test(content))
            hits.push(full);
        }
      }
    };
    walk(resolve(__dirname, "../apps/merchant-dashboard"));
    expect(hits).toEqual([]);
  });
});
