// E-16 — Customer uniqueness at (organization, phone) scope, race-safe creation.
import { describe, expect, it } from "vitest"
import { prisma } from "@via-saas/database"
import { upsertCustomer, DomainError } from "@via-saas/core"
import { createOrganizationFixture } from "./helpers"

describe("customer uniqueness and concurrency (E-16)", () => {
  it("creates a customer with validated name and phone", async () => {
    const org = await createOrganizationFixture()

    const customer = await upsertCustomer(org.org.id, {
      name: "Ada Obi",
      phone: "08012345678",
      email: "ada@via.test",
    })

    expect(customer.name).toBe("Ada Obi")
    expect(customer.phone).toBe("08012345678")
    expect(customer.organizationId).toBe(org.org.id)
  })

  it("rejects missing name or phone", async () => {
    const org = await createOrganizationFixture()

    await expect(
      upsertCustomer(org.org.id, { name: "  ", phone: "08012345678" })
    ).rejects.toBeInstanceOf(DomainError)

    await expect(
      upsertCustomer(org.org.id, { name: "Ada", phone: "" })
    ).rejects.toBeInstanceOf(DomainError)
  })

  it("reuses the existing customer on repeat calls (no duplicates)", async () => {
    const org = await createOrganizationFixture()

    const first = await upsertCustomer(org.org.id, { name: "Ada Obi", phone: "08012345678" })
    const second = await upsertCustomer(org.org.id, { name: "Ada Obi", phone: "08012345678" })

    expect(second.id).toBe(first.id)
    const count = await prisma.customer.count({ where: { organizationId: org.org.id } })
    expect(count).toBe(1)
  })

  it("is race-safe: concurrent creates with the same phone produce one row", async () => {
    const org = await createOrganizationFixture()

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        upsertCustomer(org.org.id, { name: "Race Test", phone: "07099999999" })
      )
    )

    // All callers end up with the SAME customer record
    expect(new Set(results.map((c) => c.id)).size).toBe(1)

    const count = await prisma.customer.count({
      where: { organizationId: org.org.id, phone: "07099999999" },
    })
    expect(count).toBe(1)
  })

  it("allows the same phone in different organizations (per-org scope)", async () => {
    const orgA = await createOrganizationFixture()
    const orgB = await createOrganizationFixture()

    const a = await upsertCustomer(orgA.org.id, { name: "Shared Phone", phone: "08011111111" })
    const b = await upsertCustomer(orgB.org.id, { name: "Shared Phone", phone: "08011111111" })

    expect(a.organizationId).toBe(orgA.org.id)
    expect(b.organizationId).toBe(orgB.org.id)
    expect(a.id).not.toBe(b.id)
  })
})
