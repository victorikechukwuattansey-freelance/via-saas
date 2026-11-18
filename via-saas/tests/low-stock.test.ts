// P1-D / P1-21: low-stock threshold + read-time indicator tests (plan §6.4).
//
// Covers the PD-3 acceptance criteria:
// - PD-AC33 (R-8): threshold boundary validation — null (= disabled), 0
//   (flags out-of-stock only), positive integers accepted, negative values
//   and non-integers rejected server-side.
// - PD-AC12: threshold set/cleared via the variant editor path; value
//   validation server-side. (The role gate itself is the pre-existing
//   requireCatalogueManager server-action gate — OWNER/MANAGER only —
//   inherited unchanged; see the report note.)
// - PD-AC13: low = quantity <= threshold at READ time; NULL never flags;
//   indicators reflect current quantities at request time (no persisted
//   derived state).
// - PD-AC14: banner/list aggregates only variants at the actor's accessible
//   locations (organization + location isolation).
// - PD-AC34 (R-9): archived products and their variants are excluded from
//   low-stock indicators; the query stays tenant- and location-scoped.
// - PD-AC15: threshold changes ride the existing variant-edit audit event.
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { updateVariant, adjustInventory, archiveProduct } from "@via-saas/core"
import { isLowStock, loadLowStock, loadLowStockVariantIds } from "../apps/merchant-dashboard/lib/low-stock"
import { createOrganizationFixture, createProductFixture } from "./helpers"

describe("PD-AC33 (R-8) — threshold boundary validation (core updateVariant)", () => {
  it("accepts a positive integer and persists it", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 5 })
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantId } })
    expect(variant.lowStockThreshold).toBe(5)
  })

  it("accepts 0 (flags out-of-stock only under PD-D6 semantics)", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 0 })
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantId } })
    expect(variant.lowStockThreshold).toBe(0)
  })

  it("accepts null and disables (clears) the threshold", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 5 })

    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: null })
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantId } })
    expect(variant.lowStockThreshold).toBeNull()
  })

  it("rejects negative values server-side (safe VALIDATION error)", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    await expect(
      updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: -1 })
    ).rejects.toMatchObject({ code: "VALIDATION" })

    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantId } })
    expect(variant.lowStockThreshold).toBeNull()
  })

  it("rejects non-integer values server-side", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    await expect(
      updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 1.5 })
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("leaves the threshold untouched when the field is undefined", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 7 })

    await updateVariant(org.org.id, org.user.id, p.variantId, { name: "Renamed" })
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: p.variantId } })
    expect(variant.lowStockThreshold).toBe(7)
    expect(variant.name).toBe("Renamed")
  })
})

describe("PD-AC15 — threshold changes ride the existing variant-edit audit event", () => {
  it("a threshold-only update writes an UPDATE_PRODUCT audit event", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 3 })

    const audit = await prisma.auditLog.findFirst({
      where: {
        organizationId: org.org.id,
        action: "UPDATE_PRODUCT",
        targetId: p.productId,
        metadata: { path: ["variantId"], equals: p.variantId },
      },
      orderBy: { createdAt: "desc" },
    })
    expect(audit).not.toBeNull()
    expect(audit?.actorId).toBe(org.user.id)
  })

  // F3 closure: the BEFORE/AFTER snapshots must carry the threshold so a
  // threshold change is reconstructable from the audit trail — null
  // (disabled), 0 (out-of-stock only) and positive values all represented
  // accurately, and the pre-existing snapshot fields untouched.
  it("captures old and new threshold values in the before/after snapshots", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })

    // null → 5 (set)
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 5 })
    // 5 → 0 (change to out-of-stock-only)
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 0 })
    // 0 → null (clear / disable)
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: null })

    const audits = await prisma.auditLog.findMany({
      where: {
        organizationId: org.org.id,
        action: "UPDATE_PRODUCT",
        targetId: p.productId,
        metadata: { path: ["action"], equals: "VARIANT_UPDATE" },
      },
    })
    expect(audits).toHaveLength(3)

    type Journal = Record<string, unknown>
    const transitions = audits.map((row) => {
      const meta = row.metadata as Journal
      const before = meta.before as Journal
      const after = meta.after as Journal
      return [before.lowStockThreshold, after.lowStockThreshold] as const
    })

    // All three transitions are captured, with correct old AND new values.
    expect(transitions).toEqual(
      expect.arrayContaining([
        [null, 5],
        [5, 0],
        [0, null],
      ])
    )

    // The pre-existing snapshot fields are untouched: a threshold-only edit
    // still records the other variant fields on both sides.
    for (const row of audits) {
      const meta = row.metadata as Journal
      const before = meta.before as Journal
      const after = meta.after as Journal
      expect(before).toHaveProperty("name")
      expect(before).toHaveProperty("sellingPrice")
      expect(after).toHaveProperty("name")
      expect(after).toHaveProperty("sellingPrice")
    }
  })

  it("records the threshold alongside another edited field in one event", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 4 })

    await updateVariant(org.org.id, org.user.id, p.variantId, {
      name: "Renamed Variant",
      lowStockThreshold: 9,
    })

    const audit = await prisma.auditLog.findFirst({
      where: {
        organizationId: org.org.id,
        action: "UPDATE_PRODUCT",
        targetId: p.productId,
        metadata: { path: ["after", "lowStockThreshold"], equals: 9 },
      },
      orderBy: { createdAt: "desc" },
    })
    expect(audit).not.toBeNull()
    const meta = (audit?.metadata ?? {}) as Record<string, unknown>
    const before = meta.before as Record<string, unknown>
    const after = meta.after as Record<string, unknown>
    expect(before.lowStockThreshold).toBe(4)
    expect(after.lowStockThreshold).toBe(9)
    expect(before.name).toBe("Default")
    expect(after.name).toBe("Renamed Variant")
    // Tenant scope / actor of the existing event are unchanged.
    expect(audit?.organizationId).toBe(org.org.id)
    expect(audit?.actorId).toBe(org.user.id)
  })
})

describe("PD-AC13 — read-time evaluation and boundaries", () => {
  it("isLowStock: low iff quantity <= threshold; NULL never flags", () => {
    expect(isLowStock(0, 0)).toBe(true) // 0 threshold flags out-of-stock
    expect(isLowStock(1, 0)).toBe(false)
    expect(isLowStock(5, 5)).toBe(true) // boundary: equal is low (<=)
    expect(isLowStock(6, 5)).toBe(false)
    expect(isLowStock(0, null)).toBe(false) // NULL threshold never flags
    expect(isLowStock(999, null)).toBe(false)
  })

  it("indicators reflect CURRENT quantities at request time (no persisted state)", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 5 })
    const accessible = org.locations.map((l) => l.id)

    const before = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(before.some((e) => e.variantId === p.variantId)).toBe(false) // 10 > 5

    // Adjust stock down to 3 — the NEXT read flags it, with no persisted
    // low-stock state anywhere.
    await adjustInventory(org.org.id, org.user.id, org.locations[0].id, p.variantId, -7, "sold down")

    const after = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    const entry = after.find((e) => e.variantId === p.variantId)
    expect(entry).toBeDefined()
    expect(entry?.quantity).toBe(3)
    expect(entry?.threshold).toBe(5)
    expect(entry?.locationId).toBe(org.locations[0].id)
    expect(entry?.productName).toBeTruthy()
    expect(entry?.variantName).toBeTruthy()

    // Restock above the threshold → unflags on the next read.
    await adjustInventory(org.org.id, org.user.id, org.locations[0].id, p.variantId, 10, "restock")
    const restocked = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(restocked.some((e) => e.variantId === p.variantId)).toBe(false)
  })

  it("boundary at exactly the threshold flags; one above does not", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 10 })
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 4 })
    const accessible = org.locations.map((l) => l.id)

    await adjustInventory(org.org.id, org.user.id, org.locations[0].id, p.variantId, -6, "to boundary")
    let flagged = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(flagged.some((e) => e.variantId === p.variantId)).toBe(true) // 4 <= 4

    await adjustInventory(org.org.id, org.user.id, org.locations[0].id, p.variantId, 1, "one above")
    flagged = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(flagged.some((e) => e.variantId === p.variantId)).toBe(false) // 5 > 4
  })

  it("a NULL threshold never flags, even at zero quantity", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 0 })
    // Threshold left NULL (disabled).

    const flagged = await loadLowStock({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
    })
    expect(flagged.some((e) => e.variantId === p.variantId)).toBe(false)
  })

  it("a 0 threshold flags ONLY out-of-stock rows", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const pOut = await createProductFixture(org.org.id, org.locations[0].id, { stock: 0 })
    const pIn = await createProductFixture(org.org.id, org.locations[0].id, { stock: 3 })
    await updateVariant(org.org.id, org.user.id, pOut.variantId, { lowStockThreshold: 0 })
    await updateVariant(org.org.id, org.user.id, pIn.variantId, { lowStockThreshold: 0 })
    const accessible = org.locations.map((l) => l.id)

    const flagged = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(flagged.some((e) => e.variantId === pOut.variantId)).toBe(true) // 0 <= 0
    expect(flagged.some((e) => e.variantId === pIn.variantId)).toBe(false) // 3 > 0
  })

  it("badge ids (loadLowStockVariantIds) match the loader entries", async () => {
    const org = await createOrganizationFixture()
    const pLow = await createProductFixture(org.org.id, org.locations[0].id, { stock: 2 })
    const pOk = await createProductFixture(org.org.id, org.locations[0].id, { stock: 20 })
    await updateVariant(org.org.id, org.user.id, pLow.variantId, { lowStockThreshold: 5 })
    await updateVariant(org.org.id, org.user.id, pOk.variantId, { lowStockThreshold: 5 })

    const ids = await loadLowStockVariantIds({
      orgId: org.org.id,
      accessibleLocationIds: org.locations.map((l) => l.id),
    })
    expect(ids.has(pLow.variantId)).toBe(true)
    expect(ids.has(pOk.variantId)).toBe(false)
  })
})

describe("PD-AC34 (R-9) — archived products are excluded from indicators", () => {
  it("a low-stock variant stops being flagged when its product is archived", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 2 })
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 5 })
    const accessible = org.locations.map((l) => l.id)

    const before = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(before.some((e) => e.variantId === p.variantId)).toBe(true)

    await archiveProduct(org.org.id, org.user.id, p.productId)

    const after = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(after.some((e) => e.variantId === p.variantId)).toBe(false)
    // The query stays tenant- and location-scoped — the exclusion is R-9's,
    // not a blanket emptying.
    expect(after.every((e) => accessible.includes(e.locationId))).toBe(true)
  })
})

describe("PD-AC14 — organization and accessible-location isolation", () => {
  it("another org's low-stock variants never appear (org isolation)", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()
    const pB = await createProductFixture(orgB.org.id, orgB.locations[0].id, { stock: 1 })
    await updateVariant(orgB.org.id, orgB.user.id, pB.variantId, { lowStockThreshold: 5 })

    const flaggedA = await loadLowStock({
      orgId: orgA.org.id,
      accessibleLocationIds: orgA.locations.map((l) => l.id),
    })
    expect(flaggedA.some((e) => e.variantId === pB.variantId)).toBe(false)

    // Org B sees its own low-stock variant.
    const flaggedB = await loadLowStock({
      orgId: orgB.org.id,
      accessibleLocationIds: orgB.locations.map((l) => l.id),
    })
    expect(flaggedB.some((e) => e.variantId === pB.variantId)).toBe(true)
  })

  it("STAFF scope: low-stock rows at inaccessible locations are excluded", async () => {
    const staffOrg = await createOrganizationFixture({ locationCount: 2, role: "STAFF" })
    const pHidden = await createProductFixture(staffOrg.org.id, staffOrg.locations[1].id, { stock: 1 })
    const pVisible = await createProductFixture(staffOrg.org.id, staffOrg.locations[0].id, { stock: 1 })
    await updateVariant(staffOrg.org.id, staffOrg.user.id, pHidden.variantId, { lowStockThreshold: 5 })
    await updateVariant(staffOrg.org.id, staffOrg.user.id, pVisible.variantId, { lowStockThreshold: 5 })

    // Restricted context: only locations[0] accessible.
    const restricted = await loadLowStock({
      orgId: staffOrg.org.id,
      accessibleLocationIds: [staffOrg.locations[0].id],
    })
    expect(restricted.some((e) => e.variantId === pVisible.variantId)).toBe(true)
    expect(restricted.some((e) => e.variantId === pHidden.variantId)).toBe(false)

    // Broad context (MANAGER/OWNER): both locations.
    const broad = await loadLowStock({
      orgId: staffOrg.org.id,
      accessibleLocationIds: staffOrg.locations.map((l) => l.id),
    })
    expect(broad.some((e) => e.variantId === pHidden.variantId)).toBe(true)
  })

  it("an empty accessible list yields nothing (fail-closed)", async () => {
    const org = await createOrganizationFixture()
    const p = await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })
    await updateVariant(org.org.id, org.user.id, p.variantId, { lowStockThreshold: 5 })

    const flagged = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: [] })
    expect(flagged).toHaveLength(0)
  })

  it("entries are ordered deterministically (product, variant, location name)", async () => {
    const org = await createOrganizationFixture({ locationCount: 2 })
    const p1 = await createProductFixture(org.org.id, org.locations[0].id, { stock: 1 })
    const p2 = await createProductFixture(org.org.id, org.locations[1].id, { stock: 1 })
    await updateVariant(org.org.id, org.user.id, p1.variantId, { lowStockThreshold: 5 })
    await updateVariant(org.org.id, org.user.id, p2.variantId, { lowStockThreshold: 5 })
    const accessible = org.locations.map((l) => l.id)

    const flagged = await loadLowStock({ orgId: org.org.id, accessibleLocationIds: accessible })
    expect(flagged.length).toBeGreaterThanOrEqual(2)
    const keys = flagged.map((e) => `${e.productName}|${e.variantName}|${e.locationName}`)
    expect([...keys].sort()).toEqual(keys)
  })
})
