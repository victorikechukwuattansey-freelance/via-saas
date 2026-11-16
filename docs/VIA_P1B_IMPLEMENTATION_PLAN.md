# VIA SaaS — P1-B Implementation Plan: POS & Order Workflows

**Status:** PLAN ONLY — not approved for implementation, not implemented.
**Revision:** R4 (2026-11-16) — narrow amendment to R3: **(1)** corrected the enum/CHECK migration sequencing — two consecutive additive migrations (A: enum widening + columns + `actorId` relaxation; B: CHECK constraint), with an accurate PostgreSQL 15 transaction explanation and no unverified Prisma transaction convention; **(2)** fixed the Phase B1 list numbering (duplicate "3" removed; "B1.3" remains the central audit-writing enforcement requirement); **(3)** explicit metadata contract — `metadata.source` is a **top-level JSON key**, server-stamped, never a client-controlled claim; **(4)** documented implementation-time migration verification (fresh PG 15.20 replay of A→B, ordering confirmation, `CREATE_ORDER` usability, constraint case-check, Prisma introspection/validation). All other R3/R2 decisions, scope, sequencing, evidence, exclusions, and acceptance criteria (B-AC1..B-AC31) are preserved unchanged.
**Revision history:** R3 (2026-11-16) — narrow amendment to R2: **D-G is APPROVED** with the null-actor safeguard invariant (§16, §6 B1), the central audit-writing path's enforcement requirements (§6 B1.3, §10.2), a documented database-level CHECK constraint feasibility conclusion (§8), and new acceptance criterion **B-AC31** with its test matrix (§12, §13). R2 (2026-11-16) — incorporated the P1-B review findings: cancellation/stock-restoration semantics (D-A), payment-recording semantics (D-B/D-D), checkout idempotency (D-C), resolved the order-location contradiction with verified source evidence (§4.7), audit attribution and atomicity (§6 B1, §10.2), rollback vs durable business effects (§14.2), expanded acceptance criteria (§12), and re-sequenced phases (§5, §6).
**Author:** JARVIS (OpenCode agent), prepared at product owner's request.
**Grounded at commit:** `a0fbd75` ("VIA SaaS: P1-A — Merchants Own Their Catalogue"), branch `main`, clean via-saas tree, in sync with `via-saas` remote (0/0).
**Canonical plan:** `docs/VIA_P1_IMPLEMENTATION_PLAN.md` (committed at `41bf28b`).
**CI baseline:** `via-saas CI` run 43809938334 SUCCESS — 83/83 tests (48 M1 unmodified + 35 P1-A).

---

## 1. Executive summary and objective

P1-B is defined by the canonical plan as **"P1.5 POS/order lifecycle completion + X-2 (order-side audit)"** (canonical line 345), i.e. canonical items **P1-08, P1-09, P1-10, P1-11** plus the order-side portion of **P1-18 (X-2)**, under decision **D-9** (POS price overrides hard-forbidden).

Repository inspection shows the M1 checkout engine is sound and server-authoritative, and P1-A already delivered the variant-aware product tiles for POS and the storefront. What remains broken or missing in the selling loop is **everything after checkout**:

- There is **no order detail/receipt-record page** — a merchant cannot view one order with its items, prices, customer and payment state.
- There is **no cancellation path for normal orders** — only ATTENTION orders can be resolved; every created order is immediately `FULFILLED` (with stock deducted) or `ATTENTION`, so the canonical "cancel PENDING (unpaid) orders freely" assumption is **stale**: no PENDING order is ever created.
- **Manual bank-transfer recording is incomplete** — TRANSFER orders are created `FULFILLED`+`UNPAID` and there is **no mark-as-paid path anywhere**; `paymentMethod` is not persisted at all (no `Payment` model, no `paymentMethod`/`amountPaid` column).
- **Audit coverage on the order side is two-thirds missing** — no audit on checkout, and the ATTENTION CANCEL branch writes no audit event (only the FULFILL branch logs `RESOLVE_ORDER`). Additionally, the existing audit write is **not transaction-bound** (§4.8): audit creation and state mutation can commit/roll back independently.
- **Idempotency is client-side only** — a double-click guard; a retried submission creates a second order.
- The orders list is **unbounded and unfiltered** (no pagination, no location filter, no detail link).
- POS lacks SKU/barcode lookup.

**Correction from R1 (order-location):** R1 stated that `createOrder` "has no location dimension." That was imprecise. Verified inspection (§4.7) shows `Order.locationId` exists, is **NOT NULL**, is **server-derived** (never client-supplied), and is org-validated fail-closed at creation. Location-based filtering and authorization for P1-B are therefore **supported by the existing model and unblocked**; the genuine limitations (no POS location picker; multi-location API resolution order) are usability notes, not security gaps, and do not expand P1-B scope.

This plan proposes the smallest order-lifecycle completion consistent with the canonical plan and with the "no money moves yet" principle. Everything proposed is additive; the M1 regression guarantee (48 tests unmodified) and the 83-test green baseline are hard gates.

**Planning-only status:** this document was produced and revised without touching source, schema, migrations, configuration, tests, or dependencies. No database was seeded, migrated, or reset. No commit, push, deploy, or payment operation occurred.

---

## 2. Original P1-B scope from the canonical plan

Quoted/condensed from `docs/VIA_P1_IMPLEMENTATION_PLAN.md` (preserved verbatim from R1):

| Reference | Canonical text (condensed) |
|---|---|
| Line 115 | *P1.5 — POS & order lifecycle: "Finish the selling loop: full cart/variant selection, order detail/receipt record, cancellation rules, history with filters/pagination."* |
| Line 345 | *P1-B = "P1.5 POS/order lifecycle completion + X-2 (order-side audit). Money-facing completion while context is fresh; independent of A."* |
| Line 362 | P1.5 dependency row: D-9 binding; optional order cancel-reason; deliverables "order detail page, pagination"; "Resolve-button semantics preserved". |
| Line 412 (D-9) | POS price overrides: **hard-forbid in P1**; permissioned override with audit is a fast follow once permission systems exist. |
| Line 434–438 (items) | **P1-08** Order detail/receipt-record page + print stylesheet (order/[id] page, org-scoped). **P1-09** Order cancellation (unpaid void) + role guard + audit (depends P1-08; D-9). **P1-10** POS variant-aware cart + SKU search (P1-02 soft dep). **P1-11** Orders list pagination + location filter. |
| Line 444 (P1-18) | Audit enum widening + coverage to all actions (X-2). |
| Line 263 (X-2 def) | Widen `AuditAction` enum (adds include `CANCEL_ORDER`, `ADJUST_INVENTORY`, `STOCK_COUNT`, `RECEIVE_GOODS`, `TRANSFER_STOCK`, `UPDATE_MEMBERSHIP`, `UPDATE_LOCATION`, `REMOVE_MEMBER`). Every P1 state-change writes exactly one event (test per action). |
| Lines 217–232 (D.5) | Detailed gap analysis (see §3 for what is stale). |
| Lines ~296–318 (E.4) | Order lifecycle boundary: PENDING/UNPAID → CANCELLED is a **void** (no stock deducted, no movements); PAID/FULFILLED cancellation **not offered in P1**; `status` and `paymentStatus` remain independent axes. |
| Line 501 (DoD) | Canonical definition of done. |

**Explicitly out of P1-B per canonical plan:** discounts (P3), cash-drawer/change calculation, payment provider integration (blueprint F.4), bank-transfer verification (payment-provider domain), PDF receipts (P2 — "receipts as records" = detail page + print stylesheet only), money-refund flows (P2).

---

## 3. Reconciled scope after P1-A (and after the R2 review)

### 3.1 What P1-A already satisfied

| Canonical item | Status after P1-A | Evidence |
|---|---|---|
| P1-02 (variants, per-org SKU/barcode) | **DONE** | `packages/core/src/products.ts` (addVariant/updateVariant), composite uniques in schema, catalogue tests |
| P1-10 first half (variant-aware cart tiles) | **DONE** | POS grid renders per-variant tiles (`orders/page.tsx`); `variants[0]` assumption removed; POS feed filtered PUBLISHED+non-archived (`app/api/products/route.ts`) |
| D-9 (hard-forbid price overrides) | **DONE + TESTED** | Action payload carries only `variantId`+`quantity`; core ignores client price fields — `tests/checkout-pricing.test.ts:31` |

### 3.2 Stale canonical assumptions

1. **"Cancel PENDING (unpaid) orders freely" (D.5 item 3, E.4) is stale.** Grep across `packages/core/src`, dashboard actions and API: **no code path ever creates a PENDING order.** `processCheckout` creates every order directly as `FULFILLED` (stock deducted, `orders.ts:143-151`) or `ATTENTION` (no deduction, `orders.ts:182-194`). The `PENDING` enum value exists but is dead. → P1-09's void target is redefined as specified in **D-A (§16)**.
2. **"CASH/TRANSFER with payment-state representation" understates the gap.** TRANSFER orders are created `FULFILLED`+`UNPAID` **with stock already deducted and goods conceptually handed over** — with no mark-as-paid path, these are permanently stuck UNPAID and cannot even be cancelled. This is the actual "manual bank-transfer recording" gap, resolved by **D-B/D-D (§16)**.
3. **P1-18 "coverage to all actions" cannot fit wholly in P1-B.** The catalogue audit events were already delivered in P1-A (reusing `UPDATE_PRODUCT` + `metadata.action`); procurement/inventory events (`ADJUST_INVENTORY`, `RECEIVE_GOODS`, `TRANSFER_STOCK`, …) belong to P1.2/P1.3/P1.4 milestones. P1-B delivers the **order-side subset only**: enum widening + `CREATE_ORDER` on checkout + `CANCEL_ORDER` on cancellation + `PAYMENT_RECORDED` (if D-B), exactly as canonical line 345 scopes it ("X-2 (order-side audit)").
4. **D.5 item 4 (cancellation stock semantics)** — cancelling an unfulfilled order returns nothing; cancelling a FULFILLED order requires a stock-restore movement. With PENDING dead, the realistic case is the FULFILLED+UNPAID TRANSFER void, which needs `RETURN` movements (type already exists in the enum — no schema change needed for the movement itself).

### 3.3 Reconciled P1-B scope

In scope (all traceable to canonical items, semantics now fixed by the R2 review):

- **P1-08** — Order detail/receipt-record page + print stylesheet (org-scoped, fail-closed).
- **P1-09 (reconciled)** — Order cancellation of **`FULFILLED + UNPAID` orders only**, void semantics: `status → CANCELLED`, payment remains `UNPAID`, stock restored via `RETURN` StockMovement records matched to the original `SALE` movements (variant, location, quantity), one transaction, concurrency-safe (full spec: **D-A**, §16). **Paid orders cannot be cancelled through this workflow.**
- **P1-10 remainder** — SKU/barcode search in POS. (Cart is already variant-aware; only search is missing.)
- **P1-11** — Orders list pagination + location filter. **Grounded in the verified location model (§4.7) — unblocked.**
- **P1-18 order-side subset (X-2)** — `AuditAction` enum widening + audit on checkout + audit on ATTENTION-CANCEL + audit on payment recording, with the attribution and transactional-atomicity rules of §10.2; per-action exactly-once tests.
- **D-9 enforcement retained** — server pricing already hard-forbids overrides; regression-tested; nothing new required beyond preserving tests.
- **D-B/D-D (approved direction, semantics fixed):** **"Record payment received"** for `TRANSFER + UNPAID + FULFILLED` orders (merchant confirmation, not verification) + nullable `paymentMethod` persistence.

Out of scope (unchanged from canonical, or evidence shows no requirement): discounts, payment providers, bank-transfer verification, PDF receipts, cart persistence (decision D-E), partial payments (no requirement found — §18), refunds-as-money, ledger redesign (P1-19 remains in P1.2), rate limiting (P1-12/X-1 is a separate X item), customer profile pages (P1-13), inventory history UI (P1-20), broader location management (§3.4, §4.7).

### 3.4 Area classification

| Area | Classification | Basis |
|---|---|---|
| POS cart & variant selection | **PARTIALLY IMPLEMENTED** | Per-variant tiles done (P1-A); SKU/barcode search missing (`orders/page.tsx` has no search path) |
| Server-authoritative price & totals | **EXISTING AND VERIFIED** | `checkout-pricing.test.ts` (8 tests incl. client-price-field ignore, cross-tenant rejection) |
| Atomic order + line-item creation | **EXISTING AND VERIFIED** | Single `prisma.$transaction` in `processCheckout` (order + items + movements); tests cover merge/deduct-once |
| Historical line-item snapshots | **EXISTING BUT UNVERIFIED** | `OrderItem.unitPrice` snapshot exists; price immutability after catalogue edits not regression-tested; display joins resolve live variant/product names (see §11, I-4) |
| Order/payment/fulfillment state separation | **EXISTING AND VERIFIED (structure)** | `status` × `paymentStatus` independent axes; but semantic oddity: CASH+ATTENTION orders are marked PAID before fulfillment (`orders.ts:194`) — M1-frozen behavior, documented in §11/§16 (D-E) |
| Cash recording | **EXISTING AND VERIFIED** | CASH → PAID at creation; tested |
| Manual bank-transfer recording | **PARTIALLY IMPLEMENTED** | TRANSFER → FULFILLED+UNPAID; **no mark-as-paid path, `paymentMethod` never persisted** |
| Partial payments | **OUT OF SCOPE** | No requirement in canonical plan or blueprint; no schema support; no evidence of need |
| Cancellation rules | **PARTIALLY IMPLEMENTED** | ATTENTION CANCEL only; no normal-order cancellation; canonical PENDING assumption stale; semantics fixed by D-A |
| Refund status representation | **EXISTING (minimal)** | `REFUNDED` paymentStatus exists and is set on PAID ATTENTION CANCEL (`orders.ts:255`); no refund-request workflow (P2) |
| Fulfillment transitions | **PARTIALLY IMPLEMENTED** | ATTENTION→FULFILLED resolution exists; `FULFILLED` is otherwise set only at creation; no other transition machinery needed in P1 |
| Receipt generation (as records) | **MISSING** | No order detail page anywhere |
| Order history | **PARTIALLY IMPLEMENTED** | List exists but unbounded, no pagination, no location filter, no detail link (`orders/list/page.tsx:12-20`) |
| Idempotency / duplicate protection | **MISSING** | Client `isProcessing` flag only; no server idempotency key |
| Tenant authorization | **EXISTING AND VERIFIED** | Org-scoped queries everywhere; cross-tenant cart rejection tested; NOT_FOUND fail-closed pattern (P1-A) |
| Location authorization (E-11) | **EXISTING AND VERIFIED (resolve path) / SUPPORTED-BY-MODEL (create + list paths)** | `resolveOrder` enforces org + location; `Order.locationId` is NOT NULL, server-derived, org-validated (§4.7) — list filtering is safe; no POS location picker is a usability limitation, not a gap |
| Audit coverage (order side) | **PARTIALLY IMPLEMENTED + ATOMICITY DEFECT** | `RESOLVE_ORDER` on FULFILL only; none on checkout, none on CANCEL branch; existing audit write is not transaction-bound and `AuditLog.actorId` cannot represent system origin (§4.8) |
| Migration & regression practice | **EXISTING AND VERIFIED** | P1-A pattern: hand-crafted additive migration, fresh-DB replay, 83-test gate, remote CI |

---

## 4. Current implementation baseline (file paths and evidence)

All paths relative to `via-saas/`. Every fact below was read from the working tree at `a0fbd75`.

### 4.1 Checkout engine — `packages/core/src/orders.ts`

- `processCheckout(organizationId, locationId, userId, items, paymentMethod, customerId)` — `paymentMethod: "CASH" | "TRANSFER"`, validated at `orders.ts:103`.
- `locationId` is a **required parameter**, validated fail-closed: `prisma.location.findFirst({ where: { id: locationId, store: { organizationId: orgId } } })` → throws `FORBIDDEN` "Invalid checkout location." (`orders.ts:107-113`).
- Server-priced via `resolvePricedItems` (PUBLISHED + non-archived check; rejects cross-org, DRAFT, archived items).
- Success branch `orders.ts:143-179`: one transaction creates Order (`status: "FULFILLED"`, `paymentStatus: CASH→"PAID", TRANSFER→"UNPAID"` at lines 150-151), OrderItems with `unitPrice` snapshot, and `StockMovement` rows `type: "SALE"` at the order's location (`orders.ts:169-172`) with `actorId: null` for system origin (E-3).
- Insufficient stock → ATTENTION branch `orders.ts:182-205`: Order created `status: "ATTENTION"` **without** deduction; **CASH ATTENTION orders are still marked PAID** (`orders.ts:194`).
- `resolveAttentionOrder(organizationId, actorId, orderId, action)` — `orders.ts:221-300`:
  - FULFILL: deducts stock inside transaction via location-scoped `inventory.updateMany` with `quantity: { decrement }` (`orders.ts:261-269`), writes `SALE` movements at `order.locationId` with the **real resolving actor** (`orders.ts:280-285`), sets `status: "FULFILLED"` (`orders.ts:296`), logs `RESOLVE_ORDER` audit (`orders.ts:292`).
  - CANCEL: flips `status → "CANCELLED"`, `paymentStatus: PAID → "REFUNDED"` (`orders.ts:250-255`), **touches no stock, writes no audit event**.
- `allocateOrderNumber` — per-org `OrderCounter`, `ORD-1001`+ (E-14/E-15), DB-enforced `@@unique([organizationId, orderNumber])`.

### 4.2 Schema — `packages/database/prisma/schema.prisma`

- `Order.locationId String` — **NOT NULL**, FK to `Location` (relation `location`).
- `OrderStatus { PENDING, ATTENTION, FULFILLED, CANCELLED }` — PENDING dead.
- `PaymentStatus { UNPAID, PAID, REFUNDED }`; `Order.paymentStatus @default(UNPAID)`.
- `Order.paymentMethod` **does not exist**; no `Payment` model; no `amountPaid`.
- `OrderItem` carries the `unitPrice` snapshot.
- `Inventory` — `@@unique([locationId, variantId])`; stock is **tracked per location**, and checkout deducts via location-scoped `updateMany` (`orders.ts:126-132`). RETURN restoration therefore must target the exact original location.
- `StockMovement` — `StockMovementType { SALE, TRANSFER, ADDED, REMOVED, RETURN }`; `actorId String?` (nullable — system-origin convention, E-3); `referenceId` (order id when `SALE`).
- `AuditLog` — `actorId String` **NOT NULL with FK to User** (cannot represent a system-origin event); append-only (no UPDATE/DELETE functions — `packages/core/src/audit.ts`).
- `AuditAction { CREATE_PRODUCT, UPDATE_PRODUCT, INVITE_STAFF, RESOLVE_ORDER, UPDATE_SETTINGS }`.

### 4.3 Dashboard — `apps/merchant-dashboard/app/(dashboard)/orders/`

- `actions.ts` — `createOrder(payload)`: session-scoped org; payload = `{ items[{variantId, quantity}], paymentMethod, customerName, customerPhone }`; **the location is NOT client input** — the action passes `context.locationId` (`actions.ts:36`), which is server-derived (see §4.7); no role guard (any member may sell — consistent with M1); **no idempotency key**; errors via `toSafeErrorMessage`; `revalidatePath` on success. *(R1 correction: R1 said "no location parameter" — there is no client-facing location parameter, but the action does supply a server-derived one.)*
- `resolve/actions.ts` — `resolveOrder(orderId, action)`: STAFF blocked; org-scoped `findFirst` then `canAccessLocation` (E-11) with a no-leak error message; core re-verifies.
- `page.tsx` — POS: client React-state cart, `isProcessing` double-submit guard, per-variant tiles (P1-A), no SKU/barcode search.
- `list/page.tsx` — unbounded `prisma.order.findMany({ where: { organizationId } })` with full item/variant/product include; no pagination, no location filter, no detail link; `ResolveButton` for ATTENTION orders; payment status badge.
- `app/api/products/route.ts` — POS product feed (PUBLISHED + non-archived; org-scoped by session).
- `lib/auth-helpers.ts` — `getSessionContext`, `canAccessLocation`, `canAdjustStock`, `canManageCatalogue`.

### 4.4 Public API & storefront

- `apps/api/src/app.ts` — public checkout: slug-resolved tenant (`resolveStoreBySlug`), JSON validation, `safeErrorReply` envelopes; `buildApp()` inject-tested.
- The API passes `resolved.location.id` (`app.ts:126`) and **`null` as the actor userId** (`app.ts:126-130`, comment: "actorId is null: system-originated movements have no fake user id").
- `apps/storefront/app/page.tsx` — storefront checkout, TRANSFER only (calls the public API).

### 4.5 Read-model oddities (observed, low priority)

- `(dashboard)/page.tsx:31-36` — dashboard "Pending Orders" widget counts `status: "PENDING"` → always 0 (dead widget).
- `(dashboard)/analytics/page.tsx:26-27` — "Pending (Unpaid) Orders" counts `paymentStatus: "UNPAID"` → counts every TRANSFER order forever until paid; revenue aggregates are PAID-only (correct direction).

### 4.6 Test baseline — `tests/` (10 suites / 83 tests, all green; remote CI verified)

- `checkout-pricing.test.ts` (8): server pricing; client price fields ignored; cross-tenant cart rejected; empty/invalid quantities; duplicate variants merged and deducted once; unsupported payment methods; null-actor movements; ATTENTION fallback.
- `attention-orders.test.ts` (4): ATTENTION created without deduction; FULFILL deducts with real actor; FULFILL fails safely; CANCEL flips CANCELLED/REFUNDED without stock touch.
- `order-numbers.test.ts` (4): sequential from ORD-1001; unique under parallel load; per-org counters; DB constraint.
- Plus catalogue (22), api-storefront (8), stock-permissions (5), and the 48 frozen M1 tests.

### 4.7 Order-location model — BLOCKING QUESTION RESOLVED WITH SOURCE EVIDENCE

R1's report that `createOrder` "has no location dimension" contradicted its own proposal of location-based filtering. Verified inspection resolves the contradiction:

| Question | Answer | Evidence |
|---|---|---|
| 1. Does `Order.locationId` exist? | **Yes.** | `schema.prisma` — `Order.locationId String`, FK relation `location` |
| 2. Is it nullable? | **No** — NOT NULL. | Same |
| 3. Where/how is it assigned? | Passed as a **required parameter** to `processCheckout(orgId, locationId, userId, items, paymentMethod, customerId)`; used for the Order row (`:147`), SALE movements (`:169`), and ATTENTION branch (`:190`). Validated **fail-closed**: location must belong to the org (`location.findFirst({ id, store: { organizationId } })`), else `FORBIDDEN` — `orders.ts:107-113`. | `orders.ts:97, 107-113, 128, 147, 169, 190` |
| 4. Do all creation paths populate it consistently? | **Yes — both paths are server-derived, never client-supplied:** Dashboard: `createOrder` passes `context.locationId` (`orders/actions.ts:36`) = `accessibleLocations[0].id`, resolved server-side from `Membership.allowedLocationIds` (empty list ⇒ all org locations allowed) — `auth-helpers.ts:47-57`; a membership with zero accessible locations yields **no session context at all** (`auth-helpers.ts:52`). Public API: passes `resolved.location.id` (`app.ts:126`) = the store's first location via `locations: { take: 1 }` on the slug-resolved store — `app.ts:51-55`. The storefront app only calls the public API. No other order-creation paths exist. | `actions.ts:36`; `auth-helpers.ts:44-64`; `app.ts:51-55, 124-126` |
| 5. Is the location trustworthy for authorization? | **Yes.** It belongs to the org (enforced at creation, fail-closed), is derived server-side from membership authorization, and cannot be spoofed by client input. **Limitations (usability, not security):** (a) the dashboard uses the *first* accessible location — a member authorized for several locations has no picker and always sells at one fixed location (P1-B does **not** add a picker — that is location-management scope); (b) the API resolves `locations: { take: 1 }` **without an explicit `orderBy`** — for multi-location stores the chosen location is row-order dependent (single-location stores are unaffected); documented as a limitation, not fixed here. | `auth-helpers.ts:47-57`; `app.ts:51-55` |
| 6. Do stock movements use the same location? | **Yes.** SALE movements carry `order.locationId` (`orders.ts:169, 265, 282`), and stock itself is per-location (`Inventory @@unique([locationId, variantId])`, location-scoped decrement `orders.ts:126-132`). Consequently D-A's RETURN movements **must** target the original order's location — restoring at any other location would corrupt the ledger. | `orders.ts:126-132, 169, 265, 282`; `schema.prisma` Inventory model |

**Conclusion:** the existing model **can** support safe location filtering and authorization (B7 is unblocked). No default location is invented, no client input is trusted, no staff access is broadened. P1-B does not expand into location management (no picker, no location CRUD — that is P1-16). The only genuinely unresolved location-adjacent item is cosmetic (API multi-location row-order), recorded in §18 assumptions.

### 4.8 Audit infrastructure facts (new in R2 — drives §6 B1 and §10.2)

1. `logAuditEvent(orgId, actorId, action, targetId, metadata)` (`packages/core/src/audit.ts`) uses the **global `prisma` client, not a transaction client** — even when called "inside" `resolveAttentionOrder`'s transaction (`orders.ts:292`), the audit write runs on a separate connection and can commit or roll back independently of the state mutation.
2. `AuditLog.actorId` is **NOT NULL with FK to User** — the audit model has **no system-origin representation** (unlike `StockMovement.actorId String?`, which does — E-3).
3. Therefore: (a) audit-on-public-checkout requires an additive schema change, **approved as D-G** (§8, §16): relax `AuditLog.actorId` to nullable **only** so system-origin checkout events can be recorded, subject to the null-actor safeguard invariant; (b) all P1-B audit writes must be made **transaction-bound** to satisfy commit-or-rollback-together (§10.2), and the pre-existing non-transactional `RESOLVE_ORDER` write should be folded onto the same mechanism; (c) the null-actor exception is enforced by the central audit-writing helper (§6 B1.3) and, as defense-in-depth, by an additive database CHECK constraint (§8).

---

## 5. Dependency graph (R2 — re-sequenced)

```
P1-B (P1.5 + X-2 order-side)
├─ depends on: M1 core (done), P1-A catalogue/variants (done)
├─ soft dep satisfied: P1-10 ← P1-02 (variants, done in P1-A)
├─ internal order (dependency-aware; no artificial forcing):
│    B1 Audit widening + transactional audit mechanism ← enables audit for B4/B5
│    B2 Order detail page (P1-08) ← canonical dependency of P1-09
│    B3 Checkout idempotency (D-C) ← BEFORE the new state-changing order actions,
│         so all newly exposed actions land on an idempotency-hardened baseline;
│         independent in content, ordered for safety-first exposure
│    B4 Cancellation (P1-09, D-A) ← needs B1 (CANCEL_ORDER), B2 (UI)
│    B5 Record payment received (D-B/D-D) ← needs B1 (PAYMENT_RECORDED), B2 (UI)
│    B6 POS SKU/barcode search (P1-10) ← independent; may proceed in parallel with B4/B5
│    B7 List pagination + location filter (P1-11) ← independent; UNBLOCKED (§4.7)
├─ NOT dependent on: P1.2 inventory ledger (P1-19/20/21/22), P1.3 procurement,
│   P1.4 transfers, P1.6 customers (P1-13), P1.7 staff (P1-14..17), P1-12 rate limiting
└─ does NOT absorb: P1-C (P1.2 inventory workstream) or P1-D (procurement)
```

Idempotency (B3) is sequenced **before** the newly exposed state-changing actions (B4 cancellation, B5 payment recording) per the review's sequencing requirement; B6/B7 proceed independently and may be built in parallel — no artificial gate.

---

## 6. Proposed implementation phases (dependency order)

> **Gate: D-G is APPROVED (R3, §16) with the null-actor safeguard — no further decision is required before Phase B1. D-A/D-B/D-C/D-D semantics are fixed below and need only owner sign-off at implementation kickoff.**

### Phase B1 — Audit enum widening + transactional order-side audit coverage (P1-18 subset, X-2)

1. **Additive migrations (two consecutive — see §8):** Migration A widens `AuditAction` with `CREATE_ORDER`, `CANCEL_ORDER`, `PAYMENT_RECORDED` (existing five values untouched), adds the required columns, and relaxes `AuditLog.actorId` to nullable — **without using the newly added enum values inside Migration A**. Migration B adds the CHECK constraint and must run only after Migration A has completed successfully and the new enum value is committed. Final names follow the canonical X-2 convention already listed.
2. **Attribution rules (E) — per approved D-G invariant:**
   - Dashboard checkout → actor = the authenticated merchant user (`context.userId`); **`actorId` must be non-null**.
   - Public storefront/API checkout → **system-origin convention**: no merchant actor is invented. `AuditLog.actorId` may be null **only** for this event class: the event must be `CREATE_ORDER` and the metadata `source` must be `STOREFRONT_API` — a **top-level JSON key** in the metadata object — assigned by the server-side public checkout path (`app.ts` — the same path that already passes `null` as the actor userId, `app.ts:126-130`). Mirrors the existing E-3 null-actor convention on `StockMovement`. Alternative rejected: a synthetic "system" User row would invent a fake actor.
   - Order cancellation, payment recording, and ATTENTION fulfillment/resolution → the authenticated actor performing the action; **`actorId` must be non-null** in all three cases.
   - **No synthetic system user exists or will be created.**
3. **Central audit-writing path enforces the invariant (mandatory enforcement boundary):** the extended `logAuditEvent` (transaction-client parameter per item 3 of §4.8) must:
   - **Reject a null `actorId` for every event except the explicitly permitted public checkout event** (`CREATE_ORDER` + server-authored `metadata.source = "STOREFRONT_API"`).
   - For a null `actorId`, require **both** `action = CREATE_ORDER` **and** `metadata.source = "STOREFRONT_API"` (read at the **top level** of the metadata object — the metadata contract, §8); anything else is rejected.
   - Treat `source` as a **server-assigned value**: the public checkout path stamps the top-level `source` key inside `app.ts`; it is **never accepted as a caller- or client-controlled authorization claim** (dashboard actions cannot pass `STOREFRONT_API` to obtain null-actor attribution — such attempts are rejected).
   - **Reject `STOREFRONT_API` attribution from dashboard or any merchant-authenticated action.**
   - Preserve authenticated-actor attribution for all merchant actions.
   - Keep audit creation **atomic** with its corresponding business mutation (transaction-bound; unchanged from R2).
   - **Defense-in-depth:** an additive database CHECK constraint expresses the same structural invariant (§8, Migration B); it is the backstop, not the primary boundary — see the authorship limitation documented there.
4. **Transactional atomicity (E):** extend `logAuditEvent` to accept an optional transaction client (`tx`); all P1-B audit writes execute **inside the same transaction as their state mutation** — they commit together or roll back together. No orphan audit record can survive a rolled-back mutation; no successful mutation can remain unaudited. The pre-existing `RESOLVE_ORDER` write is folded onto the transactional mechanism (behavior preserved, atomicity improved).
5. `processCheckout`: write exactly one `CREATE_ORDER` audit event in the success branch and in the ATTENTION branch (an order row was created in both). Metadata includes **`source` (a top-level JSON key: `DASHBOARD` / `STOREFRONT_API`, stamped server-side — never a client-controlled claim)**, order number, payment method, item count, and total where available.
6. `resolveAttentionOrder` CANCEL branch: write exactly one `CANCEL_ORDER` audit event (same transaction).
7. Cancel-reason (canonical line 362, optional): carried in the `CANCEL_ORDER` audit **metadata** — no new column.
8. Per-action exactly-once tests, including the failure-path test: a forced audit failure rolls back the mutation (no unaudited state change; no orphan audit row). Plus the **B-AC31 attribution-invariant matrix** (§12, §13): null-actor acceptance/rejection per event class, spoofing rejection, and atomicity.
9. Verification point: run the full suite immediately — confirm no frozen M1 test asserts audit *absence* on these paths (none observed during plan inspection; verify empirically).

### Phase B2 — Order detail / receipt-record page (P1-08)

1. New org-scoped server component page `orders/[orderId]/` under the dashboard route group (exact final path confirmed at implementation; canonical scope summary says "order/[id] page, org-scoped").
2. `findFirst({ where: { id, organizationId: context.orgId } })` — cross-org and nonexistent ids fail closed with the NOT_FOUND pattern (no existence leak).
3. Renders: order number, status + payment status, items with **snapshot** unit prices and quantities, resolved totals, customer (name/phone), location, order date; stock movements for the order (`referenceId` = order id, `type: "SALE"`/`"RETURN"`).
4. Print stylesheet (receipt-record, not PDF — canonical D.5 item 2).
5. Link from orders list rows and from POS success state.

### Phase B3 — Checkout idempotency (D-C) — *before the newly exposed actions*

1. **Schema (D-C approved):** additive columns `Order.idempotencyKey String?` + `Order.requestFingerprint String?`, with `@@unique([organizationId, idempotencyKey])` — **organization-scoped key uniqueness**.
2. **Stable request fingerprint:** a canonical hash over the *meaningful order input* — sorted `(variantId, quantity)` item list, `paymentMethod`, resolved `customerId`, checkout `locationId`. Client-side cosmetics (key casing, item submission order) do not affect it. The fingerprint is computed server-side and persisted with the key.
3. **Semantics:**
   - Same key + same fingerprint → **return the original order** (replay), never a duplicate.
   - Same key + different fingerprint → **conflict** (DomainError `CONFLICT`-class safe error); no new order.
   - Concurrent requests with the same key → the DB unique constraint is the backstop; exactly one order is created; the loser receives the original order (same fingerprint) or a conflict (different fingerprint) — never a duplicate.
4. **Failed checkout must not leave an unusable reserved key:** the key, fingerprint and order are written **in the same transaction**; a failed checkout rolls back all three — the key remains free for a corrected retry.
5. **Key retention and scope:** org-scoped; the key is retained on the order row for the order's lifetime (no TTL, no cleanup job — consistent with I-7's "preserve orders"; uniqueness is per org so keys are never reused across merchants).
6. **POS must always supply an idempotency key** (client generates a UUID per submission attempt).
7. **Public API distinction (explicit):** the public API continues to accept requests **without** a key (M1 contract unchanged, M1 tests frozen). Idempotency guarantees apply **only to keyed requests**. **No universal checkout idempotency is claimed**: unkeyed public-API requests retain today's retry behavior.
8. Tests: same-key replay; same-key mismatched payload conflict; concurrency (same key, parallel); failed checkout frees the key.

### Phase B4 — Order cancellation (P1-09, D-A semantics fixed)

1. Core `cancelOrder(organizationId, actorId, orderId, { reason? })` in `packages/core/src/orders.ts` (new function; existing structure untouched).
2. **Eligibility: only `FULFILLED + UNPAID` orders.** `CANCELLED`, `PAID`, and `REFUNDED` orders are rejected. (ATTENTION orders keep their existing dedicated resolution path — resolve-button semantics preserved.)
3. **Effect:** `status → CANCELLED`; `paymentStatus` **remains `UNPAID`** (nothing was paid; nothing to refund). One `StockMovement` per line: `type: "RETURN"`, positive quantity equal to the line quantity, `variantId` matching the original line, **`locationId` = the original order's location** (§4.7.6 — the location where stock was actually deducted), `actorId` = the cancelling actor, `referenceId` = order id.
4. **No direct stock edits:** restoration is expressed exclusively as RETURN movement records plus the location-scoped inventory increment in the same transaction — mirroring how SALE deduction already pairs `inventory.updateMany` with `StockMovement` rows (`orders.ts:126-132, 167-172`). Stock quantities are never edited without a corresponding movement record.
5. **One transaction; concurrency-safe:** the conditional state transition and stock restoration occur in a single `prisma.$transaction`. **A status pre-check outside the transaction is insufficient** (explicitly prohibited as the sole guard): the transition itself must be conditional inside the transaction — e.g. `updateMany({ where: { id, organizationId, status: "FULFILLED", paymentStatus: "UNPAID" }, data: { status: "CANCELLED" } })` and abort if `count === 0` — so that only one concurrent request can successfully transition the order from `FULFILLED + UNPAID`. Concurrent attempts must not restore stock twice: a loser's transaction observes `count === 0` and aborts before writing any RETURN movement.
6. Wrapper mirroring `resolveOrder`: STAFF-blocked RBAC, org-scoped lookup, `canAccessLocation` (E-11), no-leak errors, uniform `{success}|{error}` shape.
7. List + detail UI: void button with confirmation; ATTENTION resolve buttons untouched ("Resolve-button semantics preserved" — canonical line 362).
8. Exactly-once `CANCEL_ORDER` audit (transaction-bound per B1).
9. Tests: void restores stock exactly once per line **at the original location, matching the original SALE's variant/location/quantity**; PAID/CANCELLED/REFUNDED attempts rejected; STAFF blocked; cross-org fail-closed; **concurrent cancellation — parallel requests produce exactly one successful transition and exactly one set of RETURN movements**.

### Phase B5 — Record payment received (D-B/D-D semantics fixed)

1. **UI wording: "Record payment received."**
2. **Meaning:** records a merchant user's **confirmation** that payment was received. It does **not** verify a bank transfer, query any provider, or move money. Merchant confirmation is explicitly distinct from provider verification (which remains P2 / blueprint F.4).
3. **Eligibility: only `TRANSFER + UNPAID + FULFILLED` orders.** Rejected: `CANCELLED`, `PAID`, `REFUNDED`. **`ATTENTION + UNPAID` is rejected in P1-B** — its payment lifecycle (paid-attention stock failure, partial flows) is not defined sufficiently; revisit in P2.
4. **Effect:** `paymentStatus UNPAID → PAID` in one atomic, concurrency-safe conditional transition (same guarded-`updateMany` pattern as B4; `count === 0` ⇒ abort). **Timestamp** = the transition's `updatedAt`/audit `createdAt`; **actor** = the authenticated merchant user recorded in the audit event.
5. **Audit:** exactly one `PAYMENT_RECORDED` event **in the same transaction** (B1 mechanism); no unaudited successful transition is possible.
6. **D-D:** additive nullable `Order.paymentMethod PaymentMethod?` (`CASH`/`TRANSFER`) set by `processCheckout` at creation; **existing records remain valid** (NULL, read as "recorded before the field existed" / inferred from `paymentStatus` semantics). Explicitly not a payment-processing integration.
7. UI: "Record payment received" button on the order detail page (and list row action); role gate mirrors resolve (OWNER/MANAGER — see §16).
8. Tests: eligible order transitions once; `ATTENTION`, `CANCELLED`, `PAID`, `REFUNDED` all rejected; **concurrent recording produces exactly one successful transition and exactly one audit event**; cross-org fail-closed; audit exactly-once.

### Phase B6 — POS SKU/barcode search (P1-10 remainder)

1. POS page: search box matching SKU or barcode within the session's org products already loaded by `/api/products`; **exact match first**, with **case-insensitive** matching; a match adds the variant tile to the cart.
2. **Duplicate SKU/barcode handling:** per-org uniqueness (P1-A composite uniques) makes duplicates impossible *within* an org; if the search term matches multiple variants (e.g. same barcode on different variants is prevented, but partial matches are not searched), the UI resolves deterministically (first by product name, then variant name) and shows an explicit multi-match notice rather than silently picking. Exact per-org matches are unique by constraint.
3. **No cross-organization lookup results:** the search operates on the already-org-scoped `/api/products` feed; no direct id-based lookup is added, so a foreign org's SKU/barcode can never surface.
4. No new API endpoint; widen the POS feed payload only if `sku`/`barcode` are absent (confirm at implementation — §18 assumption).

### Phase B7 — Orders list pagination + location filter (P1-11) — *unblocked by §4.7*

1. `orders/list/page.tsx`: `take`/`skip` pagination (default page size ~20, `orderBy: [{ createdAt: "desc" }, { id: "desc" }]` — **deterministic ordering** with the id tiebreaker so equal-timestamp rows cannot shuffle between pages).
2. **Invalid page values are bounded:** a non-numeric, negative, or absurd page param is coerced to page 1 server-side (never an unbounded query, never a 500).
3. Location filter: choices limited to the caller's `accessibleLocationIds`; owners/managers with unrestricted memberships see all org locations; filter applied in the `where` clause. **Unauthorized location ids cannot expose orders** — a hand-tampered `?location=` outside the accessible set yields no rows (fail closed), matching `canAccessLocation` semantics.
4. Detail link per row (to B2 page).
5. Void action on the list (per D-A).

### Phase B8 — Regression, verification, documentation

1. Full suite green: **all 83 existing tests pass unmodified, plus the new tests for every acceptance criterion and its relevant failure paths** (no arbitrary numeric target defines completion — coverage of B-AC1..B-AC31 does).
2. `git diff` of frozen M1 files (7 suites + `global-setup.ts` + `vitest.config.ts`) is empty.
3. `prisma validate` + all-workspace type-checks + fresh-DB migration replay (P1-A pattern), **including the §8 Migration verification: fresh PostgreSQL 15.20 replay of Migration A then Migration B, with A completing before B begins and `CREATE_ORDER` usable by the CHECK constraint in B**.
4. Manual smoke: POS sale → detail page → record payment received (if B5) → void (B4) on dev DB; verify stock restored exactly once at the original location.
5. Update canonical plan progress markers only after owner approval.

---

## 7. Exact file-level change inventory

> Proposed paths marked † are new files whose final names must be confirmed against routing conventions during implementation; all other paths were observed.

| Phase | File | Change type | Why it belongs in P1-B |
|---|---|---|---|
| B1 | `packages/database/prisma/migrations/<ts>_p1b_orders_a/migration.sql` + `<ts>_p1b_orders_b/migration.sql` † (two consecutive additive migrations — A: enum widening + columns + `actorId` relaxation; B: CHECK constraint; exact names TBD at implementation) | new | X-2 enum widening + idempotency columns + paymentMethod + AuditLog.actorId nullability (A) + additive CHECK constraint (D-G invariant, §8, B) — canonical P1-B items |
| B1 | `packages/database/prisma/schema.prisma` | edit | enum + optional columns + actorId nullability only (the CHECK constraint lives in Migration B SQL — Prisma does not model CHECK constraints in the DSL; P1-A hand-crafted-migration convention applies) |
| B1 | `packages/core/src/audit.ts` | edit | transaction-client parameter for atomic audit writes (§4.8) |
| B1 | `packages/core/src/orders.ts` | edit | audit events on checkout + ATTENTION CANCEL; `CREATE_ORDER`/`CANCEL_ORDER` |
| B2 | `apps/merchant-dashboard/app/(dashboard)/orders/[orderId]/page.tsx` † | new | P1-08 |
| B2 | `apps/merchant-dashboard/app/(dashboard)/orders/[orderId]/` print styles (co-located CSS or `@media print` block) † | new | P1-08 receipt record |
| B2 | `apps/merchant-dashboard/app/(dashboard)/orders/list/page.tsx` | edit | row link to detail |
| B3 | `packages/core/src/orders.ts` | edit | idempotent insert + fingerprint |
| B3 | `apps/merchant-dashboard/app/(dashboard)/orders/page.tsx` | edit | client idempotency key generation |
| B3 | `apps/merchant-dashboard/app/(dashboard)/orders/actions.ts` | edit | pass key into payload |
| B4 | `packages/core/src/orders.ts` | edit | `cancelOrder` (guarded conditional transition + RETURN movements, one tx) |
| B4 | `apps/merchant-dashboard/app/(dashboard)/orders/resolve/actions.ts` or sibling `cancel/actions.ts` † | edit/new | action wrapper w/ RBAC + location check |
| B4 | `apps/merchant-dashboard/app/(dashboard)/orders/list/page.tsx`, `[orderId]/page.tsx` † | edit/new | void UI |
| B5 | `packages/core/src/orders.ts` | edit | `recordPaymentReceived` |
| B5 | `apps/merchant-dashboard/app/(dashboard)/orders/actions.ts` (or sibling) | edit | action wrapper + RBAC |
| B5 | list/detail UI † | edit/new | "Record payment received" button |
| B6 | `apps/merchant-dashboard/app/(dashboard)/orders/page.tsx` | edit | SKU/barcode search |
| B6 | `apps/merchant-dashboard/app/api/products/route.ts` | edit (only if feed lacks sku/barcode) | payload widening |
| B7 | `apps/merchant-dashboard/app/(dashboard)/orders/list/page.tsx` | edit | pagination + location filter + links |
| B8 | `tests/order-detail.test.ts` †, `tests/order-cancel.test.ts` †, `tests/order-idempotency.test.ts` †, `tests/order-audit.test.ts` †, `tests/order-payment.test.ts` † (names TBD, extending existing vitest patterns) | new | acceptance coverage |
| B8 | `tests/helpers.ts` | edit (only if new fixtures needed — P1-A precedent) | test scaffolding |

**Not touched:** `apps/api/src/app.ts` behavior (only an optional idempotency-key field is accepted; M1 API tests frozen and unchanged), `apps/storefront/app/page.tsx`, all M1 test files, `vitest.config.ts`, `global-setup.ts`, anything in P1-A's verified implementation.

---

## 8. Schema and migration impact

All changes **additive only** (P1-A precedent; no destructive operation, no data loss possible):

| Change | Type | Migration | Decision gate | Rollback |
|---|---|---|---|---|
| `AuditAction` += `CREATE_ORDER`, `CANCEL_ORDER`, `PAYMENT_RECORDED`; `Order.idempotencyKey String?` + `Order.requestFingerprint String?` + `@@unique([organizationId, idempotencyKey])`; `Order.paymentMethod PaymentMethod?` (new enum `CASH`/`TRANSFER`); `AuditLog.actorId String?` (NOT NULL → nullable) | Postgres `ALTER TYPE ... ADD VALUE` + nullable columns + unique + constraint relaxation | **Migration A** — additive; the newly added enum values are **not used** inside Migration A | D-C/D-D approved; D-G approved | Drop columns/constraint values; existing rows unaffected (all NULL actorIds remain non-null); harmless |
| **`AuditLog` CHECK constraint (D-G invariant)** — additive | row-level CHECK | **Migration B** — runs **only after Migration A has completed successfully and `CREATE_ORDER` is committed** | D-G approved | Drop constraint; harmless |
| New `StockMovement` rows (`type: "RETURN"`) written by B4 voids | runtime data, no DDL | — (runtime) | D-A | Data rows only; never deleted (§14.2) |

**Migration A / Migration B — two consecutive additive migrations (D-G sequencing, R4):**

- **Migration A:** add `AuditAction.CREATE_ORDER` (and `CANCEL_ORDER`, `PAYMENT_RECORDED`), add `Order.idempotencyKey` + `Order.requestFingerprint` (+ composite unique), add `Order.paymentMethod`, and relax `AuditLog.actorId` to nullable. **The newly added enum values are not used inside Migration A** (no CHECK, no statement referencing them).
- **Migration B:** add the `auditlog_actorid_null_only_public_checkout` CHECK constraint. It must run only after Migration A has completed successfully and the new enum value is committed — i.e., in a **later migration step with its own commit boundary**.

**Transaction explanation (corrected in R4 — grounded in PostgreSQL 15):**

1. **PostgreSQL 15 permits `ALTER TYPE ... ADD VALUE` inside a transaction.** The M1-era claim that it "cannot run inside a transaction block on some Postgres versions" applied to pre-12 behavior and does not apply to this repository's PostgreSQL 15.20.
2. **The new enum value cannot be used until the transaction that adds it has committed.** Within the same transaction that adds `CREATE_ORDER`, any statement that references the label (such as a CHECK constraint expression) risks the "unsafe use of new value" failure. This is the reason the CHECK constraint lives in **Migration B**, not in Migration A.
3. **Prisma Migrate does not automatically wrap PostgreSQL migration files in transactions by default.** Explicit `BEGIN`/`COMMIT` statements inside a migration file can change transaction behavior. The plan therefore **does not prescribe an unverified transaction convention for this repository**; instead, the **two-migration boundary itself is the guarantee**: Migration B runs only after Migration A has completed and committed, so `CREATE_ORDER` is committed and usable before the CHECK constraint references it. No statement in either migration may rely on undocumented wrapping behavior.

**Database constraint feasibility (evidence-based conclusion): FEASIBLE — safely expressible as an additive row-level CHECK constraint, sequenced in Migration B.**

Exact invariant (matches the actual `AuditLog` representation — `action` is the Postgres enum `AuditAction`, `metadata` is `Json?` which Prisma maps to `jsonb` on PostgreSQL):

```sql
ALTER TABLE "AuditLog"
  ADD CONSTRAINT auditlog_actorid_null_only_public_checkout
  CHECK (
    "actorId" IS NOT NULL
    OR (
      "action" = 'CREATE_ORDER'
      AND "metadata" IS NOT NULL
      AND "metadata"->>'source' = 'STOREFRONT_API'
    )
  );
```

Rationale:
1. **Expressibility:** the rule references only same-row columns (`actorId`, `action`, `metadata`) — a Postgres CHECK constraint can enforce exactly this; no cross-table reference is needed. The `metadata->>'source'` accessor is valid on `jsonb`, which is what Prisma's `Json?` maps to on PostgreSQL; the string literal comparison with the enum column uses Postgres's implicit cast to `AuditAction`.
2. **Additivity:** every existing `AuditLog` row has a non-null `actorId` (observed — the helper requires one, §4.8), so the constraint holds on all existing data; adding it is non-destructive and no migration data-rewrite is involved. The constraint lives in **Migration B** — deliberately **not** in Migration A — because the `CREATE_ORDER` enum value it references must be committed before the constraint expression is created (see the transaction explanation above).
3. **Documented limitation — what the constraint cannot enforce:** the database can verify the *structural* invariant (null actor ⇔ `CREATE_ORDER` + `metadata.source = "STOREFRONT_API"`), but it **cannot verify that `source` was server-authored** — it can only inspect the stored value. **Therefore the central audit-writing helper plus automated tests (§6 B1.3, B-AC31) remain the mandatory enforcement boundary for server-authorship** (source is stamped only inside the public checkout path, never accepted from callers); the CHECK constraint is additive defense-in-depth against any future code path writing audit rows directly through `prisma.auditLog.create` and bypassing the helper. **The plan does not claim database enforcement of source authorship.**
4. **Tooling caveat (verify at implementation, do not implement now):** Prisma's schema DSL does not model CHECK constraints, so the constraint lives in the hand-crafted Migration B SQL (P1-A convention); `prisma migrate dev` applies both migrations and the CI fresh-migrated-database run exercises them. Introspection/`db push` round-tripping of CHECK constraints should be re-verified against the installed Prisma version at implementation time.
5. **Future-proofing:** if a later milestone introduces another legitimate system-origin audit event class, this constraint must be deliberately altered (it is not silently extensible) — recorded here so the narrowing is a conscious decision.

**Metadata contract (R4 — explicit):** `metadata.source` is a **top-level JSON key** of the audit metadata object (not nested). The server stamps this key on public storefront checkout inside the public checkout path; it is **never accepted as a client-controlled authorization claim** — callers cannot supply it to obtain `STOREFRONT_API` attribution. The CHECK constraint reads exactly this top-level key (`metadata->>'source'`), and the helper's null-actor check reads the same key (§6 B1.3). All sections that reference the audit metadata (§6 B1, §8, §10.2, B-AC31, the test matrix, §16 D-G) use this contract.

**Migration verification (implementation-time only — not executed by this planning task):**

1. Fresh **PostgreSQL 15.20** database replay of **Migration A followed by Migration B** (CI's fresh-migrated-database run provides this environment).
2. Confirmation that **Migration A completes before Migration B begins** (sequential application; B must never run against a database where A failed or was rolled back).
3. Confirmation that **`CREATE_ORDER` is usable by the CHECK constraint in Migration B** — i.e., the enum value added in A is committed and resolvable when B's constraint expression is created and validated (the guard against "unsafe use of new value").
4. Confirmation that the **CHECK constraint accepts only the intended null-actor case** (acceptance/rejection table in the review record; exercised by the B-AC31 matrix on the fresh-migrated database).
5. **Prisma introspection/validation checks** for the resulting schema and constraint — `prisma validate` passes, and introspection round-trips the relaxed `actorId` and the hand-crafted constraint without drift.
6. These checks are implementation gates; none are executed by this revision.

No existing column is altered, renamed, or dropped (AuditLog.actorId is only relaxed to nullable). `prisma migrate dev` replay on a fresh database is a hard verification step. Existing audit rows are untouched (enum widening is strictly additive; existing five values unchanged).

---

## 9. API contracts and workflow transitions

### 9.1 Server action contracts (dashboard)

Uniform shapes preserved (`{ success, ... } | { error }` from `toSafeErrorMessage`):

```
createOrder({ items, paymentMethod, customerName, customerPhone, idempotencyKey })   // key REQUIRED from POS (D-C)
  → { success: true, orderId, orderNumber } | { error } | { error: conflict }        // same key + different payload
resolveOrder(orderId, "FULFILL" | "CANCEL")            // unchanged
cancelOrder(orderId, reason?)                          // NEW (D-A); STAFF-blocked; location-checked
recordPaymentReceived(orderId)                         // NEW (D-B); RBAC; TRANSFER+UNPAID+FULFILLED only
```

Public API (`apps/api`): unchanged contract; an idempotency key **may** be optionally accepted. **Guarantee distinction:** keyed requests are idempotent; **unkeyed public-API requests are not** — M1 behavior and frozen tests are preserved. No universal idempotency claim is made.

### 9.2 Workflow transitions (state machines as implemented)

```
                 ┌───────────────────────────────────────────────────────┐
                 │            Order.status                               │
                 │                                                       │
  checkout ──────┼─→ FULFILLED (stock deducted, SALE movements)           │
                 │     ├─→ CANCELLED  (void: D-A; RETURN movements,       │
                 │     │                original location, 1 tx,          │
                 │     │                concurrency-guarded)              │
                 │     └─ (no other P1 transition)                        │
                 │                                                       │
  low stock ─────┼─→ ATTENTION (no deduction)                             │
                 │     ├─→ FULFILLED (resolve; SALE w/ real actor)        │
                 │     └─→ CANCELLED (existing; now audited)              │
                 │                                                       │
                 │  PENDING: enum value only — nothing creates it         │
                 └───────────────────────────────────────────────────────┘

                 ┌───────────────────────────────────────────────────────┐
                 │            Order.paymentStatus                        │
                 │                                                       │
  CASH order ────┼─→ PAID at creation                                    │
  TRANSFER ──────┼─→ UNPAID at creation ──→ PAID                          │
                 │     (recordPaymentReceived: TRANSFER+UNPAID+FULFILLED  │
                 │      only; atomic + concurrency-safe; audited)         │
  ATTENTION CANCEL: PAID → REFUNDED (existing, orders.ts:255)            │
  VOID (D-A): UNPAID stays UNPAID (nothing to refund)                    │
                 └───────────────────────────────────────────────────────┘
```

`status` and `paymentStatus` remain fully independent axes (canonical E.4). PAID+FULFILLED cancellation is **not offered** in P1 (canonical E.4; refunds are P2). ATTENTION+UNPAID payment recording is **not offered** in P1-B (D-B).

---

## 10. Security and tenant/location authorization requirements

### 10.1 Tenancy, roles, input validation

| Requirement | Current state | P1-B requirement |
|---|---|---|
| Org scoping on read | Verified (order list, aggregates; NOT_FOUND fail-closed pattern from P1-A) | B2 detail page must use org-scoped `findFirst` and fail closed on cross-org ids — **no existence leak** |
| Org scoping on write | Verified (checkout cross-tenant rejection tested) | `cancelOrder`/`recordPaymentReceived` core functions re-verify org + state (same pattern as `resolveAttentionOrder:244`) |
| Location authorization (E-11) | Verified on `resolveOrder`; model verified suitable on all order paths (§4.7) | `cancelOrder` wrapper enforces `canAccessLocation(order.locationId)` identically; B7 location filter limited to caller's `accessibleLocationIds`; **unauthorized location ids cannot expose orders** (fail closed) |
| Role enforcement | STAFF blocked from resolve (verified) | `cancelOrder`/`recordPaymentReceived` role gate mirrors resolve (OWNER/MANAGER) unless the owner chooses otherwise (§16) |
| Server-authoritative pricing (E-1, D-9) | Verified + tested | No change; regression tests preserved; B-AC19 re-asserts at action level |
| Safe errors / input validation | Verified (uniform shapes, server-side parsing — X-3 discipline from P1-A) | All new actions follow the same shapes; ids validated non-empty; cancel reason length-bounded; page params bounded server-side |
| IDOR risk | Detail page is the new read surface | Mitigated by org-scoped findFirst (fail-closed) |

### 10.2 Audit attribution and atomicity (review item E)

| Path | Actor recorded | Event | Transactionality |
|---|---|---|---|
| Dashboard checkout | Authenticated merchant user (`context.userId`) | `CREATE_ORDER` (metadata: source=`DASHBOARD`, orderNumber, paymentMethod, itemCount, total) | Same transaction as order creation |
| Public storefront/API checkout | **System origin — no merchant actor invented; `actorId` null permitted ONLY here (approved D-G):** event must be `CREATE_ORDER` and `metadata.source = "STOREFRONT_API"` must be stamped server-side in `app.ts` | `CREATE_ORDER` (metadata: source=`STOREFRONT_API`, orderNumber, paymentMethod, itemCount, total) | Same transaction as order creation |
| Order cancellation (normal void) | Authenticated actor | `CANCEL_ORDER` (metadata: reason if provided, items, location) | Same transaction as transition + RETURN movements |
| Payment recording | Authenticated actor | `PAYMENT_RECORDED` (metadata: orderNumber, method) | Same transaction as transition |
| ATTENTION FULFILL | Authenticated actor | `RESOLVE_ORDER` — **existing behavior preserved**, folded onto the transactional mechanism | Same transaction |

Rules: audit creation and the associated state mutation **commit or roll back together**; no successful state change is left unaudited; **an audit failure must not leave an orphan audit record for a rolled-back operation** (and vice versa — a mutation failure must not leave an audit row). Enforced by the transaction-client parameter added to `logAuditEvent` (§4.8).

**Null-actor safeguard (approved D-G, R3; metadata contract R4):** the central audit-writing path rejects a null `actorId` for every event except public-checkout `CREATE_ORDER` with server-stamped `metadata.source = "STOREFRONT_API"` (**a top-level JSON key, stamped server-side in the public checkout path — never a client- or caller-controlled claim**); dashboard checkout, cancellation, payment recording, and ATTENTION fulfillment all require a **non-null authenticated actor**; `STOREFRONT_API` source attribution from merchant-authenticated paths is rejected. Full criterion: **B-AC31**; structural backstop: the additive CHECK constraint (§8, Migration B).

---

## 11. Financial and workflow invariants

| # | Invariant | Status at `a0fbd75` | P1-B action |
|---|---|---|---|
| I-1 | **Order creation is not proof of payment.** | HOLDS for TRANSFER (created UNPAID); **caveat:** CASH+ATTENTION is marked PAID before fulfillment (`orders.ts:194`) — M1-frozen semantics (attention-orders.test.ts:99 depends on it) | Document as known M1 semantic; **do not change without owner decision** (D-E) — changing it would modify frozen M1 test expectations |
| I-2 | **Fulfillment is not proof of payment.** | HOLDS — TRANSFER orders are FULFILLED+UNPAID (`orders.ts:151`); structurally guaranteed by the two-axis model | Add explicit regression test (FULFILLED+UNPAID coexistence) |
| I-3 | **Refund request is not proof of completed refund.** | N/A — no refund-request workflow in P1; the only REFUNDED transition (PAID ATTENTION CANCEL) is a state representation, and no money moves anywhere in the system | Keep refund flows out (P2); test asserts no money-related mutation exists on cancel paths |
| I-4 | **Historical snapshots must not change after catalogue edits.** | PARTIAL — `OrderItem.unitPrice` is written once and never updated by any observed code path (no `orderItem.update` anywhere); **but** display joins (variant/product name) resolve live rows, so a renamed product changes historical *display* (not stored prices) | Add snapshot-immutability test (edit price → `OrderItem.unitPrice` unchanged); document live-join display caveat in B2 page |
| I-5 | **Client-submitted prices cannot override server prices.** | HOLDS + VERIFIED (`checkout-pricing.test.ts:31`; payload type carries no price fields) | Preserve tests; B-AC19 re-asserts at action level |
| I-6 | **Retried requests must not create duplicate orders or payment records.** | **DOES NOT HOLD** — client `isProcessing` guard only; a retried POST creates a second order | Implement idempotency (B3, D-C): same key + same payload → original order; same key + different payload → conflict; concurrency-safe. No Payment model exists so duplicate *payment records* are impossible by absence |
| I-7 | **Payment records must not be silently erased by cancellation.** | HOLDS by absence — no Payment model/rows exist; cancellation flips status fields, never deletes rows (both cancel paths use `order.update`, never `order.delete`) | Test asserts order row survives cancellation with full item history; **RETURN movements are never deleted** (§14.2) |
| I-8 | **Stock mutations have a single, clearly owned mutation path.** | HOLDS for the order domain: order-side stock writes exist in exactly two places — `processCheckout` (`orders.ts:126-132, 167-172`) and `resolveAttentionOrder` FULFILL (`orders.ts:261-285`), both inside transactions, both via location-scoped inventory updates **paired with** StockMovement rows (never direct Inventory writes) | B4 void adds the third order-side path **only through the same pattern** (`RETURN` movements matched to the original SALE's variant/location/quantity, at the order's location, in the same transaction as the guarded transition). P1-19 ledger refactor stays in P1.2 |
| I-9 | **Cross-org and unauthorized-location access fails closed.** | HOLDS + VERIFIED on resolve/checkout paths; location model verified trustworthy on all order paths (§4.7) | B2/B4/B5/B7 extend the same fail-closed pattern to every new surface; per-surface tests |
| I-10 | **Every state-changing order action leaves exactly one audit event, atomically.** | DOES NOT HOLD — checkout and CANCEL are unaudited; the existing RESOLVE_ORDER audit is not transaction-bound (§4.8) | B1: transactional audit writes; exactly-once tests per action; failure-path tests (no orphan audit, no unaudited mutation) |

---

## 12. Acceptance criteria (testable IDs — R2 criteria B-AC1..B-AC30 preserved; B-AC31 added in R3)

| ID | Criterion | Phase |
|---|---|---|
| **B-AC1** | Checkout writes **exactly one** `CREATE_ORDER` audit event per order (success and ATTENTION branches), inside the transaction, with metadata: source, order number, payment method, item count, total (where available) | B1 |
| **B-AC2** | Dashboard checkout attributes the event to the authenticated merchant actor; public API checkout attributes it to **system origin** (no invented merchant actor) | B1 |
| **B-AC3** | ATTENTION CANCEL writes **exactly one** `CANCEL_ORDER` audit event; FULFILL still writes exactly one `RESOLVE_ORDER` (behavior preserved) | B1 |
| **B-AC4** | A forced audit failure rolls back the state mutation, and a forced mutation failure leaves **no orphan audit row** — audit and state commit or roll back together | B1 |
| **B-AC5** | `AuditAction` widening is additive; pre-existing audit rows and the 5 existing enum values are unaffected; fresh-DB replay passes | B1 |
| **B-AC6** | Order detail page renders for an org's own order: number, dates, status, payment status, item lines with snapshot unit prices, customer, location, movements | B2 |
| **B-AC7** | Cross-org or nonexistent order id on the detail page fails closed with the uniform NOT_FOUND-style error; no data leak; **no cross-organization lookup results anywhere** | B2 |
| **B-AC8** | Detail page is printable (print stylesheet); no PDF generation exists | B2 |
| **B-AC9** | Only `FULFILLED + UNPAID` orders can be cancelled; `CANCELLED`, `PAID`, and `REFUNDED` orders are rejected; ATTENTION keeps its own resolve path | B4 |
| **B-AC10** | Void sets `status → CANCELLED`, keeps `paymentStatus UNPAID`, and writes exactly one `RETURN` StockMovement **per line, matching the original SALE's variant, location, and quantity**, with the resolving actor and order reference — all in one transaction | B4 |
| **B-AC11** | Stock quantities are never edited without a corresponding movement record (restoration pairs inventory increment with RETURN rows, mirroring SALE deduction) | B4 |
| **B-AC12** | **Concurrent cancellation:** parallel requests against the same `FULFILLED + UNPAID` order produce exactly one successful transition and exactly one set of RETURN movements — stock restored exactly once; the conditional transition is enforced **inside** the transaction (a status pre-check outside it is insufficient and is not relied upon) | B4 |
| **B-AC13** | STAFF is blocked from cancel/record-payment actions (role gate) | B4/B5 |
| **B-AC14** | Order row and all OrderItems survive cancellation — no deletion, payment history intact | B4 |
| **B-AC15** | "Record payment received" transitions only `TRANSFER + UNPAID + FULFILLED` orders to PAID; `ATTENTION`, `CANCELLED`, `PAID`, and `REFUNDED` orders are all rejected | B5 |
| **B-AC16** | **Concurrent payment recording** produces exactly one successful transition and exactly one `PAYMENT_RECORDED` audit event | B5 |
| **B-AC17** | Payment recording records the authenticated actor and timestamp and claims no money movement / no provider verification (merchant confirmation only) | B5 |
| **B-AC18** | *(D-D)* `Order.paymentMethod` records CASH/TRANSFER at creation; existing records remain valid (NULL) | B5 |
| **B-AC19** | *(D-9)* No field of the POS submission payload can alter unit price or total; existing client-price-override tests still pass unmodified | B8 |
| **B-AC20** | Editing a variant's price after checkout does not change the historical `OrderItem.unitPrice` | B8 |
| **B-AC21** | *(D-C)* **Same idempotency key + same meaningful payload** returns the original order — sequential replay and parallel concurrency produce exactly one order | B3 |
| **B-AC22** | *(D-C)* **Same key + different payload** returns a conflict; no new order | B3 |
| **B-AC23** | *(D-C)* **Failed checkout does not reserve an unusable key** — key, fingerprint, and order roll back together; the key remains usable for a corrected retry | B3 |
| **B-AC24** | *(D-C)* POS always supplies an idempotency key; unkeyed public-API requests retain M1 behavior (guarantees explicitly scoped to keyed requests) | B3 |
| **B-AC25** | SKU/barcode exact lookup works, case-insensitive; per-org duplicates are impossible (P1-A constraints) and multi-match results are surfaced explicitly, resolved deterministically | B6 |
| **B-AC26** | **No cross-organization lookup results** from search or any new read path | B6 |
| **B-AC27** | Orders list is paginated (bounded query); **invalid page values are rejected/bounded** to a sane default (never an unbounded query or error 500); ordering is **deterministic** (createdAt + id tiebreaker) | B7 |
| **B-AC28** | **Unauthorized location ids cannot expose orders** — a tampered `?location=` outside the caller's accessible set yields no rows (fail closed); the filter offers only accessible locations | B7 |
| **B-AC29** | Full suite: 83 pre-existing tests pass **unmodified**; frozen M1 files byte-identical (`git diff` empty against `8eec1fc` for the 9 frozen paths) | B8 |
| **B-AC30** | All workspaces type-check; `prisma validate` passes; fresh-DB migration replay succeeds | B8 |
| **B-AC31** | **(D-G, R3/R4) Null-actor attribution invariant holds end-to-end:** (a) public storefront/API checkout accepts a **null actor** for `CREATE_ORDER` **only** when `metadata.source = "STOREFRONT_API"` — a **top-level JSON key** stamped **server-side** in the public checkout path; (b) the central audit helper **rejects a null actor** for dashboard checkout, order cancellation, payment recording, and ATTENTION fulfillment/resolution — all four keep non-null authenticated actors; (c) **merchant-authenticated callers cannot spoof `STOREFRONT_API` source** to obtain null-actor attribution (source is never an accepted caller/client claim; such attempts are rejected); (d) **no other audit event may use a null actor** (e.g. `CANCEL_ORDER` or `RESOLVE_ORDER` with a null actor is rejected); (e) all accepted/rejected audit writes remain **atomic with their business mutations**; (f) the structural invariant is additionally enforced by the additive database CHECK constraint (§8, Migration B) — verified on the fresh-migrated DB | B1 |

---

## 13. Test plan (R2 plan preserved; R3 extends the order-audit suite with the B-AC31 matrix)

**Pattern:** extend the existing vitest suites (inject-based for core, `app.inject()` for API, fixture helpers from `tests/helpers.ts`); dev/test DBs via docker (`via_saas_test` recreated per run). Prisma Decimal values wrapped in `Number()` in assertions (P1-A lesson).

| Suite (new) | Covers | Level |
|---|---|---|
| `tests/order-audit.test.ts` † | B-AC1..5 **and B-AC31** — exactly-once audit per action; actor attribution per path; **null-actor matrix:** public checkout null-actor + server-stamped **top-level** `STOREFRONT_API` source accepted; null actor rejected for dashboard checkout, cancellation, payment recording, ATTENTION fulfillment; **merchant-spoofed `STOREFRONT_API` source rejected**; null actor rejected for every other event; non-null authenticated actors correctly attributed for all merchant actions; **transactional atomicity failure-path tests** (forced audit failure → rollback; forced mutation failure → no orphan row); CHECK constraint verified on fresh-migrated DB (Migration A→B replay per §8 verification); enum widening additive | unit/integration (core) |
| `tests/order-detail.test.ts` † | B-AC6..8 — render data, fail-closed scoping, no cross-org leak | integration |
| `tests/order-cancel.test.ts` † | B-AC9..14 — eligibility matrix, RETURN matching (variant/location/quantity vs original SALE), no-direct-stock-edit pairing, **concurrent cancellation (exactly one transition, one restore set)**, role guard, cross-org, survival of rows | unit/integration (core + action) |
| `tests/order-payment.test.ts` † | B-AC15..18 — eligibility matrix (ATTENTION/CANCELLED/PAID/REFUNDED rejected), **concurrency (one transition + one audit)**, actor/timestamp, paymentMethod persistence | unit/integration |
| `tests/order-idempotency.test.ts` † | B-AC21..24 — same-key replay (sequential **and parallel**), mismatched-payload conflict, **failed checkout frees the key**, unkeyed public-API behavior unchanged | integration |
| `tests/pos-search.test.ts` † (or folded into an existing suite) | B-AC25..26 — exact + case-insensitive lookup, duplicate handling, no cross-org results | unit |
| `tests/order-list.test.ts` † | B-AC27..28 — pagination bounds, deterministic ordering, unauthorized location fail-closed | integration |
| Existing suites | checkout-pricing, attention-orders, order-numbers, catalogue, api-storefront, stock-permissions + 4 M1 suites — **must pass unmodified** | regression gate |

**Completion is defined by acceptance criteria, not by count:** every B-AC, including its relevant failure paths (concurrency, conflict, rejection, rollback, authorization-failure), must have a passing test. There is no arbitrary minimum test count.

**Regression gates:** (1) full suite green; (2) `git diff 8eec1fc..HEAD` empty for the 9 frozen M1 paths; (3) `prisma validate`; (4) all-workspace type-checks; (5) fresh-DB migration replay; (6) manual smoke on dev DB (POS sale → detail → record payment / void as decided).

**Known implementation-time verification:** re-run the suite immediately after B1 — confirm no frozen M1 test asserts the *absence* of audit events on checkout/cancel (none observed during plan inspection; verify empirically).

---

## 14. Risks, edge cases, and rollback

### 14.1 Risks and edge cases

| Risk / edge case | Mitigation |
|---|---|
| Enum value added and CHECK constraint referencing it in one commit can fail ("unsafe use of new value" on PG ≥ 12) | Migration A/Migration B split (§8): enum value committed before the CHECK references it; fresh PG 15.20 replay A→B is a hard verification step |
| Frozen M1 test could implicitly depend on "no audit on checkout" | None observed; empirical suite re-run right after B1; if any conflict appears → **stop and surface to owner** (M1 files must not be modified) |
| `AuditLog.actorId` nullability touches a core audit constraint | **D-G APPROVED (R3)** with the null-actor safeguard; additive relaxation + additive CHECK constraint (§8); no existing row affected (all have non-null actors); no FK change; primary enforcement = central helper + tests (B-AC31), constraint = defense-in-depth |
| Void-restock could double-restore if re-entrant | Conditional guarded transition **inside** the transaction (loser aborts before any RETURN write) — B-AC12; a status pre-check outside the transaction is explicitly insufficient |
| RETURN at wrong location | Forbidden by construction: RETURN rows carry `order.locationId` — the location where stock was actually deducted (§4.7.6); tested (B-AC10) |
| Idempotency unique index on nullable column — multiple NULLs allowed | Intended (legacy rows NULL); verify index behavior on PG (NULLs distinct by default) |
| Idempotency key divergence between POS and public API | Explicitly scoped: guarantees for keyed requests only; unkeyed public API unchanged; M1 API tests frozen |
| Fingerprint collisions | Canonical serialization (sorted items, fixed field order) + server-side computation; collision odds negligible for SHA-256-class hash over bounded input; a same-key+different-fingerprint conflict is always safe (worst case: a false conflict, never a wrong replay) |
| Display joins change historical appearance (product renamed) | Documented I-4 caveat; stored prices never change; acceptable per "receipts as records" |
| CASH+ATTENTION marked PAID pre-fulfillment (I-1 caveat) | M1-frozen; surfaced as D-E; no change in P1-B |
| Dashboard "Pending Orders" widget always 0 (§4.5) | Dead code observed; optional cleanup only if owner approves (D-F); zero-risk |
| API multi-location store resolves `locations[0]` without `orderBy` (§4.7.5b) | Row-order dependent for multi-location stores; documented limitation; not fixed in P1-B (would touch M1-era API resolution) |
| Pagination changes list query | Additive `take/skip` with deterministic ordering and server-side param bounding; no data migration; UI-only risk |
| Audit-atomicity refactor of `logAuditEvent` changes a shared helper | Signature is extended (optional tx param, default = global prisma) — existing callers compile and behave identically; P1-A audit tests must pass unmodified |

### 14.2 Rollback and durable business effects (review item F)

Three distinct layers — do not conflate them:

| Layer | What it means | Reversibility |
|---|---|---|
| **1. Code rollback** | Reverting application source to a prior commit | Fully reversible; redeploy prior code |
| **2. Additive schema rollback** | Dropping the additive columns/enum values | Technically reversible while no data depends on them; **once business data exists in new fields, dropping them destroys that data — do not treat as a routine rollback** |
| **3. Durable business-data effects** | Completed cancellations, RETURN movements, recorded payments, orders and their full movement/audit history | **NOT reversible by rollback — by design** |

**Explicit statements:**

- Completed cancellations and their RETURN movements are **durable business effects**. Reverting application code does **not** undo completed cancellations or restore prior business state.
- **Never delete RETURN movements** (or any StockMovement/AuditLog rows) as a rollback shortcut. The movement history is the inventory ledger's source of truth and the audit trail is append-only (`packages/core/src/audit.ts` — "We do not have UPDATE or DELETE functions for AuditLog").
- Preserve orders and their movement history in all cases.
- Corrections to a mistaken cancellation or payment recording must be made through a **separate, authorized, auditable forward operation** (a future milestone's concern — P1-B does not build a correction workflow, and no money ever moved, so an erroneous void is corrected by re-opening stock through normal inventory processes with proper movements).
- **No clean rollback of irreversible business operations is promised.** Code and schema rollbacks are supported; completed business effects are not.

---

## 15. Explicit exclusions and deferred work

| Excluded | Where it actually lives |
|---|---|
| Payment provider integration | Blueprint F.4 / P2 |
| **Bank-transfer verification** (any provider/bank query) | P2 — P1-B's payment recording is merchant confirmation only |
| Refunds moving money; refund-request workflows | P2 |
| Payment recording for ATTENTION orders | Undefined lifecycle; revisit P2 |
| PDF receipts, email delivery | P2 |
| Discounts, promo pricing | P3 |
| Cash drawer / change calculation | Blueprint (later) |
| Cart persistence across sessions/refresh | Decision D-E presumed NOT required (no evidence); revisit only with owner requirement |
| Partial payments | No requirement evidence; OUT OF SCOPE (§18) |
| Inventory valuation or general inventory-ledger redesign (E.1 shared helper), history UI, thresholds, stock counts | P1.2 = P1-19..P1-22 (P1-C per phase table) |
| Procurement (suppliers, POs) | P1.3 = P1-23.. |
| Transfers | P1.4 |
| Customer profile pages/edit/search — broader customer management | P1.6 = P1-13 |
| Staff/invite/location CRUD/org-switcher admin — broader location management | P1.7 = P1-14..P1-17 |
| POS location picker (order attributed to first accessible location today) | Usability follow-up; touches location-management scope — out of P1-B |
| Rate limiting + API JSON-schema validation | P1-12 (X-1) — separate X item |
| Non-order audit events (ADJUST_INVENTORY, RECEIVE_GOODS, TRANSFER_STOCK, UPDATE_MEMBERSHIP, UPDATE_LOCATION, REMOVE_MEMBER) | Their own P1.2/P1.7 milestones (canonical X-2 enumerates them per workstream) |
| New dependencies or infrastructure | None needed — no new npm packages; `@fastify/rate-limit` is P1-12's, not ours |
| Deployment or live payment functionality | Excluded entirely |

**P1-A is untouched:** no P1-A implementation change, no reopening of its completed verification gate (remote CI run 43809938334).

---

## 16. Decisions (revised R2)

The R2 review fixed the semantics of D-A, D-B, D-C, and D-D below; they are recorded as **specified decisions pending the owner's implementation sign-off** (the review's language is authoritative). **D-G was APPROVED in R3** (narrow amendment); its resolution below is final for P1-B.

| ID | Decision | Resolution (R2) |
|---|---|---|
| **D-A** | Order cancellation and stock restoration | Only `FULFILLED + UNPAID` orders cancellable. → `CANCELLED`; payment remains `UNPAID`. Paid orders cannot be cancelled through this workflow. Stock restored via `RETURN` movements **matching the original SALE's variant, location, quantity**; no direct stock edits without movement records; conditional transition + restoration in **one transaction**; **concurrency-safe** — only one request may transition the order, none may restore stock twice; **status pre-check outside the transaction is insufficient**. Tests: concurrency + exact restoration at the original location. |
| **D-B** | Recording payment received | **"Record payment received"** = merchant user's **confirmation**, not bank-transfer verification, no provider query, no money movement. Only `TRANSFER + UNPAID + FULFILLED` eligible; `CANCELLED`/`PAID`/`REFUNDED` rejected; **`ATTENTION + UNPAID` rejected in P1-B** (lifecycle insufficiently defined). Atomic, concurrency-safe; actor + timestamp recorded; audit event in the same transaction. Merchant confirmation ≠ provider verification. |
| **D-C** | Checkout idempotency | Org-scoped key uniqueness. Same key + same meaningful payload → original order; same key + different payload → **conflict**; stable server-computed request fingerprint over canonicalized meaningful input; concurrency-safe; **failed checkout leaves no unusable reserved key** (key+fingerprint+order in one transaction); key retained for the order's lifetime, org-scoped; **POS must always supply a key**; public API may stay optional — **idempotency is guaranteed only for keyed requests; no universal claim**. Tests: replay, conflict, concurrency, failed checkout. |
| **D-D** | Persist `paymentMethod` | **Yes** — additive nullable `Order.paymentMethod` (`CASH`/`TRANSFER`) set at creation; existing records remain valid (NULL). Records how payment was taken; **not** a provider integration. |
| **D-E** | CASH+ATTENTION marked PAID before fulfillment (M1-frozen) | **Keep in P1-B.** Changing it would modify frozen M1 expectations; revisit in P2 payments work. |
| **D-F** | Dead "Pending Orders" dashboard widget (counts never-created PENDING) | Optional 1-line fix (count UNPAID instead); zero-risk; not required for P1-B; owner's call. |
| **D-G** *(new in R2; APPROVED in R3; sequencing + metadata contract refined in R4)* | **Audit actor for system-origin events** | **APPROVED, subject to this invariant: `AuditLog.actorId` may be null ONLY for public storefront/API checkout audit events.** Required attribution: dashboard checkout → authenticated merchant user (**non-null**); public storefront/API checkout → `actorId` may be null, event must be `CREATE_ORDER` and `metadata.source` must be `STOREFRONT_API` — a **top-level JSON key** stamped by the server-side public checkout path; order cancellation → authenticated merchant user (**non-null**); payment recording → authenticated merchant user (**non-null**); ATTENTION fulfillment/resolution → authenticated merchant user (**non-null**). **No synthetic system user.** Enforcement: central audit-writing helper rejects null `actorId` for every event except the permitted public checkout event; for null actor it requires both `CREATE_ORDER` and server-authored top-level `STOREFRONT_API` source; `STOREFRONT_API` attribution from dashboard/merchant-authenticated actions is rejected; `source` is never a client- or caller-controlled authorization claim; audit creation stays atomic with the business mutation. **Database constraint feasibility (§8): FEASIBLE** — additive row-level CHECK constraint expresses the structural invariant, sequenced in **Migration B** (two consecutive additive migrations per §8: A adds the enum value and columns and relaxes `actorId` without using the new value; B adds the CHECK only after A completes and the value is committed); documented limitation: the DB cannot verify server-authorship of `source`, so the helper + automated tests (B-AC31) remain the mandatory enforcement boundary and database enforcement of authorship is not claimed. Implementation remains additive (nullable column + CHECK constraint in the hand-crafted Migration B SQL); no migration is created by this revision. |

Role gate for `cancelOrder`/`recordPaymentReceived`: **mirror resolve** (OWNER/MANAGER; STAFF blocked) — conservative default unless the owner chooses otherwise.

---

## 17. Definition of done

P1-B is done when **all** of the following hold:

1. All decision-gated work implemented only per the specified outcomes: **D-A..D-F as specified (owner sign-off at kickoff); D-G APPROVED (R3) with the null-actor safeguard.**
2. **All acceptance criteria B-AC1..B-AC31 pass, each including its relevant failure paths** (rejection states, concurrency, conflicts, rollback atomicity, authorization failures, null-actor attribution). Completion is defined by criteria coverage — no arbitrary test count.
3. Full suite green: 83 pre-existing tests **unmodified** (M1 files byte-identical to `8eec1fc`) + the new suites.
4. `prisma validate`, all-workspace type-checks, fresh-DB migration replay pass — including the §8 Migration verification gates (A→B sequencing, `CREATE_ORDER` usability, constraint case-acceptance, introspection/validation).
5. Manual smoke on dev DB: sell → view receipt record → (as decided) record payment received / void; verify stock restored exactly once at the original location.
6. Working tree clean except intended changes; commit(s) ready for owner-authorized push; remote CI (`via-saas-ci.yml`) green on the pushed commit.
7. Canonical plan updated (progress markers + reconciled-scope notes referencing this document).
8. No P1-C/P1-D work started; no excluded scope absorbed; no durable business data manipulated outside authorized operations (§14.2).

---

## 18. Evidence appendix — observed facts vs assumptions

### Observed facts (file:line at `a0fbd75`)

1. `processCheckout` creates every order as `FULFILLED` (stock deducted) or `ATTENTION` (no deduction) — `packages/core/src/orders.ts:143-151, 182-194`.
2. TRANSFER → `paymentStatus: "UNPAID"`; CASH → `"PAID"` — `orders.ts:151`; CASH ATTENTION also `"PAID"` — `orders.ts:194`.
3. No code path creates `status: "PENDING"` — grep across core, dashboard actions, API returned zero creation sites; enum value exists (`schema.prisma`, `OrderStatus`).
4. ATTENTION CANCEL branch writes **no** audit event — `orders.ts:250-257` vs FULFILL branch `logAuditEvent` at `orders.ts:292`.
5. `AuditAction` enum = `{ CREATE_PRODUCT, UPDATE_PRODUCT, INVITE_STAFF, RESOLVE_ORDER, UPDATE_SETTINGS }` — `schema.prisma`.
6. `PaymentStatus` = `{ UNPAID, PAID, REFUNDED }`; `REFUNDED` set only by ATTENTION CANCEL on PAID orders — `orders.ts:255`.
7. No `Payment` model, no `Order.paymentMethod`, no `amountPaid` — schema grep.
8. `StockMovementType` already includes `RETURN` — `schema.prisma`; order-side writes use `type: "SALE"` only — `orders.ts:172, 285`.
9. **`Order.locationId` is NOT NULL** (`schema.prisma`); validated fail-closed against the org in `processCheckout` (`orders.ts:107-113` → `FORBIDDEN`).
10. **Dashboard checkout location is server-derived:** `createOrder` passes `context.locationId` (`orders/actions.ts:36`) = `accessibleLocations[0].id`, resolved from `Membership.allowedLocationIds` (`auth-helpers.ts:47-57`); a membership with zero accessible locations yields no session context (`auth-helpers.ts:52`). Client location input is never used.
11. **Public checkout location is server-derived:** `resolved.location.id` = slug-resolved store's first location via `locations: { take: 1 }` (`app.ts:51-55, 126`); the `take: 1` has **no explicit `orderBy`** (row-order dependent for multi-location stores).
12. **Stock is per-location:** `Inventory @@unique([locationId, variantId])`; checkout deducts via location-scoped `updateMany` decrement (`orders.ts:126-132`); SALE movements carry `order.locationId` (`orders.ts:169, 265, 282`).
13. **`AuditLog.actorId` is NOT NULL with FK to User** — no system-origin representation for audit (`schema.prisma`; contrast `StockMovement.actorId String?`).
14. **`logAuditEvent` uses the global `prisma` client** (`packages/core/src/audit.ts`) — even the in-transaction `RESOLVE_ORDER` call (`orders.ts:292`) is not transaction-bound; audit is append-only.
15. **Public API checkout passes `null` as the actor userId** (system-origin convention, E-3) — `app.ts:124-130`.
16. `createOrder` action payload contains only ids/quantities/customer/paymentMethod — `orders/actions.ts:9-14`; no idempotency key.
17. `resolveOrder` blocks STAFF and enforces `canAccessLocation` with a no-leak error — `orders/resolve/actions.ts:8-26`.
18. Orders list is unbounded with no pagination/filter/detail link — `orders/list/page.tsx:12-20`.
19. POS has no SKU/barcode search — `orders/page.tsx` (full read).
20. Test coverage: server pricing + client-price ignore (`checkout-pricing.test.ts:10,31`), cross-tenant rejection (`:51`), merge/deduct-once (`:82`), ATTENTION fallback (`:140`), ATTENTION CANCEL semantics (`attention-orders.test.ts:99`), order-number uniqueness under load and per-org counters (`order-numbers.test.ts:31,62,80`).
21. Dashboard widget counts `status: "PENDING"` (always 0) — `(dashboard)/page.tsx:31-36`; analytics "pending" counts `paymentStatus: "UNPAID"` — `analytics/page.tsx:26-27`; revenue aggregates PAID-only.
22. Order display joins resolve live variant/product rows (`list/page.tsx:16-18`); no code path writes `OrderItem` after creation (no `orderItem.update` anywhere).

### Assumptions (require confirmation or are decisions)

1. Fresh PostgreSQL 15.20 replay of Migration A then Migration B handles the enum widening and the CHECK constraint cleanly — verify at implementation (§8 Migration verification gates; two-migration boundary is the sequencing guarantee).
2. No frozen M1 test asserts audit absence on checkout/cancel — verified empirically at B1 (§13).
3. POS `/api/products` feed payload includes variant `sku`/`barcode` (P1-A built per-variant tiles; exact payload fields to confirm at B6).
4. Fingerprint canonicalization details (exact hash function and serialization) are an implementation choice within the D-C semantics — fixed at B3 and locked by tests.
5. No requirement exists for partial payments, cart persistence, or receipt PDFs in P1 — based on full reads of the canonical plan and blueprint references; any new owner requirement overrides.
6. Canonical P1-C/P1-D map to the inventory (P1.2) and procurement (P1.3) workstreams respectively per the canonical phase table (line ~345 context) — confirm naming with owner when P1-C planning starts.
7. D-A..D-F semantics are fixed by the R2 review; **D-G was APPROVED in R3** with the null-actor safeguard (§16). Recommendations are grounded in the code; they are recommendations where marked.

### Unresolved blockers / dependencies

| Item | Status |
|---|---|
| **D-G** — audit actor nullability for system-origin checkout events | **RESOLVED — APPROVED in R3; migration sequencing + metadata contract refined in R4** with the null-actor safeguard invariant (§16); central-helper enforcement boundary specified (§6 B1.3); database CHECK constraint assessed **feasible**, sequenced in Migration B after the enum-widening Migration A (§8) with a documented authorship limitation; acceptance criterion **B-AC31** added (§12). No remaining decision blocking B1 on this item. |
| Order-location model | **Resolved — no blocker.** `Order.locationId` is NOT NULL, server-derived, org-validated; suitable for B4/B7 authorization (§4.7). |
| Cosmetic: API multi-location `take: 1` without `orderBy` | Documented limitation (§14.1); no fix in P1-B; revisit when storefront multi-location support is designed. |
| D-A..D-F implementation sign-off | Owner sign-off at implementation kickoff only (semantics already fixed — §16); not a plan blocker. |

---

*End of plan (R4). R4 — narrow amendment over R3: two consecutive additive migrations (A: enum widening + columns + `actorId` relaxation; B: CHECK constraint) with the corrected PostgreSQL 15 transaction explanation, Phase B1 numbering fixed, explicit top-level `metadata.source` contract, and documented implementation-time migration verification. R3 — narrow amendment over R2: D-G approved with the null-actor safeguard, central-helper enforcement requirements, CHECK-constraint feasibility conclusion (§8), and acceptance criterion B-AC31 (§12/§13). All other R2 content preserved. Awaiting final P1-B plan review before implementation. No implementation has begun; nothing outside this document was modified.*
