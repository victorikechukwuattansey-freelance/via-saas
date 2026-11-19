# VIA SaaS - P1-D Implementation Plan: Inventory Control (History, Thresholds, Stock Counts)

*Planning deliverable authored 2026-11-17, immediately after P1-C formal closure.*

---

## 1. Purpose and status

**Status: PD-1, PD-2, PD-3 AND PD-4 IMPLEMENTED AND VERIFIED; P1-D is CLOSED (declared 2026-11-19).** This document is the canonical plan for P1-D. PD-1 (P1-19), PD-2 (P1-20), PD-3 (P1-21) and PD-4 (P1-22, StockCounts) are implemented; migrations **D1, D2 and D3** exist and have replayed on a fresh disposable database; every workspace type-checks. PD-4 was implemented under a separate, explicit owner authorization (2026-11-18) and its evidence is recorded in **§16.8**. The three gates that were open when §16 was first populated are now satisfied, each with its evidence recorded in **§16.4**: **PD-AC27** — CI on the pushed commit (`via-saas CI` run **#7**, run ID `44414365910`, commit `5cd885a`, conclusion **success**, 2026-11-18); **DoD 5** — the owner's dev-database smoke test and the stock-count list/detail browser walkthrough, **OWNER-CONFIRMED 2026-11-19**; **DoD 6** — commit `5cd885a` pushed to `via-saas/main`, with the `via-saas/` tree clean at that committed state. **Historical note, preserved:** as recorded on 2026-11-18, PD-AC27, DoD 5 and DoD 6 were open and no commit, push, deployment, or production-database operation had occurred for any P1-D work. The historical **full-suite totals** quoted in this document (278 and 328) do not reconcile with the committed tree; **§16.9.2** records the observed static declaration count and the unresolved discrepancy rather than asserting either total. The per-file test counts cited for individual suites are unaffected, and a static declaration count is **not** an execution result.

Owner decisions recorded in this plan (§8) were ruled by the owner on 2026-11-17:

1. **PD-D1** - P1-D scope naming confirmed: P1-D = the **P1.2 Inventory control** workstream (P1-19..P1-22). The P1-B plan's assumption #6 ("P1-C/P1-D map to inventory and procurement respectively") is **outdated** - P1-C shipped as staff/org (P1.7) per the canonical §F.2 phase table; procurement is **P1-E**.
2. **PD-D2 (D-5 ruling)** - Stock adjustment permissions keep the shipped P1-A binding decision (OWNER/MANAGER always; STAFF only when the membership carries a non-empty `allowedLocationIds`). Stock-count create/enter/approve/cancel is restricted to **OWNER and MANAGER**; **STAFF can neither view nor manage StockCounts** (exact rule per R-6 correction, 2026-11-17; consistent with the §7 matrix).
3. **PD-D3** - Ledger-reconciliation baseline: contract-created inventory writes an **initial `ADDED` movement at creation** (when the initial quantity is non-zero); the reconciliation invariant test is scoped to contract-created rows. Legacy rows created before P1-D are out of the invariant's scope.
4. **Deliverable form** - this full canonical plan document (P1-B/P1-C style).

Planning baseline: commit `9f3079fa08d713254cf86b5873cbe5519e9b1dba` (local `main`; parent `26e73b1e51eabf9a9c28d545befde74a46bc56cd` = the verified-and-closed P1-C implementation commit; the `9f3079f` commit itself is the P1-C post-push verification record and was not pushed at plan time).

**Correction history:** an independent read-only review of this plan (2026-11-17, verdict: READY AFTER SPECIFIED PLAN CORRECTIONS) produced findings R-1..R-11; the owner accepted all of them and approved the R-5 recommendation (dedicated `STOCK_COUNT_CANCEL` audit event). All corrections were applied in a documentation-only pass on 2026-11-17; no application code, schema, migration, or test was touched. §16 was reserved for the future implementation-status section; it was populated on 2026-11-18 (DoD item 7). The correction record itself is reflected inline in the sections it amends and in §8.

---

## 2. Scope and exclusions

### 2.1 In scope (canonical backlog items P1-19..P1-22)

| Item | Content | Depends on |
|---|---|---|
| **P1-19** | E.1 inventory mutation contract: shared `mutateInventory` helper in new `packages/core/src/inventory.ts`; refactor all existing inventory-mutation call sites onto it; ledger-reconciliation invariant test | P1-01 (done) |
| **P1-20** | Inventory history UI - per variant/location movement ledger with typed reference display and location filtering | P1-19 |
| **P1-21** | `ProductVariant.lowStockThreshold Int?` + read-time low-stock evaluation + dashboard banner (replacing the "Low Stock Alerts: Coming Soon" placeholder) | P1-19 |
| **P1-22** | `StockCount` + `StockCountLine` models; count lifecycle open → enter → approve → exactly one corrective movement per non-zero-delta line setting quantity to the counted value | P1-19, P1-20 |

### 2.2 Explicit exclusions

- **P1-E procurement** (suppliers, purchase orders, goods receipts) - separate phase.
- **P1-F transfers** (dispatch/in-transit/receive/cancel) - separate phase; `TRANSFER` movement type remains reserved and unwritten in P1-D.
- **Costing / COGS engine** (D-4 default stands: last-captured `costPrice` only; no valuation engine in P1).
- **Background jobs/cron** - threshold evaluation is read-time only (blueprint F.1); no scheduler.
- Reorder suggestions, count sheets as PDFs, barcode-driven counting, multi-store hierarchies, rate limiting (X-1), customers (P1-6).
- Any change to pricing, payment, cancellation, or RETURN semantics (P1-B money path behavior must be byte-identical).

### 2.3 Folded cross-cutting work (no separate milestone)

- **X-2 subset:** audit actions `ADJUST_INVENTORY`, `STOCK_COUNT_START`, `STOCK_COUNT_APPROVE`, `STOCK_COUNT_CANCEL` (§6.6). The remaining X-2 actions (`RECEIVE_GOODS`, `TRANSFER_STOCK`) belong to P1-E/P1-F.
- **X-3 subset:** server-side validation + uniform safe-error envelopes for all new dashboard actions (established pattern; folded into each new action).

---

## 3. Verified repository baseline

- Branch `main`; parent chain `859d407` → `26e73b1` (P1-C, verified + closed, CI run 44026333423 success) → `9f3079f` (P1-C verification record, local-only).
- Canonical CI ("via-saas CI") is green for `26e73b1`; exact test/file counts are **not exposed** by the unauthenticated GitHub API and are therefore not asserted anywhere in this plan. Completion for P1-D is defined by **criteria coverage** (PD-AC set), not by an arbitrary test count (P1-B §17.2 precedent).
- The full existing suite passed unmodified in the green CI run for the P1-C commit; P1-D must keep that property: **all pre-existing tests pass unmodified** after every phase.

---

## 4. Existing architecture and source-of-truth findings (observed at `26e73b1`)

1. **`Inventory.quantity` is the authoritative balance** per `(locationId, variantId)` (`@@unique([locationId, variantId])`). `StockMovement` is an append-only ledger; nothing reads movements as stock truth.
2. **The E.1 mutation pattern is hand-repeated in four call sites** - the refactor target:
   - `orders.ts:261` - checkout SALE deduction (per line, inside the checkout transaction);
   - `orders.ts:483` - ATTENTION-resolve FULFILL deduction;
   - `orders.ts:597` - RETURN restoration (exclusive RETURN-movement semantics, P1-B);
   - `products.ts:689` - `adjustInventory` (manual adjustment).
   Each performs: guarded `updateMany` (negative guard `quantity >= |delta|` for decrements) → `count === 0` → `INSUFFICIENT_STOCK` → exactly one `stockMovement.create`.
3. **`adjustInventory`** (`products.ts:655-723`): in-transaction tenant check (variant + location via org chain) **and** active-location check (`archivedAt: null` - C-D20); movement `referenceId` = free-text reason; audit event = generic `UPDATE_PRODUCT` with metadata `{ action: "INVENTORY_ADJUSTMENT", adjustment, reason }`.
4. **Inventory creation writes NO movement**: `products.ts:134` (product create with `data.stock`) and `products.ts:385` (variant add with `data.initialStock`). This is the ledger-reconciliation gap addressed by PD-D3.
5. **Frozen-suite movement assertions are referenceId-scoped, with two documented exceptions** (verified: `attention-orders.test.ts:32,60,95`, `checkout-pricing.test.ts:102,134`, `order-cancel.test.ts:128-203`, `order-audit.test.ts:213` all filter movements by order/reference id, never globally). **Correction (owner-approved, 2026-11-18, discovered during PD-1 implementation):** the planning-time verification above was inaccurate for two assertions that are NOT referenceId-scoped; PD-D3's initial `ADDED` movement changes their interpretation as follows:
   - `checkout-pricing.test.ts:168` counts movements by `variantId` only. Under PD-D3, a fixture created with non-zero stock carries exactly one creation-side initial `ADDED` movement, so "zero movements after an ATTENTION checkout" can no longer be read as a bare zero count. The assertion was amended (owner-approved contradiction correction) to filter `type: "SALE"`, preserving its original intent — the failed checkout deducts nothing and writes no SALE movement — while the creation-side initial movement remains correctly present.
   - `tenant-authorization.test.ts:166` selects the adjustment movement with an unordered `findFirst` on `{ variantId, type: "ADDED" }`. Under PD-D3 the variant also has a creation-side initial `ADDED` movement (`referenceId: null`), making that selection ambiguous. Because the manual reason is stored as the movement's `referenceId` (§5 item 3 above), the assertion was amended (owner-approved contradiction correction) to select by the exact distinguishing predicate `{ variantId, type: "ADDED", referenceId: "delivery" }` — a deterministic selection with no ordering heuristic, excluding the initial movement by construction.
   Both amendments preserve each test's original intent; no application behavior changed. All other frozen movement assertions remain referenceId-scoped (or relative before/after counts) and are unaffected by PD-D3.
6. **`StockMovement.referenceId` is an untyped `String?`** ("e.g., Order ID if type is SALE" per schema comment) - currently order id OR manual reason string. `StockMovementType` = `SALE | TRANSFER | ADDED | REMOVED | RETURN`; `TRANSFER` reserved, never written.
7. **Audit coverage:** `AuditAction` enum contains no inventory-dedicated actions; adjustments audit as `UPDATE_PRODUCT` (finding 3). P1-B/P1-C added `CREATE_ORDER`, `CANCEL_ORDER`, `PAYMENT_RECORDED`, `UPDATE_STAFF`, `REMOVE_STAFF`, `RESCIND_INVITE`, `CREATE_LOCATION`, `UPDATE_LOCATION`, `ARCHIVE_LOCATION`, `SWITCH_ORG`.
8. **Permissions:** `canAdjustStock` (`lib/auth-helpers.ts`) implements the P1-A binding decision - OWNER/MANAGER always adjust; STAFF only with a non-empty `allowedLocationIds` list (explicit per-location authorization).
9. **Missing entirely:** no `packages/core/src/inventory.ts`; no `lowStockThreshold` on `ProductVariant`; no `StockCount`/`StockCountLine`; no history UI; no location filter on inventory views (pages show aggregate/first-variant stock); dashboard banner renders the literal placeholder "Low Stock Alerts: Coming Soon".
10. **P1-C mechanisms available for reuse:** `getSessionContext` (org + role + `accessibleLocationIds`, resolved per request), OWNER-only page gate pattern (`settings/page.tsx` redirect), org switcher, `packages/core/src/locations.ts` (active-location filtering).

---

## 5. Invariants P1-D must preserve (completed contracts)

1. **M1 tenant authorization** - every fetch `where: { organizationId: context.orgId }` or verified via parent chain; every mutation re-verifies inside the transaction; negative tests per resource.
2. **P1-A catalogue** - product/variant behavior, C-D20 (archived locations reject ADDED/REMOVED adjustments - now enforced in the shared helper), E-21 explicit cost capture, SKU uniqueness.
3. **P1-B checkout money path (the central regression risk)** - pricing server-authoritative, payment semantics, idempotency fingerprints, cancellation, RETURN stock restored **exactly once** at the original location. The P1-19 refactor touches `orders.ts`; behavior must be byte-identical, proven by the full unmodified suite.
4. **P1-C session/org/location behavior** - `getSessionContext` resolution, org switching, OWNER-only settings, active-location filtering in scopes; untouched by P1-D except reading the same context.
5. **Safe errors** - `DomainError` + `toSafeErrorMessage`; cross-org misses indistinguishable from nonexistent.
6. **Additive migrations only;** frozen M1 files byte-identical; no history rewrites.

---

## 6. Design

### 6.1 The E.1 contract helper (new `packages/core/src/inventory.ts`)

```
mutateInventory(tx, {
  orgId,            // caller's org - verified, never trusted from client
  locationId, variantId,
  delta,            // signed; negative = removal
  type,             // ADDED | REMOVED | SALE | RETURN   (TRANSFER arrives in P1-F)
  actorId,          // User id, or null for system-origin (storefront checkout, E-3)
  referenceId,      // order id | count id | manual reason (display-typed, §6.5)
}): Promise<void>

  1. TENANT + STATE CHECK (in-tx, fail-closed):
     variant.product.organizationId === orgId
     location.store.organizationId === orgId
     location.archivedAt === null          // C-D20 for ADDED/REMOVED/SALE; RETURN
                                           // may target a since-archived location
                                           // (restoration invariant, §5.3) - the
                                           // helper skips the active-check for RETURN
  2. GUARDED UPDATE:
     tx.inventory.updateMany WHERE location+variant
       AND (delta < 0 → quantity >= |delta|)
       data: { quantity: { increment: delta } }
     (row missing → treated as count 0 → error in step 3; creation-side rows are
      always made through the creation sites, which P1-D extends, §6.7)
  3. count === 0 → DomainError with the CALLER-SUPPLIED error mapping (§6.1.1)
     - throws inside the caller's transaction → full rollback
  4. EXACTLY ONE StockMovement(type, delta, actorId?, referenceId)
  5. Audit responsibility remains with the caller (existing events unchanged
     except the PD-D5 migration, §6.6)
```

Rules: **no flow may write `Inventory` directly** except the creation sites (§6.7) and the helper; all callers run inside a `prisma.$transaction`; the helper never opens its own transaction.

#### 6.1.1 Per-caller error mapping (R-3, mandatory)

The four call sites currently emit **four distinct code/message pairs**; the shipped behavior is frozen and must be preserved byte-identically (PD-AC2, PD-AC36). The helper therefore accepts an explicit caller-supplied error-mapping parameter (or an equivalent design that provably preserves each existing code/message pair); it does **not** hard-code a single error shape. The exact pairs to preserve, verified against source at `26e73b1`:

| Caller | Failure condition | Code | Message (exact) |
|---|---|---|---|
| Checkout SALE (`orders.ts:271-274`) | guarded update count 0 | `INSUFFICIENT_STOCK` | `Not enough stock for one or more items in your cart.` |
| ATTENTION FULFILL (`orders.ts:493-496`) | guarded update count 0 | `INSUFFICIENT_STOCK` | `Still not enough stock to fulfill this order.` |
| RETURN restoration (`orders.ts:601-603`) | inventory row missing (restoration target absent) | `VALIDATION` | `Inventory record missing for restoration.` |
| `adjustInventory` insufficient (`products.ts:699`) | guarded update count 0 | `INSUFFICIENT_STOCK` | `Insufficient stock to remove this quantity.` |
| `adjustInventory` unauthorized (`products.ts:685`) | authorization rejection | `FORBIDDEN` | `You are not authorized to adjust this inventory.` |

Notes:

- RETURN's missing-row error (`VALIDATION`) is **outside** the generic insufficient-stock shape; the mapping parameter carries code AND message per caller so no site's contract is distorted.
- For RETURN, a "row missing" condition (update count 0 because no Inventory row exists at the restoration target) maps to the `VALIDATION` pair; for the decrement sites the same condition maps to their `INSUFFICIENT_STOCK` pairs. The caller mapping distinguishes these, not the helper's internals.
- `adjustInventory`'s `FORBIDDEN` authorization rejection keeps its current site-local position and message; the helper's in-tx tenant/active checks are authoritative and idempotent, and the site keeps its existing pre-checks (§6.2).
- Caller pre-checks are unchanged. All four mappings are verified by dedicated tests (PD-AC36); the two suite-pinned codes (`attention-orders.test.ts:88`, `tenant-authorization.test.ts:154`) and the pinned adjust message regex (`location-management.test.ts:463`) are protected by the frozen-suite gate.

### 6.2 Refactor map (P1-19)

| Call site | Becomes | Behavior constraint |
|---|---|---|
| `orders.ts` checkout deduction | helper (`SALE`, actorId null, referenceId order id) | byte-identical: same error code/message per §6.1.1, all-lines-or-nothing preserved, **order-first sequence per the owner ratification of 2026-11-18 (note below)** |
| `orders.ts` ATTENTION FULFILL | helper (`SALE`) | identical |
| `orders.ts` RETURN restore | helper (`RETURN`, delta > 0) | P1-B exclusivity semantics preserved (restore matched through RETURN movements); missing-row → `VALIDATION` pair per §6.1.1 |
| `products.ts` adjustInventory | helper (`ADDED`/`REMOVED`, referenceId = reason) | tenant/active checks move to the authoritative helper location; error precedence preserved (incl. the `FORBIDDEN` pair, §6.1.1) |

Callers keep their existing pre-checks unchanged where present (no removal of guard layers; the helper's in-tx check is authoritative and idempotent).

**Checkout sequence - order-first (F1, owner-ratified 2026-11-18).** The pre-P1-D checkout deducted inventory *before* creating the order. That order is necessarily reversed, because the `SALE` movement is typed with `referenceId = order.id` (§6.1.1 / §6.6), so the `Order` row must exist before its movements can reference it. The shipped sequence, wholly inside the caller's single `prisma.$transaction`, is:

1. in-tx C-D12 location re-check (unchanged);
2. server-authoritative price resolution + idempotency fingerprint/replay handling (unchanged);
3. `order.create` - which allocates `orderNumber` through the transaction-scoped `allocateOrderNumber(tx, orgId)`;
4. per priced line: `orderItem.create`, then `mutateInventory(…)` performing the guarded deduction and writing exactly one `SALE` movement;
5. exactly one `CREATE_ORDER` audit event, then commit.

**Atomicity is unchanged and is not weakened by this ordering.** Every step above is in the same transaction, so a helper throw (insufficient stock, archived location) rolls back the order row, its items, its movements, the audit event **and** the `OrderCounter` allocation together - a failed checkout consumes no order number, exactly as before, and checkout remains all-lines-or-nothing. The ATTENTION fallback remains a separate transaction in the `catch`, and the idempotency-race settlement path is untouched. The only difference is intra-transaction write order, and no database object depends on it: the schema has **no triggers, no rules, and no deferrable or exclusion constraints** (the only CHECK constraints are `inventory_quantity_non_negative`, `auditlog_actorid_null_only_public_checkout`, `membership_role_canonical`). No code change was required or made for this finding - the note records the implementation that shipped.

**Accepted performance note (R-10, informational):** the helper may add approximately **two point-reads per cart line** to the checkout path (in-tx tenant verification of variant+product and location). Semantics are unchanged; this is an accepted cost at current scale and is **not** a reason to weaken correctness or the byte-identical requirement. No benchmark dependency or unrelated optimization scope is introduced.

### 6.3 Stock counts (P1-22)

State machine (new `StockCountStatus` enum):

```
OPEN ──approve──→ APPROVED (terminal)
OPEN ──cancel───→ CANCELLED (terminal, no stock effect)
```

- `StockCount`: orgId, locationId, status, sequential count number (org-scoped counter pattern), createdBy, approvedBy?, openedAt, approvedAt?, cancelledAt?.
- `StockCountLine`: countId, variantId, `expectedQty Int` (snapshot of the authoritative quantity **at count opening**), countedQty `Int?` (null until entered; the **actual** counted value), non-null invariants enforced at approval; the approval-time delta is computed from the current authoritative balance (see below). Three distinct quantities: `expectedQty` = opening snapshot (informational), `countedQty` = entered actual, approval-time balance = what the delta is computed against.
- **Line auto-population (R-4, owner-approved):** opening a count **automatically populates exactly one line per variant holding an Inventory row at the selected location** — including zero-quantity Inventory rows (zero-quantity rows still represent physical shelf slots the count must verify, and "holding inventory" therefore includes a zero-balance row). Manual line addition is **out of scope for P1-D**; a variant with no Inventory row at the location gets no line (approval would have nothing to compute against).
- **Duplicate-line protection (R-1, defense-in-depth):** `@@unique([countId, variantId])` on `StockCountLine` plus an index on `countId` (migration D2). With auto-population as the only line source, a duplicate line cannot arise through the application; the database constraint guarantees that even a defect cannot yield two corrective movements for the same count/variant pair. A dedicated acceptance criterion (PD-AC28) proves duplicate line creation is rejected and cannot result in multiple corrective movements.
- **Entry** (OPEN): OWNER/MANAGER sets countedQty per line; variance displayed = `countedQty − current authoritative quantity` (read-time, display-only).
- **Approval** (single transaction): conditional `updateMany` status guard `WHERE id AND status = "OPEN"` (double-approve impossible by precondition); for each line, `delta = countedQty − current quantity` **computed at approval time** from the authoritative balance (entry-time variance and `expectedQty` are informational only); `delta ≠ 0` → `mutateInventory` (`ADDED`/`REMOVED`, `referenceId: countId`) - **exactly one movement per non-zero-delta line** (PD-D4); zero-delta lines produce no movement; count flips to `APPROVED`.
- **Approval failure and retry (review finding):** if any line's approval-time condition cannot be satisfied (e.g., the variant or product was archived, or the Inventory row is missing, between entry and approval), the approval transaction **rolls back atomically** — no movements, no partial quantity changes — and the count **remains OPEN**. After the underlying issue is corrected, the approval can be retried successfully. Covered by PD-AC32.
- **Guards:** location must be ACTIVE to open or approve a count (C-D20 alignment); count rows are org-scoped; no approval of another org's count (safe error).
- **Race note (documented residual):** an adjustment concurrent with approval follows the established pre-transaction authorization residual pattern (P1-C F-05-class): the helper's guarded update makes every individual transition safe and non-negative; the approval delta is computed in-tx, so an adjustment committed between entry and approval is correctly reflected (or rejected) at approval.
- **Abandoned counts and concurrent approvals (R-11, documented):** an abandoned OPEN count has **no expiry in P1-D** and has no inventory effect until approval (harmless by construction). Concurrent approvals of **different counts touching the same variant** serialize safely through the Inventory row's transactional update behavior (row-level update conflicts serialize the two transactions; the net quantity is correct and never negative). A concurrency test is added if implementable within the existing test infrastructure, otherwise it is an explicit implementation-phase verification requirement (PD-AC38).

### 6.4 Low-stock thresholds (P1-21)

- `ProductVariant.lowStockThreshold Int?` - nullable; `NULL` = threshold disabled (legacy semantics preserved, no backfill).
- **Value validation (R-8):** the threshold is a **non-negative integer**; `NULL` disables low-stock flagging; `0` means only zero-or-negative stock is flagged — since inventory quantities cannot be negative (the helper's guarded update forbids it), this effectively flags **out-of-stock** inventory; **negative values are rejected server-side** (safe validation error, X-3 pattern). Tests cover null, zero, positive, and negative values (PD-AC33).
- Evaluation **read-time** (no jobs): a variant is low at a location when `quantity ≤ lowStockThreshold` (non-null threshold).
- Dashboard banner lists org's low-stock variants (aggregated across the actor's accessible locations) replacing the "Coming Soon" placeholder; Products page gains a low-stock badge/filter. Setting the threshold lives in the existing variant editor (small additive form field).
- **Archived exclusion (R-9):** archived products and their variants are **excluded** from the banner and badges; the read-time query remains tenant- and location-scoped (org chain + `accessibleLocationIds`).

### 6.5 Inventory history UI (P1-20)

- New dashboard surface (proposed route `(dashboard)/inventory/`, sidebar addition - sidebar is not frozen): per-location and per-variant movement list with type, signed quantity, actor name, timestamp.
- **Typed reference display (no schema change):** by movement `type` - `SALE`/`RETURN` → "Order `<orderNumber>`" linking to the order detail (resolve `referenceId` as order id); `ADDED`/`REMOVED` with `referenceId: countId` → count number link; `ADDED`/`REMOVED` with free-text reason → the reason string (legacy rows); initial-creation movements → "Initial stock". Unknown/legacy free text renders as plain text.
- **Reference resolution without N+1 (R-7):** `referenceId` may identify a `StockCount` or contain legacy free text; disambiguation uses the movement `type` plus a **single batched resolution query per page** (collect the page's candidate ids of each resolvable type and fetch them in one `findMany({ where: { id: { in: [...] } } })` per referenced model) — never a per-row lookup. A `StockCount` probe (org-scoped) distinguishes count ids from legacy text where the type alone cannot.
- **Safe fallback (R-7):** a reference that cannot be resolved (deleted/foreign/legacy text) renders a **safe fallback** (plain text or a neutral label) rather than failing the history page.
- **Deterministic sorting and bounded pagination (R-7):** the movement list sorts by `createdAt DESC` with `id` as a deterministic tiebreak, and uses **bounded cursor-based pagination** (fixed maximum page size; no unbounded list).
- **Authorization for both queries (R-7):** the movement query and the reference-resolution query are both tenant-scoped (org chain) and location-constrained to the actor's `accessibleLocationIds`; resolution probes never leak cross-org rows.
- Visibility: location filter restricted to the actor's `accessibleLocationIds` (STAFF sees only explicitly accessible locations; OWNER/MANAGER broad per existing context semantics).

### 6.6 Audit actions (PD-D5, as amended by R-5)

`AuditAction` enum gains (additive widening): `ADJUST_INVENTORY`, `STOCK_COUNT_START`, `STOCK_COUNT_APPROVE`, `STOCK_COUNT_CANCEL` (the fourth value is the owner-approved R-5 recommendation; it rides migration D3, not a fourth migration).

- `adjustInventory` migrates from the generic `UPDATE_PRODUCT`-with-metadata event to a dedicated `ADJUST_INVENTORY` event (same metadata payload). This is an observable audit-trail change - recorded as an approved behavior change (PD-D5), not a silent one.
- Count open → `STOCK_COUNT_START`; count approval → `STOCK_COUNT_APPROVE` (metadata: per-line deltas).
- **Count cancellation → `STOCK_COUNT_CANCEL` (R-5, owner-approved):** cancelling an OPEN count writes **exactly one** `STOCK_COUNT_CANCEL` event, in the same transaction as the status transition, carrying the acting user as the audit actor and the event timestamp as the audit timestamp; metadata records the count id (and count number). Cancellation changes **no inventory quantity** and creates **no StockMovement rows**. Only an authorized OWNER or MANAGER may cancel, and only an OPEN count may be cancelled (APPROVED/CANCELLED are terminal). Cancellation is **retry-safe/idempotent by the same status-precondition pattern as approval**: the conditional status guard means a repeated cancellation attempt hits a non-OPEN row and is rejected (safe error) — it can never create a duplicate event or mutate an already terminal count. Covered by PD-AC30/PD-AC31.

### 6.7 Creation sites and the reconciliation invariant (PD-D3)

- `products.ts:134` and `products.ts:385` are extended: when the initial quantity is non-zero, the creation transaction writes exactly one initial `ADDED` movement (`actorId` = creating user, `referenceId` = null, display "Initial stock"). Zero-quantity rows write nothing (sum = 0 trivially reconciles).
- **Reconciliation invariant test (R-2, deterministic scoping):** for every inventory row created **through the contract/creation sites in test fixtures**, `quantity === Σ(movements.delta)`. The contract-created population is identified deterministically: **extendable test helpers (`tests/helpers.ts`) must create contract-covered inventory through the relevant creation pathways** (the `products.ts` creation sites, which P1-D extends), instead of the current direct `prisma.inventory.create` (helpers.ts:103-107). `tests/helpers.ts` is **extendable and NOT a frozen test file**; frozen test files are untouched. Any row not created through the creation pathways is by definition outside the invariant's population — the plan does **not** claim that all existing inventory rows satisfy the invariant.
- **Exclusions (explicit and testable):** (a) legacy rows created before P1-D in the dev database are out of scope (PD-D3, owner-approved); (b) no backfill is introduced — the migration and tests must not fabricate historical movements; (c) the reconciliation test's population is exactly the fixture rows whose creation is routed through the creation pathways, making the population and exclusions objectively verifiable in the test itself.

---

## 7. Security and authorization model

1. **Two-layer enforcement (established pattern):** server actions check session context (`getSessionContext`) and role/accessibility before calling core; core functions re-verify tenant scope inside the transaction. No new action trusts client-supplied org/location/variant relationships.
2. **Permission matrix (PD-D2, approved):**

| Action | OWNER | MANAGER | STAFF |
|---|---|---|---|
| Adjust stock (existing, unchanged) | ✓ | ✓ | only when membership `allowedLocationIds` non-empty (per-location) |
| View stock counts | ✓ | ✓ | ✗ |
| Open / enter / approve / cancel stock counts | ✓ | ✓ | ✗ |
| View inventory history | ✓ (all org locations) | ✓ (all org locations) | ✓ (only `accessibleLocationIds`) |
| Set low-stock threshold | ✓ | ✓ | ✗ |

3. **Tenant isolation:** all new models carry `organizationId` (direct FK or verified via parent chain); all new core functions verify in-tx; cross-org misses return safe "not found/forbidden" errors indistinguishable between cases.
4. **No client-supplied monetary or quantity authority:** counted quantities are inputs (they are physical observations - the one deliberate exception where client quantity becomes authoritative at approval, by design of a stock count, and it is OWNER/MANAGER-gated and audited).
5. **Additive schema only; frozen M1 files untouched.**

---

## 8. Owner decision register

| # | Decision | Ruling (2026-11-17) | Status |
|---|---|---|---|
| PD-D1 | P1-D scope naming | P1-D = P1.2 Inventory control (canonical §F.2; P1-B assumption #6 outdated; procurement = P1-E) | **APPROVED** |
| PD-D2 | D-5 permissions | Adjustments: status quo (P1-A binding decision). Counts (create/enter/approve/cancel) + thresholds: OWNER+MANAGER only | **APPROVED** |
| PD-D3 | Reconciliation baseline | Initial `ADDED` movement at creation (non-zero initial quantity); invariant scoped to contract-created rows | **APPROVED** |
| PD-D4 | Corrective movement shape | Via E.1 helper; exactly one movement per non-zero-delta line; `referenceId: countId`; delta computed at approval time | **APPROVED (in-plan)** |
| PD-D5 | Audit actions | Add `ADJUST_INVENTORY`, `STOCK_COUNT_START`, `STOCK_COUNT_APPROVE`; adjust migrates off `UPDATE_PRODUCT`-with-metadata. **Amended by R-5 (owner-approved, 2026-11-17 correction pass): add `STOCK_COUNT_CANCEL` as a fourth value (rides D3).** | **APPROVED (in-plan)** |
| PD-D6 | Threshold semantics | Nullable field, `NULL` = disabled, read-time evaluation, low when `quantity ≤ threshold` | **APPROVED (in-plan)** |
| PD-D7 | Kickoff gate | Final AC set (§11) + migration set (§9) confirmed by owner at implementation kickoff | **APPROVED (owner, 2026-11-18)** - kickoff gate satisfied for PD-1/PD-2/PD-3: the AC set (§11) and migration **D1** are confirmed and implemented. D2/D3 were scoped to PD-4; the owner authorized PD-4 on 2026-11-18 (separate explicit authorization), and D2/D3 are now implemented and replayed (§16.8). The approval status itself is unchanged. |

Additional record: on 2026-11-17 the owner accepted all R-1..R-11 review corrections and explicitly approved the R-5 recommendation (dedicated `STOCK_COUNT_CANCEL` event). These were applied in a documentation-only correction pass; they amend PD-D4..PD-D6 in-plan approvals and do **not** alter PD-D1..PD-D3 in substance.

---

## 9. Migration and legacy-data strategy

All additive; none written or applied during planning:

| Migration | Content | Risk |
|---|---|---|
| D1 | `ProductVariant.lowStockThreshold Int?` (nullable) | none - nullable additive column |
| D2 | `StockCount`, `StockCountLine` models + `StockCountStatus` enum + `@@index` on orgId/locationId/status FK columns + `@@unique([countId, variantId])` on `StockCountLine` + `@@index` on `StockCountLine.countId` (R-1) | none - new tables; the unique constraint is a defense-in-depth guarantee that one count contains at most one line per variant (auto-population already makes duplicates impossible through the app; PD-AC28) |
| D3 | `AuditAction` enum widening (+4 values: `ADJUST_INVENTORY`, `STOCK_COUNT_START`, `STOCK_COUNT_APPROVE`, `STOCK_COUNT_CANCEL` - the fourth per R-5) | low - additive enum values (same pattern as P1-B Migration A / P1-C) |

- **No backfill.** `lowStockThreshold` starts NULL (= disabled) with exact legacy semantics; no data migration of `StockMovement` or `Inventory`.
- Fresh-DB migration replay + `migrate status` clean in CI (existing ritual); dev-DB `prisma migrate dev` discipline. The new `@@unique([countId, variantId])` constraint is the required duplicate-line protection (R-1) - it exists as database-level defense-in-depth and is verified by PD-AC28.
- Downgrade path: dropping the added column/tables/enum values restores pre-P1-D state; documented in §13.

---

## 10. Implementation sequence and gates

```
PD-1 (P1-19): inventory.ts helper + refactor 4 call sites + initial movements
              at creation sites + reconciliation invariant test
   GATE: full suite green UNMODIFIED; type-check all workspaces; behavior
         byte-identical on the money path (diff review of orders.ts changes)
PD-2 (P1-20): history UI + typed reference display + location filtering
PD-3 (P1-21): threshold field + variant editor input + banner + badges (needs D1)
PD-4 (P1-22): StockCount models + count UI + approval flow + cancellation
               (STOCK_COUNT_CANCEL, §6.6) + audit events
   GATE: full suite green; fresh-DB replay; owner smoke test on dev DB
```

P1-21 and P1-22 are independent after PD-1/PD-2 and could swap; counts last because they consume the helper, the history surface, and the audit additions.

Files expected to change: `packages/core/src/inventory.ts` (new), `products.ts`, `orders.ts` (refactor only), `audit.ts` (action helpers), `packages/database/prisma/schema.prisma` + migrations, dashboard `products/` and new `inventory/` pages, `(dashboard)/page.tsx` (banner), sidebar nav, new tests. **Frozen M1 files: untouched.**

---

## 11. Acceptance criteria (confirmed by the owner at kickoff - PD-D7, 2026-11-18)

### Contract (PD-AC1..PD-AC6)

| ID | Criterion |
|---|---|
| PD-AC1 | `mutateInventory` is the only non-creation writer of `Inventory`; all four existing call sites route through it; no call site duplicates the guarded-update/movement logic. |
| PD-AC2 | Checkout SALE, ATTENTION FULFILL, and RETURN behavior are byte-identical to pre-P1-D (error codes, messages per the §6.1.1 per-caller mapping, in-tx ordering, movement payloads); proven by the full unmodified suite plus dedicated mapping tests (PD-AC36). |
| PD-AC3 | Helper enforces tenant scope, active-location state (C-D20), and the negative-stock guard in-transaction, fail-closed. |
| PD-AC4 | Every contract mutation writes exactly one movement with correct type/actor/reference; system-origin (storefront) movements carry `actorId: null`. |
| PD-AC5 | RETURN restoration may target a location archived after the sale (restoration invariant preserved); ADDED/REMOVED/SALE cannot act on archived locations. |
| PD-AC6 | Ledger reconciliation test: contract-created rows satisfy `quantity === Σ(movements)` on every push; the contract-created population is identified deterministically per §6.7 (helpers route fixture inventory through the creation pathways; legacy/pre-P1-D rows explicitly excluded; no backfill). |

### History (PD-AC7..PD-AC11)

| ID | Criterion |
|---|---|
| PD-AC7 | History view is org-scoped; cross-org variants/locations/movements invisible (negative test). |
| PD-AC8 | STAFF sees history only for `accessibleLocationIds`; MANAGER/OWNER broad. |
| PD-AC9 | Typed reference display resolves SALE/RETURN to order links, count movements to count links, legacy free text as reason text; resolution is batched (no per-row lookups, no N+1, §6.5), authorized, and unresolvable references render a safe fallback instead of failing the page. |
| PD-AC10 | Location filter constrained to accessible locations server-side (not just UI-hidden). |
| PD-AC11 | Initial-creation movements display as "Initial stock" and carry the creating actor. |

### Thresholds (PD-AC12..PD-AC15)

| ID | Criterion |
|---|---|
| PD-AC12 | Threshold set/cleared via variant editor by OWNER/MANAGER; STAFF rejected (server-side). Value validation per R-8: null accepted (= disabled), 0 and positive integers accepted with defined semantics, negative values rejected server-side (PD-AC33 covers the boundary tests). |
| PD-AC13 | Low = `quantity ≤ threshold` at read time; NULL threshold never flags; banner + badge reflect current quantities at request time. |
| PD-AC14 | Banner aggregates only variants at the actor's accessible locations. |
| PD-AC15 | Threshold change audits (reuse `UPDATE_PRODUCT` family - existing variant-edit event covers it; no new enum value required). |

### Stock counts (PD-AC16..PD-AC24)

| ID | Criterion |
|---|---|
| PD-AC16 | Only OWNER/MANAGER can open, enter, approve, or cancel counts; STAFF attempts → unauthorized safe error (server-side negative test). STAFF can neither view nor manage counts (R-6 exact rule; server-side negative test for view attempts too). |
| PD-AC17 | Count open/approve on an archived location rejected (C-D20 alignment). |
| PD-AC18 | Approval sets each line's quantity exactly to `countedQty` via one corrective movement per non-zero-delta line; zero-delta lines write nothing; `@@unique([countId, variantId])` guarantees at most one line per variant per count (defense-in-depth, PD-AC28). |
| PD-AC19 | Double-approval impossible by status precondition (conditional updateMany guard; negative test). |
| PD-AC20 | Approval after entry-time stock change uses approval-time authoritative quantities (variance display is informational only). |
| PD-AC21 | Approving another org's count → safe error, indistinguishable from nonexistent. |
| PD-AC22 | Concurrent adjustment + approval race: no negative quantities; every individual mutation safe; documented residual class (§6.3). |
| PD-AC23 | `STOCK_COUNT_START` / `STOCK_COUNT_APPROVE` / `STOCK_COUNT_CANCEL` / `ADJUST_INVENTORY` events written exactly once per corresponding state change; adjust migration off `UPDATE_PRODUCT`-with-metadata; cancellation creates exactly one cancel event with actor + timestamp and no inventory/movement changes (PD-AC30). |
| PD-AC24 | Counts appear in history display as the corrective movement's typed reference; reference resolution is batched and page-bounded (no N+1; §6.5). |

### Cross-cutting (PD-AC25..PD-AC27)

| ID | Criterion |
|---|---|
| PD-AC25 | All pre-existing tests (M1 + P1-A + P1-B + P1-C) pass unmodified after every phase. |
| PD-AC26 | Migrations D1-D3 additive; fresh-DB replay clean; `prisma validate` + all-workspace type-check green. |
| PD-AC27 | Safe errors everywhere; no existence leaks; canonical CI green on the pushed implementation commit. |

### Corrections (PD-AC28..PD-AC38 - added by the R-1..R-11 correction pass, 2026-11-17)

| ID | Criterion | Origin |
|---|---|---|
| PD-AC28 | Duplicate `StockCountLine` creation for the same `(countId, variantId)` is rejected by the database `@@unique` constraint; a test proves a duplicate submission cannot result in multiple corrective movements for the same count/variant. | R-1 |
| PD-AC29 | Opening a count auto-populates exactly one line per variant with an Inventory row at the location (including zero-quantity rows), each carrying the opening `expectedQty` snapshot; no manual line-add path exists in P1-D; `expectedQty` (opening), `countedQty` (entered), and the approval-time balance remain three distinct quantities. | R-4 |
| PD-AC30 | Cancelling an OPEN count writes exactly one `STOCK_COUNT_CANCEL` audit event with the acting user and timestamp; cancellation changes no inventory quantity and creates no StockMovement rows. | R-5 |
| PD-AC31 | Cancellation authorization and retry-safety: STAFF cancel attempt → unauthorized safe error; cancelling a non-OPEN count → safe error; a repeated cancellation attempt creates no duplicate event and cannot alter an already terminal count. | R-5 |
| PD-AC32 | Failed-approval retry: when a line cannot be approved (variant/product archived or Inventory row missing at approval time), the approval transaction rolls back atomically (no movements, no quantity changes), the count remains OPEN, and a retry after correction succeeds. | Review finding |
| PD-AC33 | Threshold boundary validation: null (= disabled), 0 (flags out-of-stock only), and positive integers accepted; negative values rejected server-side - each covered by a test. | R-8 |
| PD-AC34 | Archived products and their variants are excluded from low-stock banner and badges; the read-time query remains tenant- and location-scoped. | R-9 |
| PD-AC35 | History list uses deterministic sorting (`createdAt DESC`, `id` tiebreak) and bounded pagination; reference resolution is batched per page, authorized for tenant and accessible locations, N+1-free, with a safe fallback for unresolvable references. | R-7 |
| PD-AC36 | All four per-caller error mappings of §6.1.1 are verified by dedicated tests (checkout, FULFILL, RETURN, adjust insufficient; plus the adjust `FORBIDDEN` pair) - each exact code/message pair preserved. | R-3 |
| PD-AC37 | Reconciliation invariant scoping is testable: fixtures create contract-covered inventory through the creation pathways; rows outside that population are excluded by construction; legacy dev-DB rows are explicitly out of scope with no backfill. | R-2 |
| PD-AC38 | Concurrent approvals of different counts touching the same variant serialize safely (never negative, net effect correct); implemented as a test if the existing infrastructure permits, otherwise recorded as an explicit implementation-phase verification requirement. | R-11 |

---

## 12. Test strategy

- **Core/domain tests (majority):** contract helper positive paths + negative authorization matrix (cross-org, cross-location, archived location, insufficient stock, wrong role); count lifecycle state machine; approval math; concurrency (guarded-update race, double-approve); **duplicate StockCountLine rejection (PD-AC28)**; **auto-population + `expectedQty` snapshot semantics (PD-AC29)**; **cancellation matrix - success, unauthorized, non-OPEN, repeated (PD-AC30/31)**; **failed-approval atomic rollback + retry (PD-AC32)**; **threshold boundaries null/0/positive/negative (PD-AC33)**.
- **Invariant test:** ledger reconciliation (PD-AC6) - dedicated file, runs on every push; its population/exclusion mechanism is itself tested (PD-AC37).
- **Error-mapping tests (PD-AC36):** dedicated tests for all four §6.1.1 per-caller code/message pairs (the frozen suite pins two codes and one message; the remaining pairs are verified by the new tests).
- **History UI tests (PD-AC35):** pagination bounds, deterministic order, batched reference resolution, safe fallback rendering.
- **Concurrency:** two-counts-same-variant approval race (PD-AC38) if implementable in the existing test infrastructure; otherwise explicit implementation-phase verification requirement.
- **Frozen-suite guard:** zero modifications to pre-existing test files; the P1-19 refactor is proven by their untouched green run (same discipline as P1-B/P1-C).
- **Fixture factories:** extend `tests/helpers.ts` with location/variant/threshold/count factories as needed (additive); helpers route contract-covered inventory creation through the creation pathways (§6.7).
- **Migration evidence:** fresh-DB replay in CI (existing pipeline); no new jobs.

---

## 13. Rollback and recovery

- Migrations D1-D3 are individually reversible: drop column / drop tables (incl. the `StockCountLine` unique constraint and indexes) / shrink enum (enum shrink of the four added values requires a paired migration and is only needed if P1-D were abandoned entirely - document, do not pre-create).
- Code rollback: revert the implementation commit(s); the additive schema is harmless to pre-P1-D code (nullable column, unused tables, extra enum values).
- No durable-data risk: no backfills, no rewrites of existing rows; counts write only new rows/movements.

---

## 14. Risks and deferred work

| Risk / item | Severity | Disposition |
|---|---|---|
| Money-path refactor (P1-19 touching `orders.ts`) | MEDIUM (contained) | Byte-identical constraint + full unmodified suite + explicit diff review gate (PD-1 GATE). Failure mode = plan conflict → stop and reconcile with owner (P1-C discipline). |
| Pre-existing dev-DB rows fail naive reconciliation | LOW | Resolved by PD-D3 scoping (invariant covers contract-created rows only). |
| `referenceId` legacy free-text ambiguity in history display | LOW | Typed display degrades safely to plain text; batched resolution per page (§6.5); deeper typing (e.g., polymorphic relation) is P2. |
| Checkout point-read overhead from the helper (~2 reads/cart line) | LOW (accepted) | R-10 accepted performance consideration (§6.2); semantics unchanged; no benchmark dependency. |
| Abandoned OPEN counts / concurrent approvals on the same variant | LOW (accepted) | R-11 documented behavior (§6.3): no expiry, no stock effect until approval; approvals serialize via the Inventory row's transactional update; PD-AC38 covers verification. |
| Enum-widening migration pattern | LOW | Same pattern as P1-B/P1-C (verified in their replays). |
| Procurement/transfers will add new movement types | NONE (deferred) | Helper's `type` parameter accommodates P1-E `ADDED` receipts and P1-F `TRANSFER` without redesign. |
| X-1 rate limiting, P1-6 customers, P1-E, P1-F | deferred | Out of scope, unchanged. |

---

## 15. Definition of done

P1-D is done when **all** of the following hold:

1. All decision-gated work implemented only per the §8 approved rulings (PD-D1..PD-D6; PD-D7 signed at kickoff).
2. **All acceptance criteria PD-AC1..PD-AC38 pass**, each including its relevant failure paths. Completion is defined by criteria coverage - no arbitrary test count.
3. Full suite green: **all pre-existing tests pass unmodified** + the new P1-D suites.
4. `prisma validate`, all-workspace type-checks, fresh-DB migration replay pass.
5. Manual smoke on dev DB: adjust stock → history shows typed movement; set threshold → banner flags a low variant; run a count with a variance → approve → exactly one corrective movement, quantity = counted, ledger reconciles.
6. Working tree clean except intended changes; commit(s) ready for owner-authorized push; remote CI green on the pushed commit.
7. This plan updated with an implementation-status section (§16) recording evidence; no untested criterion marked PASS.
8. No P1-E/P1-F work started; no excluded scope absorbed.

---

## 16. Implementation status (evidence record - populated 2026-11-18)

Added per DoD item 7. **Nothing here changes the plan**: it records what exists, what was actually executed, what cannot be executed in this harness, and what was never authorized. No untested criterion is marked PASS.

### 16.1 Status vocabulary

| Term | Meaning |
|---|---|
| **IMPLEMENTED** | The artifact exists in the working tree. |
| **VERIFIED** | A command or test **actually executed** passed (§16.4). Evidence carried over from earlier reports is labelled as inherited. |
| **SATISFIED** | An acceptance criterion or Definition-of-Done gate is met, supported by the specific evidence recorded for it in §16.4. Used for **gates** (PD-AC27, DoD 5, DoD 6) and deliberately distinct from **VERIFIED** (a command/test executed directly, §16.4) and from **OWNER-CONFIRMED** (the owner's own check, not an automated-test result). |
| **CODE-ONLY** | Correctness established by source inspection; no executable assertion exists for it in this harness. |
| **NOT RUNTIME-TESTED** | Requires a browser, a live dev stack, or a pushed commit. |
| **OWNER-CONFIRMED** | The owner personally performed the check and reported the outcome; **not** an automated-test result. Always dated at the point of confirmation. |
| **NOT AUTHORIZED** | The owner has not authorized the work; no artifact of any kind exists. |

### 16.2 Phase status

| Phase | Backlog | Status | Delivered |
|---|---|---|---|
| **PD-1** | P1-19 inventory mutation contract | **IMPLEMENTED + VERIFIED** | `packages/core/src/inventory.ts` (new, single-writer helper); all four call sites routed through it (`orders.ts` checkout / ATTENTION FULFILL / RETURN, `products.ts` adjust); initial `ADDED` movement at both creation sites; `tests/helpers.ts` fixture routing; `tests/inventory-contract.test.ts` (new). Two owner-approved frozen-test amendments (plan §5 item 5). |
| **PD-2** | P1-20 inventory history UI | **IMPLEMENTED + VERIFIED** (page rendering + sidebar visibility: CODE-ONLY) | `apps/merchant-dashboard/lib/inventory-history.ts` (new loader), `app/(dashboard)/inventory/page.tsx` (new), sidebar entry, `tests/inventory-history.test.ts` (new, 20 tests). |
| **PD-3** | P1-21 low-stock thresholds | **IMPLEMENTED + VERIFIED** (banner/badge rendering and the STAFF role gate: CODE-ONLY) | Migration **D1**; `ProductVariant.lowStockThreshold Int?`; threshold validation in `updateVariant`; `lib/low-stock.ts` (new, read-time evaluation); dashboard banner + count; product badge, `lowStock=1` filter, editor field, action parsing; `tests/low-stock.test.ts` (new, 20 tests). |
| **PD-4** | P1-22 stock counts | **IMPLEMENTED + VERIFIED** (browser rendering of the count pages: CODE-ONLY) | Migrations **D2** (`20261118120000_p1d_stock_counts`) + **D3** (`20261118120001_p1d_audit_actions`); `StockCountStatus` enum, `StockCount` + `StockCountLine` models and back-relations; `packages/core/src/stock-counts.ts` (open / enter / approve / cancel / `lockInventoryRows`); `ADJUST_INVENTORY` audit switch in `adjustInventory`; count-reference resolution in `lib/inventory-history.ts`; `apps/merchant-dashboard/lib/stock-counts.ts` (list + detail loaders, role resolution, keyset pagination); `app/(dashboard)/stock-counts/{page.tsx,actions.ts,OpenCountForm.tsx}` + `[countId]/{page.tsx,CountEntryForm.tsx}`; sidebar entry; `tests/stock-counts.test.ts` (new, **46 tests as recorded on 2026-11-18; the committed file contains 48** - §16.9.1/§16.9.2) and 4 PD-AC24 count-reference tests added to `tests/inventory-history.test.ts`. |

### 16.3 Validation evidence - executed 2026-11-18 (HEAD `9f3079f`, index empty)

| Check | Command | Result |
|---|---|---|
| Focused PD-2 + PD-3 suites | `npx vitest run tests/low-stock.test.ts tests/inventory-history.test.ts` | **2 files / 40 tests passed** |
| Full suite | `npm test` | **23 files / 278 tests passed** (275 at the phase-boundary baseline + 3 added by the F3/F4 closures) - *historical figure as recorded on 2026-11-18; it does not match the committed tree (20 files / 222 declarations at `9f3079f`) - see §16.9.2.* |
| All-workspace type-checks | `npm run type-check` | **exit 0** - 5 workspaces: `api`, `merchant-dashboard`, `@via-saas/core`, `@via-saas/database`, `@via-saas/ui` |
| Schema parse | `npx prisma validate` | "The schema at prisma\schema.prisma is valid" |
| Fresh-DB migration replay | `tests/global-setup.ts` (drops/creates `via_saas_test`, then `prisma migrate deploy`) followed by a read-only `_prisma_migrations` query | all **9** migrations recorded with `finished_at` non-null; `20261118090000_p1d_thresholds` (D1) applied last |

The suite run recreates the **disposable** `via_saas_test` database - that is the harness contract (§12), not a live-data mutation. The development database (`via_saas_db`) was not connected to, migrated, cleaned, or modified, and no production system was contacted.

**Inherited, not re-verified at that time:** CI status on a pushed commit (PD-AC27). *Historical as of 2026-11-18:* no push was authorized, so it could not be verified then. **Current:** verified on 2026-11-18 - `via-saas CI` run #7 (run ID `44414365910`) on commit `5cd885a` concluded **success** (§16.4).

#### 16.3.1 PD-4 validation executed now (2026-11-18, after the PD-4 working tree was complete)

| Check | Command | Result |
|---|---|---|
| Focused PD-4 suite | `npx vitest run tests/stock-counts.test.ts` | **1 file / 46 tests passed** (46 at that time; the committed file contains 48 - §16.9.1) |
| Focused PD-2 regression suite (with the 4 new PD-AC24 tests) | `npx vitest run tests/inventory-history.test.ts` | **1 file / 24 tests passed** (20 inherited + 4 added) |
| Concurrent-approval subsets (PD-AC38 / PD-AC22) | `npx vitest run tests/stock-counts.test.ts -t "PD-AC38"` / `-t "PD-AC22"` | both subsets pass against real PostgreSQL with the explicit overlap latch |
| Full suite | `npx vitest run` | **24 files / 328 tests passed** (278 baseline + 46 PD-4 + 4 history) - *historical figure as recorded on 2026-11-18. §16.9.2 records 24 files / **332** test declarations in the committed tree (`stock-counts.test.ts` contributing 48, not 46); this 328 figure is retained as the historical record and is not asserted as the current count.* |
| All-workspace type-checks | `npm run type-check` | **exit 0** - `api`, `merchant-dashboard`, `@via-saas/core`, `@via-saas/database`, `@via-saas/ui` |
| Schema parse | `npx prisma validate` | "The schema at prisma\schema.prisma is valid" |
| Client generation | `npx prisma generate` | Generated Prisma Client **v5.22.0** |
| Fresh-DB migration replay + status | `tests/global-setup.ts` (drop/create `via_saas_test`, `prisma migrate deploy`) then `npx prisma migrate status` | **11 migrations found - up to date**; D2/D3 recorded with `finished_at` non-null |
| D2/D3 object inspection | read-only `psql` over `pg_indexes`, `pg_constraint`, `enum_range` | `StockCount`/`StockCountLine` indexes + uniques + 6 FKs present; **19** `AuditAction` values (incl. `ADJUST_INVENTORY`, `STOCK_COUNT_START/APPROVE/CANCEL`); `StockCountStatus` = `OPEN, APPROVED, CANCELLED` |
| Drift check | `npx prisma migrate diff --from-url <via_saas_test> --to-schema-datamodel` | zero drift from the StockCount models/migrations; the only difference is the pre-existing `AuditLog_actorId_fkey` `RESTRICT` vs `SET NULL` shape (see §16.8) |

All runs targeted the disposable `via_saas_test` database. `via_saas_db` (development) and any production database were not connected to, migrated, cleaned, or modified.

### 16.4 Acceptance-criteria status

| AC | Status | Note |
|---|---|---|
| PD-AC1, AC3, AC4, AC5, AC6, AC37 | **PASS (verified)** | Single-writer contract, movement invariants, reconciliation invariant + its population scoping. |
| PD-AC2 | **PASS (verified)** | Behavior preserved; the intra-transaction ordering deviation is now documented and owner-ratified (§6.2 F1 note). |
| PD-AC36 | **PASS (verified)** | All error pairs asserted; the checkout pair is asserted at the helper level because the shipped path converts it into an ATTENTION order. |
| PD-AC7, AC8, AC10, AC11, AC35 | **PASS (verified)** | Tenant/location scoping, fail-closed filters, deterministic keyset pagination, batched reference resolution (no N+1). |
| PD-AC9 | **PASS (verified)** | Order links, "Initial stock", legacy reason text and safe fallbacks were already verified; the count-link clause is now implemented and verified in `tests/inventory-history.test.ts` (4 PD-AC24 tests): a resolved count reference renders `Stock count #<n>` linking to `/stock-counts/<id>`, with cross-org and out-of-scope counts falling back to plain text. |
| PD-AC12, AC13, AC14, AC33, AC34 | **PASS (verified)**, role gate **CODE-ONLY** | Threshold boundaries, read-time evaluation, tenant/location scoping and archived exclusion are tested. The STAFF-rejection path is inherited from the pre-existing `requireCatalogueManager` server-action gate; it cannot be exercised in vitest (server actions depend on `next/headers`). |
| PD-AC15 | **PASS (verified)** | Event type/actor/tenant unchanged; `lowStockThreshold` now present in both `before` and `after` snapshots, with null → 5 → 0 → null transitions and a combined name+threshold edit asserted. |
| PD-AC25 | **PASS (verified)** | No frozen test weakened beyond the two owner-approved amendments; no deleted files; no `.skip`/`.only`/`.todo` anywhere in `tests/`. |
| PD-AC16 | **PASS (verified)** | OWNER and MANAGER can open/enter/approve/cancel; STAFF is rejected server-side on all four lifecycle calls (role read from the `Membership` row inside the transaction, never a caller argument) and gets no list rows and no count detail from either loader; non-members, cross-org ids, nonexistent ids and inaccessible locations all resolve to the same safe error / null (no existence leak). |
| PD-AC17 | **PASS (verified)** | Opening at an archived location is rejected with the frozen C-D20-aligned message; approval after archival is rejected; cancellation **remains possible** on an archived location so the count cannot become stuck OPEN (deviation recorded in §16.8). |
| PD-AC18 | **PASS (verified)** | Approval sets each line's balance exactly to `countedQty` via one corrective movement per non-zero-delta line; zero-delta lines write nothing; `@@unique([countId, variantId])` proven by a direct duplicate-insert rejection (P2002). |
| PD-AC19 | **PASS (verified)** | Double approval is impossible: the status is claimed by a conditional `updateMany` before any work, and a second attempt gets the frozen CONFLICT message with no duplicate movement and no duplicate audit event. |
| PD-AC20 | **PASS (verified)** | A stock change between entry and approval is corrected against the approval-time balance (5 → 13 → 10, one `REMOVED` of -3), not the entry-time expectation. |
| PD-AC21 | **PASS (verified)** | Approving/cancelling another organization's count yields the same `Stock count not found.` error as a nonexistent id; the loaders return null for both. |
| PD-AC22 | **PASS (verified)** | Concurrent adjustment + approval on the same variant, held apart by the explicit row-lock gate, both complete and land on a serialized outcome (4 or 9), never negative, with the ledger reconciled. |
| PD-AC23 | **PASS (verified)** | `adjustInventory` now writes `ADJUST_INVENTORY` with the unchanged metadata payload (`action`, `adjustment`, `reason`), asserted exactly. |
| PD-AC24 | **PASS (verified)** | Count movements surface as `Stock count #<n>` links in the history page; resolution is ONE batched org+location-scoped probe per page (asserted via spy), skipped when the page has no candidates, and never resolves a foreign or out-of-scope count. |
| PD-AC26 | **PASS for D1, D2, D3 (verified)** | All three migrations validated, replayed on a fresh disposable database and confirmed by direct object inspection (D1 thresholds; D2 StockCount models/enum/indexes/uniques/FKs; D3 four `AuditAction` values). |
| PD-AC27 | **SATISFIED (CI verified 2026-11-18)** | Repository `victorikechukwuattansey-freelance/via-saas`; commit `5cd885a6edfa0de000dc71c65c913a34d64edc01`; workflow **`via-saas CI`**, run **#7**, run ID **`44414365910`**; conclusion **success**; 2026-11-18. Run URL: https://github.com/victorikechukwuattansey-freelance/via-saas/actions/runs/44414365910. The `via-saas CI` workflow is the evidence for this criterion; a **separate**, unrelated `test` workflow also ran on this commit and **failed** - disclosed in full in **§16.9.3**. The safe-error / no-existence-leak half of the criterion was verified earlier (PD-AC16, PD-AC21). Previously recorded as **NOT VERIFIED** because no push was authorized at that time. |
| PD-AC28 | **PASS (verified)** | One line per `(countId, variantId)` enforced at the database level (defense-in-depth over the unique index). |
| PD-AC29 | **PASS (verified)** | Opening auto-populates exactly one line per `Inventory` row at the location (including zero-quantity rows), excludes archived products and other locations, and freezes `expectedQty` as the opening snapshot for the life of the count. |
| PD-AC30 | **PASS (verified)** | Cancellation is terminal, writes one `STOCK_COUNT_CANCEL` event, produces no movement, and changes no balance. |
| PD-AC31 | **PASS (verified)** | Cancelling an approved count and approving a cancelled count are both rejected with frozen messages; a repeated cancellation leaves the original `cancelledAt` and one event only. |
| PD-AC32 | **PASS (verified)** | Approval is atomic: an archived product or a deleted inventory row rolls the whole approval back to OPEN with zero movements, and the same count approves successfully after the condition is fixed. |
| PD-AC38 | **PASS (verified)** | Real two-approval overlap on the same variant, forced by an explicit `Inventory` row-lock gate and confirmed via `pg_stat_activity`: both serialize, the surviving balance is one counted value, the ledger reconciles, each count has exactly one movement, and both end APPROVED. A two-variant variant of the test tolerates (and safely retries) a PostgreSQL deadlock — invariants asserted, never which side wins. Two further tests in the same file cover concurrent approval of the **same** count (exactly one winner, no duplicate movement or audit) and a failed approval leaving **no** `STOCK_COUNT_APPROVE` audit row — see §16.9.1. |
| DoD 5 (owner dev-DB smoke) | **OWNER-CONFIRMED 2026-11-19** | Owner-confirmed evidence, **not** an automated-test result. The owner confirms that (a) all five §15 item 5 smoke outcomes passed in the development environment — adjust stock → history shows the typed movement; set threshold → banner flags a low variant; run a count with a variance → approve → exactly one corrective movement, quantity = counted, ledger reconciles — and (b) the browser walkthrough of the stock-count **list** and **detail** pages passed, including rendering and usability. The same smoke pass uncovered the CategoryManager defect fixed as F-4.2 (§16.8.2). Previously recorded as **OPEN** (not performed by the implementation pass). |
| DoD 6 (commit + CI) | **SATISFIED (2026-11-18)** | Commit `5cd885a6edfa0de000dc71c65c913a34d64edc01` (parent `9f3079f`) contains all 32 P1-D files, every path under `via-saas/`; pushed as `26e73b1..5cd885a` to **`via-saas/main`** (`origin` was never used for VIA SaaS); `via-saas CI` run #7 (run ID `44414365910`) concluded **success**; `main` is in sync with `via-saas/main`. The `via-saas/` working tree **was clean at that committed state on 2026-11-18**; the **only** subsequent VIA SaaS modification is this documentation update (uncommitted at the time of writing - it is not claimed that the current working tree is clean). Previously recorded as **OPEN** with the working tree intentionally uncommitted. |
| DoD 7 (§16) | **CLOSED** | This section. |

### 16.5 Prerequisite closures from the phase-boundary audit

| ID | Finding | Closure |
|---|---|---|
| **F1** | Checkout deduction moved after `order.create`, contradicting §6.2's "same in-tx position" | **CLOSED - documentation only.** Owner-ratified order-first sequence recorded in §6.2; atomicity requirement unchanged; no code change was required. |
| **F2** | Plan stale about itself (status, PD-D7, missing §16) | **CLOSED.** §1 status, §8 PD-D7, §11 heading and this §16 record. |
| **F3** | `lowStockThreshold` absent from the `VARIANT_UPDATE` audit snapshots | **CLOSED - code + tests.** Threshold added to the pre-read select, the post-update select and both snapshots; event type, actor, tenant scope and transaction behavior unchanged. |
| **F4** | PD-2 movement query had no organization-chain predicate | **CLOSED - code + tests.** `location: { store: { organizationId } }` added alongside the accessible-location list (narrows, never broadens); pagination, ordering, typed reference resolution and STAFF restrictions unchanged. |
| F5 | `loadLowStock` is an unbounded org-wide read (display capped only) | **OPEN - accepted at current scale.** Revisit if the catalogue grows large or the dashboard render time degrades. |
| F6 | Banner CTA uses `<a>` rather than `next/link` | **OPEN - cosmetic.** Not fixed (out of the authorized closure scope). |
| F7 | PD-AC9 count-link clause deferred | **CLOSED in PD-4.** Count references now resolve to `Stock count #<n>` links (PD-AC24 tests in `tests/inventory-history.test.ts`). |
| F8 | `inventory-contract.test.ts` finally-block row does not reconcile (outside the invariant population) | **OPEN - informational.** Only matters if PD-4 adds a global reconciliation assertion. |
| F10 | Unrelated untracked root `prisma/` + `prisma.config.ts` outside `via-saas/` | **PRESERVED, untouched.** |

### 16.6 PD-AC38 - two concurrent approvals on the same variant (implemented mechanism + evidence)

**Original assessment (unchanged, kept for the record): the criterion is NOT satisfiable by a naive read-then-write implementation under Prisma's default READ COMMITTED.** This section now records what was implemented and how it was verified.

Harness capability (inspected at assessment time):

- Real PostgreSQL 15 (`localhost:5430`), disposable `via_saas_test` recreated per run with the full migration history; no mocks, no SQLite.
- Nine pre-existing test files already execute genuinely concurrent operations via `Promise.all` / `Promise.allSettled`, asserting *outcome invariants* rather than which caller wins — the pattern adopted here.
- Each test file owns its own organizations/locations/variants (random suffixes), so same-variant contention stays inside a single file and is unaffected by `fileParallelism: true`.

The hazard under a naive implementation (blocking for the literal wording "net effect correct"):

- Prisma defaults to **READ COMMITTED**. Two approvals of different counts on the same variant can both read the same `currentQuantity`, so `countedQty - currentQuantity` is computed from one stale base. Example: quantity 5, count A counted 10, count B counted 20 → deltas +5 and +15 from the same base → final 25 instead of the serialized 20. Decreasing deltas can drive the value below zero, where `inventory_quantity_non_negative` turns the race into an error rather than a wrong number.

**Chosen mechanism (owner-approved, implemented in `packages/core/src/stock-counts.ts`):**

1. **Row-level locks inside the approval transaction.** `lockInventoryRows(tx, locationId, variantIds)` issues `SELECT … FROM "Inventory" WHERE "locationId" = $1 AND "variantId" IN (…) ORDER BY "variantId" ASC FOR UPDATE` (raw `$queryRaw` with `Prisma.join`). Every affected inventory row is locked in deterministic `variantId` order before any quantity is read.
2. **Read only after locking.** Approval claims the count's status via a conditional `updateMany` (which also takes the count row lock), validates, then locks the inventory rows, and only then reads balances. Deltas are computed and applied entirely under the lock, so no delta is ever derived from a pre-lock read. A naive read-then-write is structurally impossible on this path.
3. **Deterministic ordering in JavaScript too.** `lockInventoryRows` returns the rows re-sorted by `variantId`, so callers and tests observe one stable order regardless of planner output.
4. **Atomicity.** Approval status, inventory updates, movements and the `STOCK_COUNT_APPROVE` audit event share one transaction; any failure rolls everything back and leaves the count OPEN.

**Residual caveat (recorded, not hidden):** `ORDER BY … FOR UPDATE` makes lock acquisition order deterministic *at the SQL level*, but PostgreSQL does not contractually guarantee row-lock acquisition strictly in sort order at the planner level. The implementation therefore does not depend on it for correctness: if the database deadlocks on a two-variant overlap, the transaction aborts safely (count stays OPEN, zero movements) and a retry succeeds. The two-variant test asserts exactly that tolerant behavior.

**Evidence:** `tests/stock-counts.test.ts` — 46 tests, of which the `PD-AC38 — concurrent approvals serialize on the Inventory row lock` block covers (a) ascending-order locking with locked balances returned, (b) two approvals of the same variant forced to overlap by an explicit `Inventory` row-lock gate and confirmed through `pg_stat_activity` (`wait_event_type = 'Lock'`, `FOR UPDATE`), and (c) the deadlock-tolerant two-variant case. No wall-clock sleeps are used as a synchronization mechanism; polling of `pg_stat_activity` has a bounded deadline and fails loudly if the expected overlap is never observed. *(Test count as recorded on 2026-11-18. The committed file holds **48** tests: the same-count approval test and the failed-approval audit-rollback test were added in the same commit — §16.9.1.)*

### 16.7 Explicitly not authorized / still open (state recorded 2026-11-18; items 1-3 since closed)

Preserved for the record. Each item states the position recorded on 2026-11-18 and its current status; §16.4 is authoritative for the present state.

- **PD-AC27 / DoD 6** - recorded 2026-11-18: "no staging, commit, push, deployment, or CI verification has occurred or is authorized. HEAD is still `9f3079f`; all PD-1..PD-4 work is uncommitted in the working tree." **Current: CLOSED 2026-11-18** - commit `5cd885a` (32 files, all under `via-saas/`) pushed as `26e73b1..5cd885a` to `via-saas/main`; `via-saas CI` run #7 (run ID `44414365910`) concluded **success**; `via-saas/` tree clean.
- **DoD 5** - recorded 2026-11-18: "the manual dev-database smoke test remains an owner action." **Current: CLOSED, OWNER-CONFIRMED 2026-11-19** - all five §15 item 5 outcomes passed, and the stock-count list/detail browser walkthrough passed including rendering and usability (§16.4).
- **Browser rendering of the count surfaces** - recorded 2026-11-18: the two count pages and the entry form were CODE-ONLY because the React render is not exercised in vitest. **Current:** the owner's DoD 5 browser walkthrough (2026-11-19) covers rendering and usability of the list and detail pages; they remain outside *automated* coverage by design (this repo has no DOM/component test harness).
- **F5, F6, F8** - unchanged and still open: recorded and deliberately not fixed (out of scope for every phase so far). See §16.5.

### 16.8 PD-4 deviations, additions and residual findings

Everything below departs from, or adds to, the letter of §6.3/§9 as written. Each is a deliberate decision, not an accident.

| # | Item | Decision / deviation | Rationale |
|---|---|---|---|
| D-4.1 | `StockCount.@@unique([organizationId, countNumber])` | **Added** beyond the columns D2 lists. | Count numbers are allocated under an `Organization` row `FOR UPDATE` lock using `MAX(countNumber)+1`; the unique index is the database-level guarantee that a numbering collision can never persist even if the lock discipline is ever changed. Recorded here as an addition to D2's listed contents. **OWNER-RATIFIED 2026-11-18** (explicit decision, §16.8.1) - not merely an implementation note. |
| D-4.2 | Cancellation on an archived location | **Allowed** (approval is rejected). | If cancellation also required a non-archived location, an OPEN count whose location was archived between opening and cancellation would be permanently stuck OPEN. Cancellation has no stock effect, so allowing it is safe; location *access* is still enforced. Opening and approval remain subject to the archived-location restriction (C-D20/PD-AC17). **OWNER-RATIFIED 2026-11-18** (explicit decision, §16.8.1) - not merely an implementation note. |
| D-4.3 | Approval ordering: claim status, then validate | Approval first claims the status with a conditional `updateMany`, then validates lines and applies deltas. | The claim both guards against double approval and takes the count row lock, so two approvals cannot both proceed to validation. Any later failure rolls the claim back, leaving the count OPEN (PD-AC32). |
| D-4.4 | Loader scoping by membership location restriction, **not** by active-location filter | `loadStockCountsPage` / `loadStockCountDetail` scope counts by organization + the membership's `allowedLocationIds`, and deliberately do **not** filter out archived locations. `openableLocations` (the "start a count here" list) excludes archived locations. | Counts are historical records: an approved count at a since-archived location must stay auditable, and an OPEN count on an archived location must stay reachable so it can be cancelled (D-4.2). |
| D-4.5 | DB-side lock-order guarantee | `ORDER BY "variantId" ASC … FOR UPDATE` is best-effort at the planner level; correctness does not depend on it. | PostgreSQL does not contractually guarantee lock acquisition in sort order. A deadlock therefore aborts safely (OPEN + zero movements) and is tolerant-retried by the test. Documented in §16.6. |
| D-4.6 | Count number start value | Count numbers start at **1001** per organization. | Matches the established org-scoped sequential counter pattern used elsewhere; asserted in tests so a future change is a deliberate one. |
| D-4.7 | Pre-existing `AuditLog_actorId_fkey` drift | **Not changed.** | `prisma migrate diff` still reports baseline + P1-B use `ON DELETE RESTRICT` where the schema implies `SET NULL`. This pre-dates PD-4 and is out of the PD-4 authorization scope; touching it would be an unrequested schema change. |
| D-4.8 | PD-AC22 residual class | Concurrent adjust + approve is asserted to land on one of the two serialized outcomes (pre- or post-adjustment balance), never negative, ledger reconciled. | Which ordering wins is not deterministic by design; asserting an invariant rather than a specific winner is the correct contract. |
| F-4.1 | F8 (`inventory-contract.test.ts` finally-block row outside the invariant population) | Left open. | PD-4 added no global reconciliation assertion, so the informational finding still has no effect. |

### 16.8.1 Owner ratifications of PD-4 deviations (2026-11-18, explicit)

The post-implementation acceptance audit returned **IMPLEMENTATION ACCEPTABLE WITH OPEN GATES** and referred two disclosed deviations back to the owner, because a recorded deviation is not an accepted deviation. The owner then ruled explicitly:

| Deviation | Owner ruling (2026-11-18) | Effect on the plan |
|---|---|---|
| **D-4.1** - `StockCount.@@unique([organizationId, countNumber])`, added beyond the columns D2 lists in §9 | **RATIFIED.** The additional unique constraint is an accepted part of the P1-D schema. | D2's delivered content now includes this constraint as an owner-approved addition. §9's D2 row remains the *original* specification; this record is the amendment. |
| **D-4.2** - cancellation permitted on a stock count whose location is archived | **RATIFIED.** Cancellation of an OPEN count at an archived location is an accepted behaviour, because otherwise the count would be permanently stuck OPEN. **Unchanged:** *opening* and *approval* remain subject to the archived-location restriction (C-D20, PD-AC17). | PD-AC17 stands as written (open/approve rejected); cancellation is explicitly outside it. |

Both entries are **owner decisions**, not implementation notes. They do not alter PD-AC17, PD-AC18, the state machine (§6.3), or any other approved semantics, and they do not broaden P1-D scope.

A third finding from the same audit - the pre-existing `adjustInventory` audit event being written outside the adjustment transaction (recorded here as D-obs.3) - was separately authorized for repair together with two additional PD-AC38 tests. Both were implemented and committed: the repair and the two tests are recorded in **§16.9.1**.

### 16.8.2 CategoryManager fix — F-4.2 (owner-authorized 2026-11-18, DoD 5 scope extension)

**File:** `apps/merchant-dashboard/app/(dashboard)/products/CategoryManager.tsx`

**Defect class:** Pre-existing React async-event bug. Not introduced by P1-A, P1-B, P1-C, or P1-D. Uncovered during the DoD 5 browser smoke test on 2026-11-18.

**Symptom:** Calling `e.currentTarget.reset()` after `await serverAction(formData)` throws `TypeError: Cannot read properties of null (reading 'reset')` because React releases the synthetic event and its `currentTarget` reference once the synchronous dispatch returns. The result is a client-side crash on the products page when creating or deleting a category. Server-side mutation and audit had already committed successfully before the crash; only the client reset failed.

**Root cause confirmation:** `git diff 859d407..HEAD -- "apps/merchant-dashboard/app/(dashboard)/products/CategoryManager.tsx"` returned empty BEFORE the fix was applied, proving the file was last modified before P1-D began and the defect is not a P1-D regression.

**Fix (two-line change, isolated to one file):**
- Capture the form reference before the await: `const form = e.currentTarget`
- Use the captured reference after the await: `form.reset()` (and `new FormData(form)` for consistency)
- No changes to the server action, audit event, or Prisma schema

**Verification performed 2026-11-18:**
- Dev server running on http://localhost:3000 (via `apps/merchant-dashboard` `npm run dev`)
- Four consecutive category create/delete operations exercised
- Each returned `POST /products 200` with a complete `INSERT INTO "Category"` → `INSERT INTO "AuditLog"` → `COMMIT` sequence in the terminal
- Zero `Cannot read properties of null` errors in the browser or terminal
- No test suite changes required (the fix is UI-only and not covered by any automated test file; the crash occurs in React's event handler after the server action has already returned)

**Classification:** Owner-authorized scope extension. Not part of any PD-AC. Recorded here as F-4.2 so the milestone's evidence trail is complete. Does not affect PD-AC1..PD-AC38 outcomes; does not change P1-D acceptance status.

### 16.9 Post-audit repair record and closure reconciliation (2026-11-18 / 2026-11-19)

Added during the documentation reconciliation that closed P1-D. This section records only work that exists in the committed tree; it adds no implementation detail that is not observable there and changes no acceptance criterion.

#### 16.9.1 D-obs.3 repair - `adjustInventory` audit atomicity, and the two authorized PD-AC38 tests

**Finding (D-obs.3, from the post-implementation acceptance audit):** `adjustInventory` in `packages/core/src/products.ts` wrote its `ADJUST_INVENTORY` audit event through `logAuditEvent(...)` **without** the transaction client, so the audit row was committed outside the adjustment transaction - the quantity change and its audit record could diverge.

**Repair (owner-authorized 2026-11-18):** `logAuditEvent` in `packages/core/src/audit.ts` already accepts an optional transaction client; the `ADJUST_INVENTORY` call site now passes `tx`, so the audit row shares the adjustment transaction. No signature change, no schema change, no behavioral change at any other call site, and the `ADJUST_INVENTORY` metadata payload (`action`, `adjustment`, `reason`) is unchanged (the PD-AC23 assertion is untouched).

**Status: IMPLEMENTED AND COMMITTED** in `5cd885a`. Verified by reading the committed file (`git show HEAD:via-saas/packages/core/src/products.ts`): the `"ADJUST_INVENTORY"` call passes `tx`.

**The two additional PD-AC38 tests authorized alongside the repair were implemented**, in `tests/stock-counts.test.ts`:

| Test | What it proves |
|---|---|
| `two concurrent approvals of the SAME count: exactly one winner, no duplicate movement or audit` | Two simultaneous approvals of the *same* count serialize behind a `StockCount` row `FOR UPDATE` latch held from a separate connection: exactly one succeeds, the count ends APPROVED once, with no duplicate corrective movement and no duplicate `STOCK_COUNT_APPROVE` event. |
| `failed approval (archived product) leaves NO STOCK_COUNT_APPROVE audit row and no movement` | A failed approval rolls back completely - the count stays OPEN, zero `StockMovement` rows reference the count, and **zero** `STOCK_COUNT_APPROVE` audit rows exist (the assertion the audit found missing). |

Both are part of the committed `tests/stock-counts.test.ts` (48 `it(...)` declarations). Both are covered by the focused two-file validation recorded in **§16.9.2** (`stock-counts.test.ts` 48 tests + `inventory-contract.test.ts` 18 tests = **66 tests across two files**) - previously reported validation evidence, **not** a run performed during this documentation pass. PD-AC38 therefore remains **PASS**, now covering the same-count overlap and the failed-approval audit rollback in addition to the different-counts concurrency evidence in §16.6.

#### 16.9.2 Test-count reconciliation - observed count recorded, historical discrepancy explicitly unresolved

Three different figures appear across this milestone's records. They are listed below as recorded/measured, with no figure silently substituted for another:

| Source | Files | Tests |
|---|---|---|
| §16.3 (recorded 2026-11-18, PD-2/PD-3 boundary) | 23 | 278 |
| §16.3.1 (recorded 2026-11-18, PD-4) | 24 | 328 (= 278 baseline + 46 PD-4 + 4 history) |
| Commit `5cd885a` message and the implementation handoff | - | 332 / 332 |
| **Static count of `it(`/`test(` declarations in the committed `tests/**/*.test.ts` at `5cd885a`** | **24** | **332** |

What is directly observable in the committed tree:

- `vitest.config.ts` includes `tests/**/*.test.ts` only; at `5cd885a` that is **24 files**.
- Those 24 files contain **332** `it(...)`/`test(...)` declarations, with **no** `it.each`, `test.each` or `describe.each` and no test-generating loops (the `for` loops in these suites iterate assertions inside a test, not test cases). The declaration count therefore equals the executed-test count for every file.
- Cross-check: the focused two-file validation reported **2 files / 66 tests passed** for `npx vitest run tests/stock-counts.test.ts tests/inventory-contract.test.ts` (`stock-counts.test.ts` 48 + `inventory-contract.test.ts` 18 = 66). This is **previously reported execution evidence** - it was performed before the P1-D commit on 2026-11-18 and was **not** re-executed during this documentation-only pass (no fresh run is claimed here). It is also **not** a full-suite run.
- `stock-counts.test.ts` declares **48** tests, not the **46** recorded in §16.3.1 and §16.6. The +2 is explained by §16.9.1: the two additional PD-AC38 tests were added to that file in the same commit.
- The parent commit `9f3079f` (`HEAD^`) contains **20** test files and **222** declarations - not the "23 files / 278 tests" recorded in §16.3, and not the 278-test baseline that §16.3.1's arithmetic starts from.

**Conclusion (deliberately unresolved):** the committed suite is **24 files / 332 test declarations**, and 332 is consistent with the reported `332/332`. The historical **328** - and the **278** baseline behind it - is preserved as recorded but is **not reproducible** from the committed tree: it undercounts `stock-counts.test.ts` by two and rests on a 278-test / 23-file baseline that does not match the 222 declarations / 20 files at `9f3079f`. The exact composition of the historical 278 figure cannot be established from the available evidence.

**Why the gap is not closed here:** no CI artifact exposing per-test counts is available locally (the `gh` CLI is not installed on this machine), and the full suite was **not** re-executed during this documentation-only pass. The 332 figure is therefore supported by committed-source evidence plus the 66-test cross-check, but it is not claimed as a fresh full-suite execution result in this document.

#### 16.9.3 Sibling `test` workflow on `5cd885a` (disclosure)

`via-saas CI` is the canonical workflow for PD-AC27 (§3). A second, **unrelated** workflow also ran on commit `5cd885a` and **failed**. It is recorded here in full so that the "CI verified" statements in §16.4 cannot be read as covering every workflow that ran:

| Item | Value |
|---|---|
| Workflow | `test` (`.github/workflows/test.yml`) - the **parent workspace's** n8n lead-recovery gate, **not** a VIA SaaS workflow |
| Run | **#7**, run ID **`44414365728`** |
| Commit | `5cd885a6edfa0de000dc71c65c913a34d64edc01` (the same commit) |
| Date | 2026-11-18 |
| Conclusion | **failure** |
| Job | `n8n-lead-recovery full suite + frozen integrity + security gate` - a single job; it failed at its **"Full test suite"** step, so its "Frozen artifact integrity" and "Security gate" steps were skipped as a result |
| Pre-existing | The same workflow also failed on the earlier P1-C commit `26e73b1` (run #6), so the failure was **not** introduced by P1-D |

**Effect on P1-D: none.** PD-AC27 is defined against the canonical `via-saas CI` workflow (§3, §11), which concluded **success** on `5cd885a` (§16.4). The failing workflow exercises the parent workspace's `n8n-lead-recovery` project, contains no VIA SaaS job, and sits outside the P1-D scope and gates. It is disclosed here rather than omitted or minimised; it does not change the PD-AC27 result, DoD 6, or the closure decision. Whether the parent-workspace workflow should be repaired is a separate matter outside P1-D.

---

*End of plan. Owner approvals PD-D1, PD-D2, PD-D3 recorded 2026-11-17; the R-1..R-11 review corrections were applied in a documentation-only pass on 2026-11-17 (R-5's `STOCK_COUNT_CANCEL` explicitly owner-approved); PD-D7 was satisfied by the owner at kickoff on 2026-11-18, when PD-1/PD-2/PD-3 plus migration D1 were authorized and implemented. PD-4 (P1-22) was authorized by the owner under a separate explicit authorization on 2026-11-18 and is implemented with migrations D2/D3 and its evidence recorded in §16.8; the D-obs.3 audit-atomicity repair and the two additional PD-AC38 tests are recorded in §16.9.1. **P1-D is CLOSED (2026-11-19):** PD-AC27 is satisfied by `via-saas CI` run #7 (run ID `44414365910`, commit `5cd885a`, conclusion success, 2026-11-18); DoD 5 is OWNER-CONFIRMED 2026-11-19; DoD 6 is satisfied by commit `5cd885a` on `via-saas/main`, with the `via-saas/` tree clean at that committed state (2026-11-18); the only later VIA SaaS change is this documentation update. The commit and push were owner-authorized for the P1-D implementation only; this document authorizes no deployment and no production database change, and none has occurred. The suite-size figures in this document remain historically inconsistent: the historical **full-suite totals** (278 and 328) are unresolvable from the committed tree - see §16.9.2, which records the observed 24 files / 332 declarations and explicitly leaves those two totals unresolved rather than reconciling them.*
