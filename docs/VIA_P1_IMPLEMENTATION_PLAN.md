# VIA SaaS — P1 Implementation Plan
## Complete Core Merchant Operations

**Status:** PLANNING — approved for planning only. No implementation authorized by this document.
**Authoritative predecessor:** `docs/VIA_PRODUCT_BLUEPRINT_AND_DEVELOPMENT_BACKLOG.md` (Sections C–K)
**Baseline verified at:** commit `8eec1fc` (`main`, pushed, remote CI green — run 43704895861, 48/48 tests). Repository inspected directly; no drift since M1.
**Scope guard:** P1 covers catalogue, inventory control, procurement, transfers, POS/order lifecycle, customers, staff/org. It does **not** cover payments integration, refunds as money movement, receipts as documents (PDF/print), shipping, analytics exports, or any P2/P3 item.

---

## A. Executive Summary

M1 delivered the trust foundation: server-authoritative pricing, tenant/location authorization, actor integrity, session expiry enforcement, secure invites, managed migrations, uniqueness constraints, a 48-test regression suite, and green CI. The product can now be trusted at its edges.

What it cannot yet do is be a **complete merchant operating platform**. The gaps, verified in code:

- A product can be created but never edited, archived, categorized, imaged, or given real variants — every UI hardcodes `variants[0]`.
- Inventory has a quantity and a movement ledger but no history UI, no stock counts, no low-stock thresholds.
- Suppliers, purchase orders, goods receiving, and stock transfers **do not exist at all** (no models, no code).
- The POS can sell and resolve ATTENTION orders, but there is no order detail/receipt view, no cancellation path for normal orders, no pagination, no per-location views.
- Customers are a read-only list; no profiles, no purchase history, no search.
- Staff roles are coarse strings; `memberships[0]` arbitrarily picks the org; staff cannot be listed, edited, or removed; locations cannot be created after registration.
- Cross-cutting debt carried into P1 by design: thin audit coverage (E-17), no rate limiting (E-13 remainder), fabricated `costPrice` (E-21).

This plan sequences seven workstreams around the actual dependency graph rather than the blueprint's provisional order. The critical finding: **catalogue management (P1.1) is upstream of almost everything** — procurement line items, transfer visibility, POS variant selection, and storefront publication all consume the product/variant model. It is recommended as the first implementation milestone (Section K), followed by POS/order lifecycle completion, then the inventory-control cluster, with procurement and transfers last.

Thirteen product decisions require owner input; seven of them block specific workstreams (Section I). Defaults are recommended where evidence supports one; none are silently decided.

---

## B. Current Implementation Baseline (verified at `8eec1fc`)

### B.1 Architecture (unchanged, retained per blueprint H)

| Plane | Tech | Entry points |
|---|---|---|
| Merchant dashboard | Next.js 14 App Router, Server Actions, cookie sessions | `apps/merchant-dashboard/app/**` |
| Public storefront API | Fastify 4 | `apps/api/src/server.ts` |
| Storefront UI | Next.js static fetch page | `apps/storefront/app/page.tsx` |
| Domain core | Shared TS package | `packages/core/src/{orders,products,customers,auth,audit,errors}.ts` |
| Data | PostgreSQL 15 + Prisma 5.22, managed migrations | `packages/database/prisma/**` |
| Tests / CI | Vitest 5.1 + disposable `via_saas_test` DB; GitHub Actions | `tests/**`, `.github/workflows/via-saas-ci.yml` |

### B.2 Domain model as it exists (20 tables)

**Tenancy/auth:** `User`, `Session` (opaque token, 7-day expiry, lazy-deleted when expired), `Organization`, `Membership` (`role: OWNER|MANAGER|STAFF` string, `allowedLocationIds: string[]` — empty = all locations, **enforced** in `getSessionContext` since M1), `StaffInvite` (SHA-256 single-use 48h token), `ApiKey` (dead — P3), `OrderCounter` (per-org sequential order numbers), `Store` (`slug` unique — public storefront resolver), `Location` (flat under one Store; no CRUD UI).

**Catalogue/inventory:** `Product` (`status: DRAFT|PUBLISHED` string, `description` unused), `ProductVariant` (single "Default" variant auto-created; `sku` globally unique; `barcode` unused; `costPrice` fabricated as `price * 0.5` — E-21, deferred), `Inventory` (per `(locationId, variantId)`, DB CHECK `quantity >= 0`), `StockMovement` (append-only ledger: `SALE|TRANSFER|ADDED|REMOVED|RETURN`; `actorId` nullable = system/storefront, never fake ids), `AuditLog` (enum only covers `CREATE_PRODUCT, UPDATE_PRODUCT, INVITE_STAFF, RESOLVE_ORDER, UPDATE_SETTINGS`).

**Selling:** `Customer` (`@@unique([organizationId, phone])`, race-safe upsert), `Order` (`status: PENDING|ATTENTION|FULFILLED|CANCELLED` × `paymentStatus: UNPAID|PAID|REFUNDED` — conceptually separate since M1; `@@unique([organizationId, orderNumber])`, sequential `ORD-n`), `OrderItem` (unit-price snapshot at sale time).

**Dead models:** `Cart`/`CartItem` — zero code references; `POST /api/cart` mints a token that is never persisted or validated.

### B.3 Workflow behavior as implemented

| Area | State | Notes |
|---|---|---|
| Product create | **Implemented** | `createProduct` → tx: product + Default variant + inventory row @ location + audit. Location ownership verified (M1). No edit/delete/variants/categories/images. |
| Inventory adjust | **Implemented** | `adjustInventory`: org-ownership checks on variant+location, guarded atomic `updateMany` (rejects below zero), movement + audit. Permission: any authenticated role at an accessible location. |
| POS checkout | **Implemented** | Server action → race-safe customer upsert → `processCheckout`: server-priced (`Prisma.Decimal`), per-item guarded decrement in-tx, sequential order number, SALE movements. Stock shortfall → **ATTENTION** order (no deduction), server-priced. |
| ATTENTION resolve | **Implemented** | Membership-verified actor, org-scoped fetch, location check in the action. FULFILL re-deducts + real-actor movements + audit; CANCEL flips status + REFUNDED-if-paid (status flip only — safe while no money rails exist). |
| Customers | **Partially implemented** | Race-safe upsert + read-only list with order counts. No profile/edit/search/history view. |
| Staff invites | **Implemented** | Token flow (hashed, single-use, 48h), existing-user linking, `/invite/[token]` password setup. No invite listing/revocation, no staff edit/remove. |
| Storefront API | **Partially implemented** | Slug-resolved org, PUBLISHED-only filter, CORS allowlist, safe error envelopes, basic body validation on checkout. **No rate limiting, no schema-validation library, cart token still ephemeral.** |
| Storefront UI | **Minimal, functional** | Fetches slug products; checkout with `storeSlug`; client prices no longer sent. |
| Analytics | **Implemented (small data)** | Org-filtered aggregates; top-products computed in JS over all paid order items (unbounded at scale — noted, not P1). |

### B.4 Test baseline (48 tests / 7 suites, all passing in CI)

`checkout-pricing` (E-1: server pricing, malicious client price, cross-tenant cart, merge, consistency), `tenant-authorization` (E-4/E-5/E-11 matrix + adjustment regressions), `attention-orders` (E-5 lifecycle + actor integrity E-3), `order-numbers` (E-14/E-15: sequential, parallel-unique, DB constraint), `customers` (E-16: race-safety, per-org scope), `invites` (E-2: hash-only, single-use, expiry, linking, validation, cross-org location), `session` (E-8: expiry + deletion, `allowedLocationIds` enforcement).

### B.5 M1 security controls that P1 must preserve (non-negotiable)

1. All server money math from DB records via `Prisma.Decimal`; client prices never accepted.
2. Org scoping on every resource fetch; fail-closed (`FORBIDDEN`/`ORDER_NOT_FOUND` — never leak existence).
3. Location operations gated by membership `allowedLocationIds` (empty = all).
4. `StockMovement.actorId` ∈ {real member User id, `null` for system/storefront}; FULFILL writes the resolving member.
5. Expired sessions unauthenticated + deleted on access, via the single `getSessionContext` path.
6. No generated/predictable passwords; invite tokens hashed, single-use, expiring.
7. All schema changes via managed migrations; fresh-DB replay must succeed; no `db push`.
8. Safe error envelopes everywhere; no internals leaked to clients.
9. Guarded atomic stock updates (`updateMany` + count check + CHECK constraint) inside transactions.

### B.6 Discrepancies between the blueprint and current reality

The blueprint's Section C inventory describes the **pre-M1** state. Factual updates for planning:

| Blueprint claim | Current reality |
|---|---|
| C.1: expiry only checked in layout | **Fixed (E-8)** — centralized in `getSessionContext`; expired sessions deleted. |
| C.2: `registerOrganization` dead code | Still dead — the dashboard registration action performs its own tx (now with slug). Consider deleting the core duplicate during P1.7. |
| C.2: `allowedLocationIds` never enforced | **Fixed (E-11)** — enforced in `getSessionContext`; covered by tests. |
| C.3: `adjustInventory` lacks ownership checks | **Fixed (E-5)** — variant+location ownership verified in-tx; tested. |
| C.4: client-priced orders, random order numbers, org-less resolve, fake actor ids | **All fixed (E-1/E-14/E-4/E-3)** — regression-tested. |
| C.5: no customer uniqueness | **Fixed (E-16)** — DB constraint + atomic upsert; race-tested. |
| C.7: hardcoded org, CORS `*`, drafts exposed, leaking errors | **Fixed** — slug resolution, allowlist, PUBLISHED filter, `DomainError` envelopes. |
| E-13: no validation, no rate limits | **Partially fixed** — manual body checks on checkout; still no validation library, **no rate limiting** (open into P1). |
| E-17: audit coverage thin | **Still open (P1)** — enum too narrow; adjustments reuse `UPDATE_PRODUCT`; checkout, invites-by-link, settings changes partly unaudited. |
| E-20: expired sessions never cleaned | **Partially fixed** — lazily deleted on access; no scheduled cleanup (stays P2). |
| E-21: `costPrice` fabricated | **Still open (P1)** — `price * 0.5` retained deliberately in M1; fix scheduled with catalogue work. |
| C.8: no migrations | **Fixed** — baseline + `20261115090000_m1_integrity`; fresh-DB replay verified; CI applies migrations. |

---

## C. P1 Product Scope

Seven workstreams plus three cross-cutting remediation threads. Each is planned to leave the product one coherent step closer to the blueprint's D-section MVP without touching payments, shipping, or analytics scope.

| # | Workstream | Coherent capability delivered |
|---|---|---|
| P1.1 | Catalogue management | Merchants fully manage what they sell: edit, archive, true variants, categories, SKU/barcode, draft/published control, images (URL-based MVP), explicit cost price. |
| P1.2 | Inventory control | Merchants can see and trust their stock: movement history per variant/location, low-stock thresholds, stock counts with corrective movements. |
| P1.3 | Suppliers & procurement | Buy stock deliberately: suppliers, POs with lines, partial/complete receiving → audited inventory movements. |
| P1.4 | Multi-location operations | Move stock between locations safely: dispatch → in-transit → receive/cancel, with a complete movement trail. |
| P1.5 | POS & order lifecycle | Finish the selling loop: full cart/variant selection, order detail/receipt record, cancellation rules, history with filters/pagination. |
| P1.6 | Customer management | Own the customer relationship: profiles, edit, per-customer order history, search/dedup hygiene. |
| P1.7 | Staff & organization | Operate the team and the org: role clarity, invite lifecycle, staff management, location CRUD, org switching. |
| X-1 | API hardening completion (E-13 remainder) | Rate limiting + schema validation on the public plane. |
| X-2 | Audit coverage (E-17) | Every state-changing action writes exactly one audit event; enum widened. |
| X-3 | Error envelope & input validation for dashboard actions (E-22 remainder) | Uniform `{error}`/`{success}` shapes, server-side validation of all action inputs. |

---

## D. Workstream-by-Workstream Gap Analysis

For each workstream: existing functionality → files → models → business rules → M1 controls to preserve → missing functionality → defects/limitations → dependencies → existing tests → tests to add.

### D.1 P1.1 — Catalogue management

**Existing:** create-only flow (`core/products.ts:createProduct`, `products/page.tsx` + `products/actions.ts`); single auto-created "Default" variant; `Product.status` exists and is enforced on the public API only; `description` column unused; `barcode` column unused; `sku` globally unique.

**Missing (all unimplemented):**
1. Product editing (name, description, price on variants, status) — no code path.
2. Archival/deletion — nothing. `Product.status` has no ARCHIVED state; no soft-delete concept.
3. True multi-variant management — every consumer hardcodes `variants[0]` (`products/page.tsx:66`, `orders/page.tsx:32`, POS grid, storefront). No UI or core functions to add/edit variants.
4. Categories — no model, no UI.
5. SKU/barcode handling — SKU is a free-text optional field, globally unique (cross-org uniqueness is wrong for a multi-tenant product); barcode never read anywhere.
6. Product images — no model, no storage, no UI.
7. Validation — create validates name/price/stock; edit paths don't exist yet.
8. `costPrice` still fabricated (E-21).

**Models/relationships to add:** `Category` (org-scoped, `@@unique([organizationId, name])`), `Product.categoryId?`, `Product.archivedAt DateTime?` (soft archive; keep `status` for draft/published), `ProductImage` (org-scoped, `productId`, `url`, `isPrimary`, sort order) **or** a plain `imageUrl` on Product — decided by D-3. Variant option labels (`name` already serves as "Red / Medium" — acceptable for MVP, no option-matrix engine).

**M1 controls to preserve:** org scoping on all reads/writes; location ownership check on any inventory creation for new variants (mirror `createProduct`'s location check); safe errors; audit on UPDATE_PRODUCT with before/after metadata.

**Dependencies:** none upstream — this is the root. Downstream consumers: P1.2 (variant selection for history/thresholds), P1.3 (PO line items need variant+cost), P1.4 (transfer lines), P1.5 (POS variant picker), storefront (images, drafts, archive exclusion).

**Existing tests:** create-path is exercised indirectly via fixtures; no dedicated product tests.
**Tests to add:** product update (fields persist, org-scoped); edit by non-member → FORBIDDEN; archive → excluded from storefront API + POS, inventory/movements retained; restore; variant CRUD incl. SKU uniqueness **per org** (D-2); category CRUD + assignment; published/draft enforcement on public endpoint; validation failures; audit row written exactly once per action.

**Regression risks:** SKU uniqueness change (global → per-org) requires a migration that may collide on existing data (dev DB has few SKUs — verify before migrating); storefront consumers must not break when products gain variants beyond index 0.

### D.2 P1.2 — Inventory control

**Existing:** `Inventory.quantity` per (location, variant) — **the authoritative quantity** (every mutation path goes through guarded atomic updates; movements are the ledger, never the source of truth); `StockMovement` ledger written by checkout, adjustments, and fulfill; adjustment UI exists; dashboard "Low Stock Alerts: Coming Soon" placeholder.

**Missing:**
1. Inventory history UI — data exists (`StockMovement` filtered by variant/location), no view. Movement `referenceId` is a bare id (order id or free-text reason) with no uniform resolution — a **known limitation**; plan: typed reference (polymorphic display by `type`, P1 renders "Order ORD-1001" / reason string).
2. Low-stock thresholds — `ProductVariant.lowStockThreshold Int?` does not exist; evaluation at read time (blueprint F.1) — no jobs needed.
3. Stock counts — nothing. Needs `StockCount` + `StockCountLine` (counted qty, variance) and an approval step producing **one** corrective `StockMovement(ADDED/REMOVED, referenceId: countId)` that sets quantity to the counted value.
4. Inventory visibility by location — pages show aggregated/first-variant stock only; no location filter.
5. Stock-taking permissions — who may count/approve (D-5).

**Authoritative-quantity rule (explicit):** `Inventory.quantity` is the only authoritative balance. Every flow (PO receiving, transfer dispatch/receipt, counts) must mutate it through the same guarded `updateMany` + count-check + CHECK-constraint pattern inside a transaction, writing exactly one movement per change. The ledger must always reconcile: `sum(movements since epoch)` = current quantity per (location, variant) — add a reconciliation test.

**Dependencies:** P1.1 (variant browsing is trivially better after it, but history/threshold models are independent — can start in parallel if sequenced carefully). Downstream: P1.3/P1.4 consume the same mutation patterns.

**Tests to add:** threshold flagging; count approval → single corrective movement + quantity set exactly; count on another org's location → FORBIDDEN; concurrent adjustment + count race (guarded update wins); history read is org-scoped; ledger reconciliation invariant.

### D.3 P1.3 — Suppliers and procurement

**Existing:** **nothing.** No models, no code, no UI.

**Lifecycle to implement (blueprint F.1):**

```
Supplier → Purchase Order (DRAFT → SUBMITTED) → Goods Receipt (partial allowed) → StockMovement(ADDED, ref: receipt) → Inventory updated
Cancellation: SUBMITTED → CANCELLED (no receipts may exist) — receipted POs can no longer cancel, only fully receive or stop receiving.
```

**Models:** `Supplier` (org-scoped; name, phone, email, address, notes), `PurchaseOrder` (`status: DRAFT|SUBMITTED|PARTIALLY_RECEIVED|COMPLETED|CANCELLED`, `supplierId`, `locationId` — destination, `orderNumber` sequential via a counter or reuse of the OrderCounter pattern — **new `PurchaseOrderCounter` or generic counter**, `expectedAt?`), `PurchaseOrderItem` (`variantId`, `quantityExpected`, `quantityReceived` default 0, `unitCost` snapshot), `GoodsReceipt` (`purchaseOrderId`, `receivedAt`, `actorId`), `GoodsReceiptLine` (`poItemId`, `quantityReceived`, `unitCost`).

**Business rules to enforce:**
- Receiving is a transaction: for each line, guarded inventory increment at the PO's destination location + one `StockMovement(ADDED, referenceId: receiptId)` + increment `quantityReceived`; `unitCost` on the variant updated per the costing decision (D-4 — **default: store the last receipt cost, do not compute COGS**).
- Duplicate-receipt prevention: receipt lines must not exceed `quantityExpected − quantityReceived` per line (reject or clamp — recommend reject, D-7); PO status transitions validated server-side (DRAFT → SUBMITTED → …; no receiving on DRAFT/CANCELLED/COMPLETED).
- Supplier deletion policy: restrict hard delete; archive instead (a supplier with POs must remain for history).
- Every step tenant-scoped; movement actor = receiving member.

**Dependencies:** **hard** — P1.1 (variant + cost inputs), inventory mutation pattern (exists), costing decision D-4, supplier-requirements decision D-6. Partially blocks P1.4? No — independent.

**Tests to add:** full happy path (PO → receipt → inventory + movement + status); partial receiving across two receipts; over-receipt rejected; receive on another org's PO → FORBIDDEN; receive on DRAFT/CANCELLED → rejected; cancel with zero receipts ok / with receipts rejected; movement reference integrity; audit rows.

### D.4 P1.4 — Multi-location operations

**Existing:** locations exist (one auto-created "Main Location" per store; no CRUD — see P1.7); `TRANSFER` movement type reserved but **never written**; per-location inventory exists; location authorization enforced.

**Lifecycle to implement:**

```
Location A: create transfer (DRAFT, lines w/ quantities) → DISPATCH (guarded decrement at A + StockMovement(TRANSFER, qty<0, ref: transferId)) → IN_TRANSIT
Location B: RECEIVE (guarded increment at B + StockMovement(TRANSFER, qty>0, ref: transferId)) → COMPLETED
Cancel (only while IN_TRANSIT, before any receipt): guarded re-increment at A + reversal movement → CANCELLED
Partial receipt (optional, D-7): allow partial line receipt; transfer closes when all lines fully received or merchant closes remainder.
```

**Models:** `StockTransfer` (`status: DRAFT|IN_TRANSIT|COMPLETED|CANCELLED`, `fromLocationId`, `toLocationId`, sequential transfer number, `dispatchedAt/receivedAt/cancelledAt`, actor fields), `StockTransferLine` (`variantId`, `quantitySent`, `quantityReceived`).

**Anti-duplication invariants (the core risk):**
- Stock is only ever decremented at dispatch and incremented at receipt/cancel — never both paths for the same quantity. State transitions are one-way and validated in-tx (`UPDATE ... WHERE status = 'IN_TRANSIT'` style guards via conditional updateMany on the transfer row).
- The same guarded-inventory pattern applies; `from ≠ to` and both owned by the org; actor must have location access **at the acting location** (dispatcher needs A access, receiver needs B access — this is the location-authorization test of the workstream).
- No receipt after CANCELLED; no second RECEIVE (status guard); movements reconcile with inventory deltas.

**Dependencies:** P1.7's location CRUD (to have multiple locations at all — dev DB currently has one per store), P1.2's pattern + history UI. **Not** dependent on procurement.

**Tests to add:** dispatch → in-transit → receive (inventory correct at both ends, two movements); cancel-in-transit returns stock; double-receive rejected (second call fails, no double increment); dispatch without A-access → FORBIDDEN; receive without B-access → FORBIDDEN; cross-org location pair → FORBIDDEN; insufficient stock at dispatch → rejected atomically; movement history complete.

### D.5 P1.5 — POS and order lifecycle

**Existing:** client cart (React state) sending only `variantId`+`quantity`; server-priced checkout; customer upsert; CASH/TRANSFER with payment-state representation (`paymentStatus` separate from `status`); ATTENTION resolution; orders list with resolve button.

**Missing:**
1. Variant-aware cart — UI hardcodes `variants[0]`; no variant selection, no SKU/barcode search in POS (depends on P1.1 lightly; can proceed with existing single-variant products).
2. Order detail / receipt **record** — no view of a single order with items, prices, customer, payment; "receipts as records" means an order-detail page + print stylesheet, **not** PDF generation (P2).
3. Cancellation of normal orders — only ATTENTION orders have a resolution path. Need: cancel PENDING (unpaid) orders freely; cancel PAID/FULFILLED only via explicit policy (D-9-adjacent; money-refund flows are P2 — until then, PAID+FULFILLED cancellation is **not offered**, only voiding unpaid orders; this keeps the M1 "no bare refund-status-flip of real money" principle intact because no real money moves yet).
4. Cancellation stock semantics: cancelling an **unfulfilled** order returns nothing (no stock was deducted); cancelling a FULFILLED order would require RETURN movements — out of scope until refunds exist. Documented boundary.
5. Pagination/filters on the orders list (unbounded `findMany` today); per-location views (`locationId` filter using `accessibleLocationIds`).
6. Cash-drawer/change-calculation, discounts — **not P1** (discounts are P3).

**Dependencies:** M1 core (done). P1.1 improves variant selection but is not a blocker. No payment provider (blueprint F.4 stays open; no dependency established).

**Tests to add:** cancel unpaid PENDING order → CANCELLED, stock untouched, movement-free; cancel PAID order → rejected with explicit "refund flows arrive later" error; cancel another org's order → ORDER_NOT_FOUND; STAFF cannot cancel (role guard — extend the resolve-action pattern); order detail is org-scoped; pagination correctness.

### D.6 P1.6 — Customer management

**Existing:** race-safe upsert on `(organizationId, phone)`; read-only list with `_count.orders`.

**Missing:** profile page (details + order history list); edit (name/email; **phone change needs care** — it's the unique key; recommend: phone immutable after creation in P1, documented); search/filter (name/phone/email — add `@@index([organizationId, name])`); create-from-dashboard (the POS creates them implicitly; an explicit "add customer" is trivial); dedup hygiene (M1 constraint prevents new dupes; a one-off dedup check on existing data before migrating any index change — dev DB verified 0 dupes at M1, re-verify); data privacy — customer data is org-scoped by FK; export/erasure flows are P2+ (note only).

**Dependencies:** none hard. Small, independent — a good parallel workstream.

**Tests to add:** edit persists (org-scoped); other-org customer invisible (list + detail + edit); phone-uniqueness conflict returns safe error; order-history only shows that customer's orders within the org.

### D.7 P1.7 — Staff and organization management

**Existing:** invite flow (token), membership with role + location restriction (enforced), single `getSessionContext` resolution — which takes `memberships[0]` arbitrarily (**documented M1 limitation**), no staff list/edit/remove, no invite listing/revocation, no location CRUD, no org switching, no business-profile settings.

**Missing / to plan:**
1. Staff list + roles + locations displayed; **edit** role/allowed locations; **remove** member (guard: cannot remove the last OWNER; removing revokes sessions? — decide: keep sessions but `getSessionContext` must then fail membership resolution — it already returns null with no membership → effectively logged out of that org. Good — document as the mechanism).
2. Invite lifecycle: list pending invites, rescind (add `StaffInvite.revokedAt DateTime?`), re-invite replaces.
3. Location CRUD (needs a second location to exist for P1.4!): create/edit (rename) locations under the org's store. Deleting a location with inventory/orders → **restrict** (archive flag instead — `Location.archivedAt`); never cascade-delete stock history.
4. Multi-org switching: a switcher UI that sets the active org for the session (store selected org id on the Session row — `Session.activeOrganizationId String?` — minimal, revocable, survives the existing expiry model). `getSessionContext` prefers `activeOrganizationId` when the user holds that membership, else `memberships[0]`. This is the smallest correct fix for the documented limitation.
5. Role granularity: keep 3 coarse roles for P1 (D-11 — blueprint I-9 unresolved; a permission matrix is not justified by current evidence). Define the matrix explicitly in code comments + docs: OWNER = everything incl. invites/settings; MANAGER = operations (POS, orders resolve, inventory, customers, transfers) at accessible locations; STAFF = POS + inventory views at accessible locations, no resolution, no customer list, no settings.
6. Registration de-dup: delete the dead `registerOrganization` in core (the dashboard owns the tx) — tiny cleanup.

**Dependencies:** none upstream; **downstream:** location CRUD is a prerequisite for P1.4's multi-location value; org switching is standalone.

**Tests to add:** role/location change enforced immediately (restricted staff loses location access); last-owner removal rejected; invite rescind → token dead; second-org membership + switch → context resolves to chosen org; switch to org the user doesn't belong to → rejected; location create/rename archived-location exclusion; RBAC matrix per role (negative cases per action).

### D.8 Cross-cutting threads

**X-1 — API hardening completion (E-13 remainder).** Add `@fastify/rate-limit` (checkout/cart/products/login-adjacent routes) and a validation layer. Blueprint H names the choice: **Fastify built-in JSON Schema (recommended — zero new deps) or zod.** Rate limits: e.g. checkout 5/min/IP, cart 10/min, products 60/min — configurable via env. Tests: burst → 429; invalid payload → 400 (safe envelope).

**X-2 — Audit coverage (E-17).** Widen `AuditAction` enum (add `ADJUST_INVENTORY, STOCK_COUNT, RECEIVE_GOODS, TRANSFER_STOCK, CANCEL_ORDER, UPDATE_PRODUCT` reuse for edits, `UPDATE_MEMBERSHIP`, `UPDATE_LOCATION`, `REMOVE_MEMBER`). Every P1 state-change writes exactly one event (test per action). Movement `referenceId` typing supports the history UI (P1.2).

**X-3 — Dashboard action validation & error envelopes (E-22 remainder).** All server actions validate types/ranges server-side (numbers parsed and range-checked; ids non-empty) and return uniform `{ success } | { error }` shapes built from `toSafeErrorMessage`. Folded into each workstream rather than a separate milestone.

**X-4 — `costPrice` explicit input (E-21).** Add cost to the product-create/edit forms; stop fabricating. Note: this is *cost capture*, not *costing methodology* (D-4 governs COGS/profit later). Natural home: P1.1.

---

## E. Domain and Workflow Definitions (target state)

### E.1 Inventory mutation contract (applies to every workstream)

```
mutateInventory(tx, { locationId, variantId, delta, type, actorId|null, referenceId }):
  1. guarded updateMany: WHERE location+variant AND (delta<0 → quantity >= |delta|)
  2. count === 0 → DomainError("INSUFFICIENT_STOCK")   // rolls back tx
  3. exactly ONE StockMovement(type, signed delta, actorId, referenceId)
  4. audit event (X-2)
All callers run inside a prisma.$transaction. No flow may write Inventory directly.
```

This single contract is what makes PO receiving, transfers, counts, checkout, and adjustments consistent and auditable. `Inventory.quantity` remains the only authoritative balance; `StockMovement` is append-only history.

### E.2 Procurement flow

```
Supplier ──→ PurchaseOrder(DRAFT) ──submit──→ SUBMITTED ──receive(partial, N receipts)──→ PARTIALLY_RECEIVED ──→ COMPLETED
                                     │                                                        │
                                     └──cancel (0 receipts)──→ CANCELLED                      └── each receipt = tx { per-line guarded increment + movement(ADDED, ref: receiptId) + quantityReceived += }
Over-receipt rejected. unitCost snapshot on PO line; variant cost updated per D-4 default.
```

### E.3 Transfer flow

```
Location A ──dispatch──→ IN_TRANSIT ──receive at B──→ COMPLETED
                │                │
                └── (DRAFT edits) └──cancel──→ CANCELLED (stock returned to A atomically)
Dispatch: decrement A + movement(TRANSFER, −q, ref: transferId). Receive: increment B + movement(TRANSFER, +q, ref: transferId).
State guards make every transition one-way; duplicate receipt impossible by status precondition.
```

### E.4 Order lifecycle (P1 boundary — money flows stay P2)

```
POS: FULFILLED(+) or ATTENTION → resolve{FULFILL|CANCEL}   (exists; M1 semantics retained)
P1 adds: PENDING/UNPAID → CANCELLED (void, no stock was deducted, no movements)
Boundary: PAID/FULFILLED orders cannot be cancelled in P1 (refund = money movement = P2).
paymentStatus and status remain independent axes (PAID+ATTENTION etc. all valid, as today).
```

### E.5 Publication model

```
Draft(PUBLISHED=false) → dashboard-only
PUBLISHED → storefront (slug-resolved) + POS
ARCHIVED (archivedAt set) → excluded from storefront AND POS everywhere; history (orders, movements) fully retained.
```

---

## F. Dependencies and Sequencing

### F.1 Actual dependency graph (from code inspection)

```
P1.1 Catalogue ──────────┬──→ P1.2 Inventory control ──→ P1.3 Procurement
                         ├──→ P1.3 Procurement (variants, cost inputs)
                         ├──→ P1.4 Transfers (variant lines)
                         └──→ P1.5 POS variant picker (soft — not blocking)
P1.7 Staff/Org (location CRUD) ──→ P1.4 Transfers (need >1 location)
P1.2 patterns (mutation contract) ──→ P1.3, P1.4
P1.6 Customers ── independent
P1.5 POS/order lifecycle ── independent (M1 core suffices)
X-1/X-2/X-3 ── orthogonal, folded in
```

### F.2 Proposed sequence (smallest practical order)

| Phase | Content | Why here |
|---|---|---|
| **P1-A** | P1.1 Catalogue + X-3 + X-4 (cost input) | Root of the dependency graph; unblocks 4 workstreams; no schema risk beyond additive tables/columns. |
| **P1-B** | P1.5 POS/order lifecycle completion + X-2 (order-side audit) | Money-facing completion while context is fresh; independent of A. |
| **P1-C** | P1.7 Staff/org (incl. location CRUD, org switch, invite lifecycle) | Needed before multi-location value exists; small. |
| **P1-D** | P1.2 Inventory control (history, thresholds, counts) | Uses P1-A variants + P1-C locations; codifies the mutation contract (E.1). |
| **P1-E** | P1.3 Suppliers/procurement | Consumes contract + catalogue; needs D-4/D-6/D-7 decisions. |
| **P1-F** | P1.4 Transfers | Last: needs P1-C locations + P1-D contract; most state-machine risk. |
| Parallel | P1.6 Customers; X-1 rate limiting/validation | Independent; slot anywhere after P1-A. |

P1.5 and P1.1 could swap if the owner wants the selling loop finished first — but catalogue-then-POS means the POS variant picker is built once, not twice.

### F.3 Workstream detail table

| WS | Prerequisites | Blocking decisions | Schema changes | Extends | New modules | Integration points | Regression risks |
|---|---|---|---|---|---|---|---|
| P1.1 | — | D-2, D-3, D-12, D-13 | Category, Product.categoryId, Product.archivedAt, ProductImage-or-url, cost input | core/products.ts, products pages, API products route | product-form components, variant editor | Storefront API, POS, later WS | SKU uniqueness migration; consumers assuming `variants[0]` |
| P1.2 | P1-A (soft) | D-5 | lowStockThreshold, StockCount(+Line) | core (new inventory.ts), dashboard | history/count UI, reconcile util | All inventory flows | Any direct Inventory writes bypassing contract |
| P1.3 | P1-A, D-4, D-6, D-7 | D-6, D-7 | Supplier, PO(+Item), GoodsReceipt(+Line), PO counter | procurement.ts (new) | PO/receiving UI | Inventory contract, audit | Cost overwrites; partial-state PO bugs |
| P1.4 | P1-C, P1-D patterns | D-7 | StockTransfer(+Line), transfer counter | transfers.ts (new) | transfer UI | Location auth, inventory contract | Double-receive / cancel races; from=to |
| P1.5 | — | D-9 | (optional) order cancel-reason | orders core/actions | order detail page, pagination | Customer links, audit | Resolve-button semantics preserved |
| P1.6 | — | — | (index only) | customers pages | profile/history/search UI | Orders | Phone immutability UX |
| P1.7 | — | D-10, D-11 | StaffInvite.revokedAt, Session.activeOrganizationId, Location.archivedAt | auth-helpers, settings, auth.ts core | staff mgmt UI, org switcher, location CRUD | getSessionContext (critical path!) | Session-context change touches every page — highest blast radius in P1 |

---

## G. Security and Data-Integrity Requirements (all workstreams)

1. **Tenant isolation.** Every new model carries `organizationId` (direct FK or verified via parent chain, mirroring M1's variant→product pattern). Every fetch is `where: { organizationId: context.orgId }`; every mutation re-verifies inside the transaction. Negative tests are mandatory per resource.
2. **Location authorization.** PO destination, transfer endpoints, counts, and inventory views respect `allowedLocationIds`; dispatch/receive check access at the *acting* location.
3. **Financial integrity.** No client-supplied monetary value becomes authoritative — including PO `unitCost` display (server re-resolves/snapshots), receipts, and any future override (D-9 hard-forbid default).
4. **Inventory consistency.** E.1 mutation contract only; every state-machine transition guarded in-tx; one movement per mutation; ledger-reconciliation test in CI.
5. **Database integrity.** Additive migrations only; unique constraints + FK indexes on every new table (`@@index` on organizationId, FK columns, status columns used in filters); `prisma migrate dev` discipline; fresh-DB replay + `migrate status` clean in CI; pre-migration duplicate checks on the dev DB for any new unique index.
6. **Session/auth.** New server actions go through `getSessionContext`; the P1.7 context change (org switching) must pass the entire existing session test suite unmodified first.
7. **Safe errors.** `DomainError` + `toSafeErrorMessage` for every new failure mode; no existence leaks across tenants.
8. **No secrets.** New env vars (rate-limit config, image base URL) go in `.env.example` with placeholders only.

---

## H. Testing and CI Strategy

**Harness (existing, retained):** Vitest 5.1; `tests/global-setup.ts` recreates `via_saas_test` via docker exec and applies migrations (skips recreate in CI against the service DB); `tests/helpers.ts` fixture factories (`createOrganizationFixture`, `createProductFixture` — extend with locationCount/variant/category/receipt factories). Workers are file-parallel; fixtures use unique suffixes.

**Per-workstream test strategy:**
- **Core/domain tests** (majority): exercise `packages/core` functions against the disposable DB — positive paths + the negative authorization matrix (cross-org, cross-location, wrong state, wrong role).
- **API tests (new, X-1/P1.1):** use Fastify's `app.inject()` — no listening socket needed; assert published-only filtering, slug 404, CORS rejection, 400 validation, 429 rate limits.
- **Session-context tests:** extend the `next/headers` mock pattern from `session.test.ts` for org switching and role changes.
- **Invariant tests:** ledger reconciliation (E.1) and state-machine one-way transition guards get dedicated tests run on every push.
- **Migration tests:** each milestone's fresh-DB replay is already CI behavior (`prisma migrate deploy` against the service DB) — new unique indexes get a pre-migration duplicate-check note and a local dev-DB verification before merge.

**CI (unchanged pipeline, extended naturally):** `.github/workflows/via-saas-ci.yml` runs `npm ci` → `prisma generate` → `prisma validate` → all-workspace type-check → `npm test` against a fresh postgres:15. No new jobs required; test count grows. Definition of CI-green: all suites pass on the pushed commit (the M1 standard).

**Coverage expectations:** every new core function has positive + negative tests; every new endpoint has auth-negative tests; no test may depend on execution order or shared mutable state.

---

## I. Open Product and Engineering Decisions (Decision Register)

Legend: **Owner approval required?** — Y = must be answered before the listed milestone; N = plan default applies unless overridden.

| # | Question | Options | Technical consequences | Product/business consequences | Recommended default | Approval | Blocks |
|---|---|---|---|---|---|---|---|
| D-1 | Initial merchant segment | S1 single-location / S2 multi-branch / S3 wholesale | S2 raises location/transfer priority; S3 raises PO/units priority | Roadmap emphasis; blueprint I-1 wants interviews first | Build location-capable from start (already structured so), sell S1 first | N (informational) | sequencing emphasis only |
| D-2 | Variant & SKU rules | SKU unique global vs per-org; auto-generate?; barcode scanning input? | Migration on unique index; per-org composite unique `@@unique([organizationId, sku])` | Bumpa-style merchants expect free-form SKUs | Per-org unique, optional, auto-suggest from name; barcode as plain field | Y (index change) | P1-A |
| D-3 | Product image storage | (a) none in v1, (b) external image URLs only, (c) local filesystem upload, (d) cloud object storage (S3/Cloudinary) | (b,c,d) need `ProductImage`; (c) needs static serving; (d) adds paid/provider dep | Images drive storefront conversion | **(b) URL-only MVP** — no paid provider, no upload infra; upgrade path to (d) later | Y (scope) | P1-A images slice |
| D-4 | Inventory costing method | Weighted average / FIFO / none for MVP | FIFO/Avg need receipt-cost layers + COGS engine | Accounting depth; blueprint I-8 | **None (MVP)** — capture `costPrice` explicitly (E-21 fix), show margin per variant; COGS engine is P2+ | Y (affects P1-E) | P1-E receiving cost updates |
| D-5 | Stock adjustment permissions | Any member / MANAGER+ / OWNER only | RBAC guard in adjust + count actions | Shrinkage control vs staff autonomy | OWNER+MANAGER adjust & approve counts; STAFF view-only | Y (policy) | P1-D |
| D-6 | Supplier requirements | Supplier mandatory on PO / optional | Optional adds nullable FK + UI flow | Some merchants buy from markets, not suppliers | Supplier optional on PO | N | P1-E |
| D-7 | Partial receiving rules | Reject over-receipt / clamp; partial transfers allowed? | Guard math on `quantityReceived`; status derivation | Real deliveries under-deliver | Reject over-receipt; partial receipts allowed; transfers: full-qty MVP (partial receipt = follow-up) | Y | P1-E, P1-F |
| D-8 | Transfer approval | Dispatch requires second-person approval / single-actor | Extra state + permission check | Fraud/theft control for stock moves | Single-actor MVP with full audit trail; approval later | N | P1-F |
| D-9 | POS price overrides | Hard-forbid / permissioned override + audit | Override needs permission + audit + receipt display | Haggling is common in Nigerian retail | **Hard-forbid in P1**; permissioned override with audit is a fast follow once D-5-style permissions exist | Y | P1-B |
| D-10 | Multi-org switching behavior | Auto-pick first / explicit switcher persisted on Session / org-per-login | `Session.activeOrganizationId` + switcher UI | Users with 2 businesses today hit arbitrary-org bug | Explicit switcher persisted on Session (smallest correct fix) | N | P1-C |
| D-11 | Staff role granularity | 3 coarse roles / permission matrix | String roles vs matrix table + checks | Blueprint I-9 wants validation first | 3 roles, matrix documented; revisit on evidence | N | P1-C |
| D-12 | Archival vs deletion | Soft archive / hard delete when unreferenced / both | Soft: `archivedAt`; hard delete only when zero movements/orderItems/PO lines | Accidental-deletion protection; history integrity | Soft archive default; hard delete allowed only for products never referenced (guarded) | Y | P1-A |
| D-13 | Storefront publication behavior | Publish = status only / publish requires images+price+stock | Validation gating on publish | Broken storefront listings | Publish requires name+price+≥1 variant; stock-zero products remain listed with "out of stock" | N | P1-A |
| D-14 | Storefront URL model (blueprint I-10) | Subdomain / path / custom domain | Infra + DNS | Branding | Current slug-path model retained for P1; revisit in P2 | N | none (P2) |

---

## J. Prioritized Implementation Backlog

Ordered execution list; each item is implementation-ready to the level of "which module changes." IDs are P1-scoped.

| # | Item | WS | Depends on | Blocking decision | Scope summary |
|---|---|---|---|---|---|
| P1-01 | Product edit + validation + audit (X-3 shapes) | 1.1 | — | — | core update fn, edit form, before/after audit |
| P1-02 | Variant management (add/edit per product, per-org SKU unique, barcode field surfaced) | 1.1 | — | D-2 | variant editor, migration for SKU index, POS/storefront multi-variant support |
| P1-03 | Categories (model, CRUD, assignment, filter) | 1.1 | — | — | Category model + UI |
| P1-04 | Product archival (soft) + restore + guarded hard-delete | 1.1 | P1-01 | D-12 | archivedAt, exclusion filters everywhere, tests |
| P1-05 | Images via external URLs (conditional on D-3) | 1.1 | P1-02 | D-3 | ProductImage-or-url, storefront display |
| P1-06 | Explicit costPrice input (E-21) | 1.1/X-4 | P1-01 | — | form field + stop fabrication + test |
| P1-07 | Publish gating + draft/ARchived enforcement tests incl. API | 1.1 | P1-02/04 | D-13 | validation + storefront contract tests |
| P1-08 | Order detail/receipt-record page + print stylesheet | 1.5 | — | — | order/[id] page, org-scoped |
| P1-09 | Order cancellation (unpaid void) + role guard + audit | 1.5 | P1-08 | D-9 | core cancelOrder, list UI, tests |
| P1-10 | POS variant-aware cart + SKU search | 1.5 | P1-02 (soft) | — | cart model in UI, picker |
| P1-11 | Orders list pagination + location filter | 1.5 | — | — | take/skip + accessibleLocationIds filter |
| P1-12 | Rate limiting + schema validation on API (X-1) | X | — | — | @fastify/rate-limit + JSON Schema, inject tests |
| P1-13 | Customer profiles, edit (phone immutable), history, search, add-customer | 1.6 | — | — | pages + core fns + index migration |
| P1-14 | Staff list/edit/remove + last-owner guard | 1.7 | — | D-11 | membership admin actions/UI |
| P1-15 | Invite lifecycle (list, rescind via revokedAt) | 1.7 | — | — | model field + UI + token-dead test |
| P1-16 | Location CRUD (create/rename/archive) | 1.7 | — | — | actions/UI + archived-location handling |
| P1-17 | Org switcher (Session.activeOrganizationId + getSessionContext preference) | 1.7 | — | D-10 | context change + full session-suite rerun |
| P1-18 | Audit enum widening + coverage to all actions (X-2) | X | — | — | enum migration + audit calls + per-action tests |
| P1-19 | Inventory mutation contract refactor (E.1 helper in core) | 1.2 | P1-01 | — | shared helper; checkout/adjust refactored onto it; reconcile test |
| P1-20 | Inventory history UI (variant/location, movement typing display) | 1.2 | P1-19 | — | ledger pages + filters |
| P1-21 | Low-stock thresholds + dashboard banner | 1.2 | P1-19 | D-5 | field + read-time evaluation |
| P1-22 | Stock counts (open, enter, approve → corrective movement) | 1.2 | P1-19/20 | D-5 | StockCount models + flow + tests |
| P1-23 | Suppliers CRUD (archive-only delete) | 1.3 | — | D-6 | model + UI |
| P1-24 | Purchase orders (draft/submit, lines, expected qty/cost, counter) | 1.3 | P1-02, P1-23 | D-6 | PO models + flow |
| P1-25 | Goods receiving (partial, guarded, movements, status derivation) | 1.3 | P1-24 | D-4, D-7 | receipt tx + tests |
| P1-26 | Stock transfers (dispatch/in-transit/receive/cancel) | 1.4 | P1-16, P1-19 | D-7, D-8 | transfer models + state machine + tests |
| P1-27 | Transfer/PO counters & numbering consistency check | 1.3/1.4 | P1-24/26 | — | sequential, DB-unique per org |

---

## K. Recommended First P1 Milestone

### **Milestone P1-A — "Merchants own their catalogue" (P1.1 core + X-3/X-4)**

**Contents:** P1-01 edit + validation + audit, P1-02 variants + per-org SKU, P1-03 categories, P1-04 archival, P1-06 explicit cost price, P1-07 publish gating/enforcement, plus the dashboard error-envelope standard applied to every touched action.

**Why first:**
1. **It is the root of the dependency graph.** PO line items (P1.3), transfer lines (P1.4), POS variant selection (P1.5), inventory thresholds (P1.2), and storefront listings all consume the product/variant model. Doing it last would force rework of everything built meanwhile on `variants[0]` assumptions.
2. **Lowest risk profile.** Entirely additive schema (new tables/columns); the only destructive-risk item — the SKU uniqueness migration — is small, verifiable (dev DB pre-check), and decision-gated (D-2).
3. **Directly pays down carried M1 debt** — E-21 (cost fabrication) and the E-22 dashboard-error standard land here naturally.
4. **Demonstrable outcome:** a merchant can create a product with real variants, categories, SKU/barcode, explicit cost, edit it, archive it, and see the storefront reflect exactly the published, non-archived set.
5. **Coherent capability:** "catalogue management" is a complete merchant job-to-be-done, not a fragment.

**Scope boundary:** no image uploads (D-3 gates P1-05 — can join the milestone if the owner answers D-3 with option (b)); no POS changes beyond not breaking on multi-variant products; no storefront UI redesign.

### P1-A acceptance criteria (draft for owner review)

| ID | Criterion |
|---|---|
| AC-A1 | Product name/description/status editable; changes persist and are org-scoped; cross-org edit attempts fail closed |
| AC-A2 | Products support multiple variants; each variant has optional per-org-unique SKU, optional barcode, explicit cost and selling price; POS and storefront no longer assume `variants[0]` |
| AC-A3 | Categories: create/assign/filter; `@@unique([organizationId, name])` |
| AC-A4 | Archive/restore: archived products disappear from storefront API and POS but retain all history; guarded hard delete only for never-referenced products |
| AC-A5 | `costPrice` equals the explicitly entered value (E-21 regression test); fabrication gone |
| AC-A6 | Storefront API returns only PUBLISHED, non-archived products for the slug's org; publish requires name+price+variant (D-13) |
| AC-A7 | Every catalogue mutation writes exactly one audit event with before/after metadata |
| AC-A8 | All new/changed actions validate input server-side and return uniform safe-error shapes |
| AC-A9 | Migration applied to dev DB non-destructively; fresh-DB replay passes; SKU index change preceded by a duplicate check |
| AC-A10 | CI green: new suites for edit/variants/archive/categories/publication/auth-negatives; all 48 M1 tests still pass unmodified |

**Definition of done:** AC-A1…A10 verified with evidence; type-check clean; `npm test` green locally and in remote CI; dev-server smoke test of catalogue flows; report with per-AC status; no push/deploy without owner instruction; **M1's nine security controls (B.5) re-verified unregressed.**

---

## L. Acceptance Criteria and Definition of Done (per workstream, summary)

Full AC tables will be drafted per milestone at implementation-planning sign-off; the binding pattern from M1 applies to all: **statuses limited to PASS / FAIL / BLOCKED / NOT RUN; every criterion needs evidence; no criterion silently skipped; blockers reported.**

| WS | DoD highlights |
|---|---|
| P1.1 | Edit/variants/categories/archive/cost verified by tests incl. negative auth; storefront contract tests; migration replay clean |
| P1.2 | History/thresholds/counts verified; ledger-reconciliation invariant test green; adjustment permissions enforced |
| P1.3 | Full PO lifecycle incl. partial receiving, over-receipt rejection, cross-org denial, receipt idempotency; costing per D-4 |
| P1.4 | Transfer state machine one-way under concurrency tests; double-receive impossible; location auth at both ends; cancel restores stock exactly |
| P1.5 | Order detail/cancel verified; PAID-cancellation correctly refused; pagination correct; no payment-provider code |
| P1.6 | Profile/edit/history/search org-scoped; M1 uniqueness tests untouched and green |
| P1.7 | RBAC matrix tests green per role; last-owner guard; invite rescission; org switcher passes full session suite; location CRUD safe with existing data |
| X-1 | Rate-limit 429 + validation 400 tests; no new credentials |
| X-2 | One-audit-row-per-action tests; enum migration clean |

**Standing constraints for every milestone:** no client-authoritative money; org/location authorization server-side; managed additive migrations; safe errors; disposable-DB testing only; dev DB preserved; CI green before close; **no push, deploy, or production change without explicit owner instruction.**

---

## Appendix — Investigation Evidence Index

- Blueprint: `docs/VIA_PRODUCT_BLUEPRINT_AND_DEVELOPMENT_BACKLOG.md` (C §102–174, D §175–245, E §246–279, F §280–337, G §338–381, H §383–408, I §410–429, K)
- Core domain: `packages/core/src/{orders,products,customers,auth,audit,errors}.ts`
- Data: `packages/database/prisma/schema.prisma` (333 lines, 20 models), `prisma/migrations/{000000000000_baseline,20261115090000_m1_integrity}`
- Dashboard: `apps/merchant-dashboard/app/(dashboard)/**` (page, products, orders, orders/list, customers, analytics, settings), `app/(auth)/**`, `lib/auth-helpers.ts`, `app/api/products/route.ts`
- API: `apps/api/src/server.ts` (3 routes + health; no rate limiting; manual validation only)
- Storefront: `apps/storefront/app/page.tsx` (slug-driven)
- Tests: `tests/*.test.ts` (7 suites, 48 tests) + `helpers.ts`, `global-setup.ts`, `vitest.config.ts`
- CI: parent-repo `.github/workflows/via-saas-ci.yml` (green on `8eec1fc`)
