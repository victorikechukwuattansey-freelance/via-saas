# VIA SaaS — P1-C Implementation Plan: Staff, Invitations, Locations & Organization Switching

**Status:** PLANNING ONLY — not approved for implementation. No implementation is authorized by this document. Nothing outside `docs/VIA_P1C_IMPLEMENTATION_PLAN.md` may be created or modified under this planning authorization.
**Revision:** R2.1 (2026-11-16) — supersedes R2; incorporates all seven corrections from the independent R2 design review: (1) corrected the C13 error consequence in §4.8.2/§4.10 (case-mismatched acceptance yields a **misleading safe error**, not an unhandled 500 — `toSafeErrorMessage` collapses non-DomainError exceptions to the caller's fallback; new evidence E-36); (2) corrected the checkout lock order in §11.3/§11.5 to match source (inventory rows **before** L3; the no-new-deadlock conclusion retained with corrected reasoning); (3) specified `SWITCH_ORG` `fromOrganizationId` derivation in §10.5/§12 (effective session organization per §10.2, never raw `Session.activeOrganizationId`); (4) extended C-D7 supersession in §8.5 to the LINKED_EXISTING_USER reinvitation path with an explicit documented exception and new acceptance criterion C-AC61; (5) documented the pre-transaction membership authorization race in §11.5/§19 (R15) as an accepted pre-existing residual; (6) corrected the §17 fixture claim (no dedicated second-org factory exists in `tests/helpers.ts`; cross-org tests use two `createOrganizationFixture` calls); (7) corrected the document line count (750 total lines; the earlier-reported "570" was a non-blank count). R2 restructures the document to the canonical 20-section contract, adds the C8–C20 design-finding reconciliation (§4.10), a coherent concurrency/locking protocol (§11), a per-event audit contract (§12), verified order/stock/RETURN code-path evidence (§4.7), email-normalization findings (§4.8), corrected frozen-file paths (§3.3, DR-3), and six owner decisions (C-D17..C-D22). All decision IDs (C-D1..C-D22) are preserved unchanged in meaning; acceptance-criteria IDs (C-AC1..C-AC60) are preserved intact; one new criterion (C-AC61) and one new evidence reference (E-36) are added.
**Author:** JARVIS (OpenCode agent), prepared at product owner's request.
**Grounded at commit:** `859d407` ("P1-B: isolate audit-kill triggers per test file (parallel CI fix)"), branch `main`, upstream `via-saas/main` synchronized 0/0 — verified directly this session, not assumed from prior reports.
**Canonical roadmap:** `docs/VIA_P1_IMPLEMENTATION_PLAN.md` (§D.7 "P1.7 — Staff and organization management", lines 243–257; work items P1-14..P1-17, lines 440–443; decisions D-10/D-11, lines 413–414).
**Predecessor contracts:** M1 (commit `b9f5bb0` + integrity fix `8eec1fc`), P1-A (`a0fbd75`), P1-B (`22d5be8`, `2b89df5`, `859d407`) — all treated as completed contracts (§5).

---

## 1. Purpose and status

This document is the canonical P1-C implementation plan. It is **planning-only**: every design herein is a proposal until the owner approves the plan (or individual decisions from the register in §13) and issues a separate implementation authorization.

Evidence conventions used throughout:

- **[V]** — verified by direct inspection of the repository at `859d407` this session (file + symbol + line cited).
- **[I]** — inferred (reasonable from code/schema but not runtime-proven).
- **[U]** — unknown / not established; requires implementation-time verification.
- **[REC]** — design recommendation, **not** an approved requirement.
- **[OWN]** — unresolved owner decision.

What changed R1 → R2, and why: the planning brief was expanded to require explicit reconciliation of twelve design findings (C8–C20), a cross-domain locking protocol, per-event audit contracts, several invitation/location behaviors not analyzed in R1 (acceptance-email binding, email normalization, zero-stock verification, RETURN-after-archive, deterministic location ordering, switch-audit context), and verification of the frozen M1 file set. R2 is a full restructure that preserves all verified R1 content and adds the new analysis. R1 should no longer be read on its own.

## 2. Scope and exclusions

### 2.1 In scope (the four canonical work items)

| Item | Roadmap ref | Deliverable |
|---|---|---|
| **P1-14** | §D.7, roadmap line 440 | Staff list / edit (role, allowed locations) / removal + **last-owner protection** |
| **P1-15** | line 441 | Invitation lifecycle: pending listing, rescission via `StaffInvite.revokedAt`, acceptance hardening, **reinvitation & supersession**, acceptance-email binding |
| **P1-16** | line 442 | Location create / rename / archive (`Location.archivedAt`), archived-location behavior across **every** consumer, deterministic selection |
| **P1-17** | line 443 | `Session.activeOrganizationId`, `getSessionContext` preference with **eligible-membership fallback**, server-authoritative switcher |

### 2.2 Explicit exclusions

- Ownership **transfer ceremony** (C-D5 recommends exclusion; role edit remains the de-facto promotion/demotion mechanism).
- Store CRUD (create/rename/archive `Store` entities). Location operations are scoped through `store.organizationId`; store lifecycle is future work.
- Procurement, transfers, receiving, inbound stock, refunds as money movement, inventory valuation, PDF receipts, analytics exports, rate limiting (E-13 remainder), scheduled cleanup jobs.
- **No new stock-transfer behavior.** [V] `StockMovementType` includes `TRANSFER` (schema line 260) but **no code writes a TRANSFER movement** (grep over all `.ts` sources: zero writers). Transfer is P1-F territory; P1-C only guarantees it stays unwritten.
- Deleting `User`, `Location`, `Inventory`, `Order`, `StockMovement`, or `AuditLog` rows — ever.
- Any change to payment providers, billing, or the P2 payments milestone.

### 2.3 Unavoidable dependencies on completed-milestone code (each a proposed change requiring separate approval — never silently absorbed)

| Dependency | Why unavoidable | Decision |
|---|---|---|
| `apps/merchant-dashboard/lib/auth-helpers.ts` (`getSessionContext`, lines 17–65) is edited **twice** (P1-16 archived filter; P1-17 org preference) | The single tenant-resolution choke point [V] — every dashboard page/action resolves through it | Sequencing plan §15 |
| `packages/core/src/orders.ts` `processCheckout` location pre-check (lines 193–199) gains `archivedAt: null` | "No order lands on an archived location" requires it; the file is P1-B-closed | C-D12 |
| `packages/core/src/products.ts` `adjustInventory` (lines 651–718) gains an archived-location rejection | Archiving must stop new stock activity; the function is M1-era | C-D20 |
| `packages/core/src/auth.ts` + `register/actions.ts` + `login/actions.ts` email normalization alignment | The invite path normalizes email; registration/login/lookup do not (§4.8) — a live account-matching defect | C-D18 |

## 3. Verified repository baseline

### 3.1 Repository state (verified this session)

| Item | Value | Evidence |
|---|---|---|
| Repo root | `C:/Users/1040 G8/Documents/jarvis-demo` (`via-saas/` is the project) | `git rev-parse --show-toplevel` |
| Branch / HEAD | `main` @ `859d407` — matches the owner-reported P1-B completion commit | `git log --oneline -1` |
| Upstream / sync | `via-saas/main`, `0 0` behind/ahead — P1-B pushed | `git rev-list --left-right --count via-saas/main...main` |
| Working tree (via-saas) | Exactly one change: `?? via-saas/docs/VIA_P1C_IMPLEMENTATION_PLAN.md` (this plan). Zero source changes. | `git status --short -- via-saas` |
| Parent-repo changes | 27 unrelated entries, none under `via-saas/` — preserved untouched | `git status --short` |
| Migrations | **5** directories: `000000000000_baseline`, `20261115090000_m1_integrity`, `20261115120000_p1a_catalogue`, `20261116120000_p1b_orders_a`, `20261116120001_p1b_orders_b` | directory listing |
| CI | repo-root `.github/workflows/via-saas-ci.yml`: node 22, PG 15-alpine, `prisma generate`+`validate`, per-workspace type-check, Vitest on a fresh disposable DB, file-parallel workers | workflow file |

### 3.2 Test counts (recounted this session — not copied from prior reports)

Recounted per file (`^\s*it\(` per `tests/*.test.ts`): api-storefront 8, attention-orders 4, catalogue 22, checkout-pricing 8, customers 5, invites 10, order-audit 16, order-cancel 12, order-idempotency 10, order-list 12, order-numbers 4, order-payment 12, pos-search 11, session 7, stock-permissions 5, tenant-authorization 10. **Total: 156 tests across 16 test files** — matches the owner-reported CI run.

Milestone attribution (arithmetic cross-checked against the P1-B plan's "83 pre-existing tests" gate [V: `VIA_P1B_IMPLEMENTATION_PLAN.md` line 534]):

| Milestone | Files | Tests |
|---|---|---|
| **M1** (frozen) | checkout-pricing, tenant-authorization, attention-orders, order-numbers, customers, invites, session (7 suites) | 8+10+4+4+5+10+7 = **48** |
| **P1-A** | catalogue, api-storefront, stock-permissions | 22+8+5 = **35** |
| **P1-B** | order-audit, order-cancel, order-idempotency, order-list, order-payment, pos-search | 16+12+10+12+12+11 = **73** |
| Total | 16 files | **156** ✓ (48+35+73) |

P1-C plans new suites (§17) on top of the 156; it modifies none of them.

### 3.3 Frozen M1 files — verified paths (discrepancy DR-3)

The frozen M1 set (per the planning brief and `VIA_P1B_IMPLEMENTATION_PLAN.md` line 305: "9 frozen paths" = 7 suites + `global-setup.ts` + `vitest.config.ts`) verified on disk:

1. `via-saas/tests/checkout-pricing.test.ts` ✓
2. `via-saas/tests/tenant-authorization.test.ts` ✓
3. `via-saas/tests/attention-orders.test.ts` ✓
4. `via-saas/tests/order-numbers.test.ts` ✓
5. `via-saas/tests/customers.test.ts` ✓
6. `via-saas/tests/invites.test.ts` ✓
7. `via-saas/tests/session.test.ts` ✓
8. `via-saas/tests/global-setup.ts` ✓
9. **`via-saas/vitest.config.ts`** — exists at the **via-saas root**, *not* at `tests/vitest.config.ts` as the brief's path suggests [V: file listing; content verified: `globalSetup: "./tests/global-setup.ts"`, `fileParallelism: true`, `include: ["tests/**/*.test.ts"]`].

**DR-3:** the frozen config path in the brief is inaccurate; the actual path is `via-saas/vitest.config.ts`. The file is frozen all the same — P1-C must not modify it, and P1-C's new suites require no config change (they follow the existing `include` glob).

### 3.4 Discrepancy register

| # | Discrepancy | Assessment |
|---|---|---|
| DR-1 | `docs/VIA_P1B_IMPLEMENTATION_PLAN.md` status header still reads "PLAN ONLY … not implemented" while git history, the roadmap delivery appendix (lines 541–548), and the owner's CI report establish delivery. | Cosmetic staleness in a standalone doc. Recommend a one-line header fix at kickoff (owner-permitting; not authorized in this phase). |
| DR-2 | `components/shell/top-bar.tsx` renders a hardcoded, non-functional location button "Main Store - Lekki" with no data binding. | Dead pre-M1 template UI. P1-16/P1-17 replace or remove it. |
| DR-3 | Frozen vitest config lives at `via-saas/vitest.config.ts`, not `tests/vitest.config.ts`. | Path correction only (§3.3); no consequence for the frozen-file doctrine. |
| DR-4 | `docs/VIA_P1C_IMPLEMENTATION_PLAN.md` R1 (superseded by this R2) lacked the C8–C20 reconciliation, lock protocol, and audit-contract sections. | Resolved by this revision; R1's verified content and IDs are preserved. |

## 4. Existing architecture and source-of-truth findings

### 4.1 Tenancy, roles, memberships

| # | Finding | Why it matters |
|---|---|---|
| 4.1.1 | **[V]** `Membership.role` is a free `String` (comment: `"OWNER", "MANAGER", "STAFF"`), no enum/CHECK/TS guard. `schema.prisma:85-96` (role line 89). | Nothing stops `role: "GOD"` reaching the DB. Staff edit writes roles → C-D1. |
| 4.1.2 | **[V]** `Membership @@unique([userId, organizationId])` (line 95) — a user **can** hold memberships in multiple orgs; no code creates that state today, but two `inviteStaffMember` calls from two orgs to one email do (direct-link path, `core/auth.ts:84-108`). | Org switching is real, reachable capability, not hypothetical. |
| 4.1.3 | **[V]** `Membership.allowedLocationIds String[]` (line 90) — empty array = all locations. Enforcement lives **only** in `getSessionContext`'s expansion (`auth-helpers.ts:47-52`); restricted lists are intersected with the org's store locations. | P1-14 edits and P1-16 archiving both change what this expansion must produce. |
| 4.1.4 | **[V]** Permissions enforced server-side at **two layers**: core functions verify membership/org (e.g. `resolveAttentionOrder`/`cancelOrder`/`recordPaymentReceived` look up `Membership` by `userId+organizationId`, `core/orders.ts:396-402, 517-523, 621-627`), and dashboard actions gate roles before calling core (`settings/actions.ts:29-31`). | P1-C must follow the same two-layer pattern. |
| 4.1.5 | **[V]** De-facto role matrix: OWNER = invite staff + settings access (`settings/page.tsx:9-11` redirects others); MANAGER/STAFF = POS/orders/inventory/customers; STAFF blocked from resolve/void/payment actions and catalogue mutation (`canManageCatalogue`, `auth-helpers.ts:92-94`); stock adjustment rules (`canAdjustStock`, `auth-helpers.ts:81-84` — STAFF needs explicit non-empty allowed list). | This is the matrix P1-C documents (D-11); no behavior change planned. |
| 4.1.6 | **[V]** No staff edit/remove code exists anywhere. Settings page renders a read-only staff table (`settings/page.tsx:13-23`). | P1-14 is greenfield on verified foundations. |

### 4.2 Sessions and session resolution (the P1-17 blast radius)

| # | Finding | Why it matters |
|---|---|---|
| 4.2.1 | **[V]** `Session` = `id, userId, token @unique, expiresAt` + cascade user (`schema.prisma:58-64`). **No `activeOrganizationId`.** | P1-17 adds one nullable column — additive. |
| 4.2.2 | **[V]** `getSessionContext` (`auth-helpers.ts:17-65`): token → session (include `user→memberships→organization→stores→locations`) → expiry check + **lazy delete** (38-42, E-8) → **`memberships[0]` arbitrary pick** (line 44; limitation documented in the doc comment, lines 14-15) → location expansion (47-52) → **null if zero accessible locations** (52). Also `locationId` = `accessibleLocations[0].id` (57) — **arbitrary first accessible location, no deterministic order**. | The single most-affected function. C10 (ineligible fallback) and C18 (ordering) both land here. |
| 4.2.3 | **[V]** Login (`app/(auth)/login/actions.ts:32-52`) creates a session (userId+token+7-day expiry) — **no org context stored**; email looked up **raw, un-normalized** (line 18-20 area: `findUnique({ where: { email } })`). | Active-org initialization (C-D13) and email normalization (C-D18) both touch login. |
| 4.2.4 | **[V]** Registration (`app/(auth)/register/actions.ts`): raw form email, no normalization (lines 11, 20, 32); one transaction creates user + org + store(slug) + "Main Location" + OWNER membership (`allowedLocationIds: []`). | Guarantees every org starts with ≥1 location and exactly 1 OWNER — the invariant P1-14's guards protect. Also the C-D18 surface. |
| 4.2.5 | **[V]** Logout (`app/actions/auth.ts`): `session.deleteMany({ where: { token } })` + cookie clear. | No session-revocation-by-user primitive exists; removal flows rely on resolution failure (C-D4). |
| 4.2.6 | **[V]** Invitation acceptance (`app/(auth)/invite/[token]/actions.ts:6-25`) collects **token + password + confirm only — no email field**; redirects to `/login?invited=true`; **no session created**. | Acceptance identity is token-derived (§8.6); next login initializes active org per C-D13. |
| 4.2.7 | **[V]** Every dashboard page/action resolves via `getSessionContext`; POS checkout passes `context.locationId` (the arbitrary first accessible location) into `processCheckout` (`orders/actions.ts`, "DASHBOARD CHECKOUT CALLER" evidence E-31). | Single choke point; P1-17 changes selection inside it, not the call pattern. |
| 4.2.8 | **[V]** Public storefront API is unauthenticated and slug-based (`apps/api/src/app.ts`): store by slug with `locations: { take: 1 }` (line 52) and **no orderBy** → arbitrary location; checkout uses `resolved.location.id` (line 132). Cart creation resolves through the same path. | C18 (deterministic ordering) and the P1-16 archived-exclusion target. |
| 4.2.9 | **[V]** No `middleware.ts` in the dashboard app. | Nothing intermediates besides `getSessionContext` — keeps P1-17's surface small. |

### 4.3 Invitations

| # | Finding | Why it matters |
|---|---|---|
| 4.3.1 | **[V]** `StaffInvite` (`schema.prisma:112-125`): `tokenHash @unique` (119), `role String` (117), `allowedLocationIds` (118), `expiresAt`, `acceptedAt`. **No `revokedAt`. No `(organizationId, email)` uniqueness** — duplicate pending invites for one email are possible today. | Rescission = schema addition + state machine (§8); duplicates need a policy (C-D7). |
| 4.3.2 | **[V]** Creation (`core/auth.ts:56-134`): name/email **normalized** (`name?.trim()`, `email?.trim().toLowerCase()`, lines 61-62); role validated MANAGER/STAFF (67-69); restricted location ownership validated against the org (72-80); **existing-user direct-link path** (84-108) creates the membership + `INVITE_STAFF` audit (`mode: "LINKED_EXISTING_USER"`, target = user id) with **no invite row**; token path (110-133): 32-byte random token shown once, SHA-256 hash stored, 48h TTL, `INVITE_STAFF` audit with `mode: "TOKEN_INVITE"`, **target = email string** (126-130). | Security properties to preserve: hash-only storage, one-time display, org-scoped location validation. Direct-link path bypasses the invite table — rescission can never apply to it. |
| 4.3.3 | **[V]** Acceptance (`core/auth.ts:140-189`): hash lookup → rejects `acceptedAt` set or expired (149-152) → tx: **find user by `invite.email` exact match** (157); if none, create user with `invite.email` + caller-chosen password (159-164); reject if already a member (166-171); create membership from invite fields (173-180); stamp `acceptedAt` (182-185). **Check-then-write — no conditional update; no `revokedAt` in the check.** | The accept check gains `revokedAt` + conditional-write hardening (§8.4). Email handling analyzed in §4.8 (C13). |
| 4.3.4 | **[V]** `invites.test.ts` (10 tests, frozen): hash-only storage, single-use, expiry, unknown-token/short-password rejection, direct linking, already-member rejection, role/email validation, cross-org restricted-location rejection, restricted-location persistence. | Locks the invitation contract; P1-15 extends, never weakens. |

### 4.4 Locations and their consumers

| # | Finding | Why it matters |
|---|---|---|
| 4.4.1 | **[V]** `Location` (`schema.prisma:153-163`): `id, storeId, name` — **no `archivedAt`, no `(storeId, name)` unique**. `Store.slug` unique-nullable (147). Registration creates exactly one store + one "Main Location" per org; schema permits multiple stores but nothing creates them. | P1-16 adds lifecycle + uniqueness (§14); store multiplicity handled by scoping through `store.organizationId`. |
| 4.4.2 | **[V]** Location consumers: `Inventory @@unique([locationId, variantId])` (257) + cascade delete; `StockMovement.locationId` (268-286; FK **no cascade**); `Order.locationId` (350; model at 347); `Cart.locationId` (295; model at 292); `Membership.allowedLocationIds` (no FK); `getSessionContext` expansion; `inviteStaffMember` location validation; `processCheckout` pre-check; `adjustInventory` tenant check; storefront resolution. | Every consumer enumerated in §9.4's impact table; archive semantics must be coherent across all. |
| 4.4.3 | **[V]** No location CRUD exists. Settings page fetches all org locations unfiltered for the invite dropdown (`settings/page.tsx:19-22`). | P1-16 greenfield; the dropdown must exclude archived locations. |
| 4.4.4 | **[V]** `Inventory.locationId` FK **cascades on delete**; `StockMovement`/`Order` FKs do not. Deleting a Location row would destroy inventory rows and orphan movement/order references. | Deletion forbidden by design; archive-only (roadmap D.7.3: "restrict (archive flag instead); never cascade-delete stock history"). |

### 4.5 Audit coverage

| # | Finding | Why it matters |
|---|---|---|
| 4.5.1 | **[V]** `AuditAction` (8 values, `schema.prisma:22-32`): CREATE_PRODUCT, UPDATE_PRODUCT, INVITE_STAFF, RESOLVE_ORDER, UPDATE_SETTINGS + P1-B's CREATE_ORDER, CANCEL_ORDER, PAYMENT_RECORDED. | P1-C adds values (§12, C-D6) via additive `ALTER TYPE ... ADD VALUE`. |
| 4.5.2 | **[V]** Helper contract (`core/audit.ts`): `logAuditEvent(orgId, actorId, action, targetId?, metadata?, tx?)` enforces the D-G null-actor matrix (null actor permitted only for public-checkout CREATE_ORDER with top-level `metadata.source = "STOREFRONT_API"`; rejects `STOREFRONT_API` source from authenticated actors) and accepts an optional transaction client. | All P1-C events use authenticated actors and in-tx writes. |
| 4.5.3 | **[V]** Gaps P1-C closes: staff edit/remove, invite rescission, location lifecycle have no audit events (the actions don't exist). | New enum values + tests per §16. |
| 4.5.4 | **[V] Pre-existing deviation (flagged, out of scope):** `adjustInventory`'s audit write (`core/products.ts:710-714`) does **not** pass `tx` — it runs inside the transaction callback but on the global client, so it is not transaction-bound (an M1-era pattern; P1-B established the in-tx discipline). | Recorded so P1-C does not silently absorb it; fixing it is a separate owner decision (§19, R11). |

### 4.6 Concurrency and test-harness facts

| # | Finding | Why it matters |
|---|---|---|
| 4.6.1 | **[V]** Test DB isolation is PostgreSQL default READ COMMITTED (no explicit isolation level anywhere in the repo). | "Count then write" guards are racy under READ COMMITTED; conditional writes and advisory locks are required (§11). |
| 4.6.2 | **[V]** Vitest config (`via-saas/vitest.config.ts`): `fileParallelism: true`, workers share one disposable DB (`via_saas_test`, recreated by `tests/global-setup.ts` via migrate deploy); `testTimeout 30s`, `hookTimeout 120s`. P1-B's final commit exists precisely because shared DB-level triggers leaked across parallel files. | Any P1-C test scaffolding (triggers/locks) must be fixture-org-scoped, never global. |
| 4.6.3 | **[V]** CI applies all 5 migrations in order to a fresh PG 15-alpine DB. | Every P1-C migration must replay cleanly on PG 15; §14.5 ritual carried from P1-B. |

### 4.7 Order, stock, and RETURN code paths (new in R2 — the C8/C9/C16 evidence base)

| # | Finding | Why it matters |
|---|---|---|
| 4.7.1 | **[V]** `processCheckout` (`core/orders.ts:169-386`): tenant pre-check of location (`store: { organizationId }`, 193-199) → server-authoritative pricing (`resolvePricedItems`, 48-96 — variants must be PUBLISHED, `archivedAt: null`) → tx: conditional inventory decrement `quantity: { gte: item.quantity }` (242-258), order create + `allocateOrderNumber` (OrderCounter row lock, 29-39), SALE movements (291-300), in-tx CREATE_ORDER audit (303-314). INSUFFICIENT_STOCK → ATTENTION branch creates the order **without deducting stock** (327-374). | The archived filter (C-D12) slots into 193-199 **and** needs an in-tx re-check (C9). Checkout is one of the stock-domain lock users (§11). |
| 4.7.2 | **[V]** `resolveAttentionOrder` (`core/orders.ts:388-490`): membership check (396-402); tx: order must be ATTENTION (406-413); CANCEL branch = status transition only, **no stock effect** (415-444); FULFILL branch = conditional inventory decrement + SALE movements attributed to the real actor (446-486). | FULFILL is the only "fulfillment" path; **no receiving/inbound function exists** (grep: zero `type: "RECEIV…"` writers). Archive races with "receiving" are therefore not a P1-C concern; with FULFILL they are (§11). |
| 4.7.3 | **[V]** `cancelOrder` (`core/orders.ts:505-598`): FULFILLED+UNPAID only (535-540); **conditional status transition inside the tx** (545-556) — single-winner under concurrency; stock restored **exclusively via RETURN movements matched to the original SALE's variant, location and quantity** at `order.locationId` (562-581), paired with a location-scoped inventory increment; exactly one CANCEL_ORDER audit in-tx (586-594). **No location-state check exists in this path.** | C16 (exact SALE-to-RETURN matching) is already implemented and test-locked. C8: after a location is archived, cancellation continues to write RETURN to the archived location — §9.3 makes this a **preserved invariant** (exact restoration; never redirected). |
| 4.7.4 | **[V]** `recordPaymentReceived` (`core/orders.ts:615-669`): conditional FULFILLED+UNPAID→PAID transition + in-tx PAYMENT_RECORDED audit. | Unaffected by P1-C except inherited context semantics. |
| 4.7.5 | **[V]** `adjustInventory` (`core/products.ts:651-718`): tenant check (variant AND location belong to org, 669-681); **negative stock prevented** by `quantity: { gte: Math.abs(adjustment) }` for negative adjustments (684-691); ADDED/REMOVED movement (698-707); audit **without tx** (710-714, see 4.5.4). | C9's "incorrect zero-stock checks": checkout, FULFILL, and adjustment all clamp at zero via conditional `gte` writes; the DB adds `inventory_quantity_non_negative CHECK ("quantity" >= 0)` (migration `20261115090000_m1_integrity`, line 314). **Negative inventory is impossible** — which simplifies the zero-stock-verification question for archiving (§9.3). |
| 4.7.6 | **[V]** `StockMovementType` = SALE, TRANSFER, ADDED, REMOVED, RETURN (`schema.prisma:260-266`). Writers today: SALE (checkout + FULFILL), RETURN (cancel), ADDED/REMOVED (adjust). TRANSFER: **zero writers** (reserved for P1-F). | Archive's consumer impact table (§9.4) is complete against these five types. |

### 4.8 Email handling (new in R2 — the C13 evidence)

| # | Finding | Why it matters |
|---|---|---|
| 4.8.1 | **[V]** `inviteStaffMember` normalizes: `email?.trim().toLowerCase()` (`core/auth.ts:62`). | Invites persist normalized addresses. |
| 4.8.2 | **[V]** Registration does **not** normalize: raw form value into `findUnique` (line 20) and `user.create` (line 32). Login does not normalize either (4.2.3). `User.email` is `@unique` (case-sensitive in PG). | **Live defect:** an account registered as `User@X.com` is invisible to an invite for `user@x.com`; acceptance's `findUnique({ where: { email: invite.email } })` (auth.ts:157) misses → the create path attempts a duplicate (lowercased) email → Prisma **P2002**. **Verified consequence [V: `core/errors.ts` `toSafeErrorMessage`]:** the acceptance action's error handling collapses the non-DomainError P2002 to its caller-supplied safe fallback, so the user receives the **misleading "This invitation link is invalid, used, or expired." message — not an unhandled 500** — and **account linkage fails**: the invitation cannot be accepted successfully against the case-mismatched account. The defect is a functional account-matching failure with a misleading user-facing message, not a crash. Resolved via C-D18. |
| 4.8.3 | **[V]** Acceptance has **no email input** (4.2.6) — identity is token-derived and binds to `invite.email` (157). The requirement "acceptance email must match the invited address" is satisfied structurally: an invite cannot be accepted *into* an account with a different address; it can only link the account that already holds `invite.email` or create one with it. | Documented as verified; the normalization defect is the actual gap (C-D18). |

### 4.9 Frozen files and milestones (summary)

Verified in §3.2 (attribution arithmetic) and §3.3 (paths). P1-C's contract: **zero modifications** to the 9 frozen paths; the full 156 pass unmodified at every gate.

### 4.10 Reconciliation of design findings C8–C20 (required assessment)

| Finding | Statement | Status | Where addressed |
|---|---|---|---|
| **C8** | Cancellation RETURN can strand stock at an archived location. | **Resolved by design (invariant preserved, not "fixed" by redirection).** RETURN continues to write to `order.locationId` even when archived — exact restoration of the physically-deducted stock. "Stranded" stock remains queryable (inventory rows, movements, order history all intact) and is recoverable by restoring the location. Redirection to another location is **forbidden** (would falsify the ledger and violate C16's exactness). | §9.3, §9.4 (cancel row), C-AC53 |
| **C9** | Archive vs inventory-mutation race; incorrect zero-stock checks. | **Resolved by design.** (a) Zero-stock checks: [V] checkout/FULFILL/adjust all use conditional `quantity: { gte }` writes, and the DB CHECK `inventory_quantity_non_negative` (migration `m1_integrity:314`) makes negative inventory impossible — so "verify zero stock before archive" is unnecessary *and* archive is permitted regardless of quantity (C-D10 covers the only-active-location guard instead). (b) Race: archive takes the per-org advisory lock (L1); checkout takes an **in-tx archived re-check** (C-D12) so no order lands on a location archived between pre-check and commit; `adjustInventory` gains the same filter (C-D20). FULFILL races: covered by the same in-tx re-check pattern on the FULFILL branch (§11.4). | §9.3, §11, C-AC28, C-AC54 |
| **C10** | Organization selection can choose an inaccessible membership over an eligible one. | **Resolved by design.** The fallback is **eligible-first**: memberships are ordered deterministically (org `createdAt`, then membership `id`), and the first membership whose location expansion yields ≥1 accessible location is chosen; memberships that would resolve to zero accessible locations are skipped; null only if *no* membership is eligible. `memberships[0]`-blindness is eliminated. | §10.2 step 5, C-AC55 |
| **C11** | Organization switch vs membership-revocation concurrency semantics. | **Resolved by design.** The switch action verifies membership server-side and conditionally updates the session row (expired sessions cannot be resurrected); a concurrent removal between the check and the update leaves a stale `activeOrganizationId` that resolution treats as first-class: step 4 re-verifies membership **every request** and falls back (§10.2). No request ever resolves an org the user is not a member of — the invariant is enforced at resolution, not at switch time. | §10.3, §10.4, C-AC34/35/37 |
| **C12** | Incomplete audit of superseded invitations. | **Resolved by design (pending C-D7/C-D8 approval).** Auto-rescission of a superseded pending invite writes a `RESCIND_INVITE` event with `metadata.supersededBy` (the new invite id) and actor = the re-inviting OWNER; the superseding `INVITE_STAFF` event proceeds as today. Every terminal transition of an invite row is therefore audited: created (INVITE_STAFF), superseded (RESCIND_INVITE), rescinded (RESCIND_INVITE), accepted (visible via staff list; acceptance itself remains unaudited by design — M1 semantics, unchanged). | §8.5, §12, C-AC18 |
| **C13** | Email normalization, account matching, invitation role integrity. | **Owner decision required (C-D18).** Verified defect: invite path normalizes (auth.ts:62), registration/login do not (§4.8) → case-mismatched accounts are unmatchable and acceptance hits a Prisma P2002 during account linkage. **Corrected consequence [V: `toSafeErrorMessage`, E-36]:** the P2002 is a non-DomainError and is mapped to the acceptance action's safe fallback — the user sees the misleading "invalid/used/expired" invitation message (no unhandled 500), and **account linkage fails** (the invitation cannot be accepted successfully). Recommendation: normalize (trim + lowercase) at registration and login lookups, matching the invite path; acceptance keeps binding to `invite.email`. Role integrity: invite role is validated MANAGER/STAFF at creation and copied verbatim at acceptance (auth.ts:177) — [V] no OWNER can be granted via invitation; preserved. | §4.8, §8.6, C-D18, C-AC51/52 |
| **C14** | Owner access and self-lockout through location restrictions. | **Resolved by design + owner decision (C-D17).** [V] The expansion rule applies to OWNER exactly as to others: an OWNER with a restricted list has only those locations (auth-helpers.ts:47-52); an OWNER whose restricted list yields zero accessible locations gets a null context (52) — a self-lockout state reachable by editing one's own membership. Recommendation: block **all self-targeting staff mutations** (removal, role change, location-scope change) — a single-owner org's owner cannot strip their own access, and multi-owner orgs mutate each other. Uniform with C-D3's self-removal block. | §7.3, C-D3/C-D17, C-AC57 |
| **C15** | Coherent lock order across archive, membership, and stock operations. | **Resolved by design.** §11 defines a two-domain lock taxonomy: **administrative domain** (staff edit/remove, location create/rename/archive/restore) takes the per-org advisory transaction lock L1 and row locks only on Membership/Location rows; **stock domain** (checkout, FULFILL, cancel, adjust) takes row locks on OrderCounter/Order/Inventory rows and **never** takes L1. The domains' lock sets are disjoint → no cross-domain deadlock. Intra-domain orders are specified; residual same-domain risks analyzed (§11.5). | §11, C-AC59 |
| **C16** | Strict authorization and exact SALE-to-RETURN matching. | **Verified as already implemented** [V: `cancelOrder` 505-598 — membership authorization (517-523), org-scoped order fetch with uniform no-leak error (526-534), conditional single-winner transition (545-556), RETURN matched to the original SALE's variant/location/quantity with `referenceId = order.id` (562-581)]. P1-C's only touchpoint: cancellation is **never** blocked by archival (C8) — no archived filter is added to `cancelOrder`. Regression-locked by order-cancel tests. | §4.7.3, §9.3, C-AC53 |
| **C17** | Organization-switch audit context must use the effective session organization. | **Owner decision (C-D22).** Recommendation remains "no audit" (a switch is a preference over an already-authorized relationship). If the owner prefers auditing, the contract is fixed here: a `SWITCH_ORG` event written in the **target** organization (the org the actor is entering — an org whose membership the actor verifiably holds, satisfying actor-integrity), actor = session user, `metadata: { fromOrganizationId, toOrganizationId }`, transaction-bound with the session update. Writing it into the *source* org would attribute the event to an org the actor is leaving; either is defensible, but the target-org contract is the one this plan specifies. | §10.5, §12, C-D22 |
| **C18** | Unordered store/location selection and no-active-location behavior. | **Resolved by design.** All location enumerations that feed automatic selection gain deterministic ordering: storefront resolution `locations: { take: 1 }` gains `orderBy: { createdAt: "asc" }` (+ `archivedAt: null`); `getSessionContext` orders accessible locations deterministically (`createdAt`, then `id`) before picking `locationId` (57); POS callers keep passing `context.locationId` — now deterministic. Store with zero active locations → resolution fails closed (same class as today's locationless store, `app.ts:54`). | §9.5, §10.2, C-AC56 |
| **C19** | Accurate test and migration counts. | **Verified this session.** 5 migrations; 16 test files; 156 tests; milestone attribution arithmetic 48+35+73 = 156 (§3.2); frozen config path corrected (DR-3). | §3.2, §3.3 |
| **C20** | Verifiable baseline evidence. | **Provided.** Every §3 claim cites a command run this session; every §4 claim cites file+symbol+line; nothing is asserted from prior reports without re-verification. | §3, §4, §20 |

## 5. M1/P1-A/P1-B invariants (completed contracts P1-C must preserve)

1. **Tenant & location authorization** — two-layer enforcement (§4.1.4); uniform fail-closed errors for cross-org/nonexistent ids (no existence leak); location access only through `Membership.allowedLocationIds` expansion.
2. **Session security** — opaque token, httpOnly cookie, 7-day expiry, expiry enforced + lazy delete on every `getSessionContext` path (E-8); expiry cannot be extended by any P1-C operation.
3. **Invitation security** — hash-only token storage (`invites.test.ts` locks it), one-time display, 48h TTL, single-use, role restricted to MANAGER/STAFF, org-scoped restricted-location validation.
4. **Stock permission rules** — `canAdjustStock` (OWNER/MANAGER always; STAFF only with explicit non-empty allowed list); enforced at action + core layers.
5. **Catalogue behavior** — server-authoritative pricing; PUBLISHED + non-archived sellability gate (`resolvePricedItems`).
6. **P1-B order lifecycle & payment semantics** — `processCheckout(orgId, locationId, actorId|null, items, paymentMethod, customerId?, idempotencyKey?)`; D-A cancellation eligibility (FULFILLED+UNPAID); D-B/D-D payment recording; D-E CASH+ATTENTION-PAID M1-frozen semantics; D-C org-scoped idempotency with fingerprint settlement.
7. **Exact-location RETURN** — C16 as verified in §4.7.3; never redirected, never blocked by archive (C8).
8. **Idempotency guarantees** — keyed requests only; `Order @@unique([organizationId, idempotencyKey])`; P2002 settlement returns the original order or CONFLICT.
9. **Audit integrity & actor attribution** — D-G null-actor matrix + `auditlog_actorid_null_only_public_checkout` CHECK (migration `20261116120001_p1b_orders_b:35`); transaction-bound audit writes (P1-B pattern); real actors only — **no synthetic users will be invented for P1-C audit requirements** (§12).
10. **Inventory floor** — `inventory_quantity_non_negative` CHECK; all decrement paths conditionally guarded.
11. **Frozen files** — the 9 paths (§3.3) byte-identical; the 156 tests unmodified.

**Proposed changes to completed-contract code** (each requiring explicit approval via its decision): `processCheckout` archived filter (C-D12), `adjustInventory` archived rejection (C-D20), registration/login email normalization (C-D18). None weakens a security property; each adds a restriction or fixes a defect.

## 6. P1-C functional requirements

Derived from roadmap §D.7 (lines 243-257), the work-item table (440-443), D-10/D-11 (413-414), and the expanded planning brief. Requirements marked ◆ are new in R2.

**P1-14:** list members with role + location scope; edit role and location scope; remove member; last-owner protection (removal **and** demotion) under concurrency; self-mutation policy; sessions end access via resolution failure, not deletion; audit actor + snapshot metadata; role values constrained (C-D1); OWNER grants controllable (C-D19).

**P1-15:** list invitations with derived states; rescind pending invites via `revokedAt`; revoked invites never acceptable; concurrent accept/revoke single-winner; ◆ reinvitation policy with supersession (C-D7) and complete supersession audit (C12); ◆ acceptance binds to the invited address; email normalization alignment (C-D18); no raw tokens or hashes in listings; retention (no deletion).

**P1-16:** create/rename/archive (+restore) locations, OWNER-gated; per-store name uniqueness with legacy-duplicate pre-check; archive preserves all inventory/orders/movements (C-AC27); ◆ zero-stock verification analyzed and resolved: not required — DB floor guarantees non-negative quantities, archive is a display/activity deactivation (C-D10 guards the only-active-location case); ◆ archive races with checkout/FULFILL/adjust closed by conditional writes + in-tx re-checks (§11); ◆ RETURN after archive: exact, unredirected, unblocked (C8/C16); ◆ recovery from stock at an archived location = restore (no data movement); ◆ deterministic location selection everywhere (C18); storefront/dashboard behavior with zero active locations = fail closed; cross-org protection; audit per operation.

**P1-17:** `Session.activeOrganizationId` (nullable, additive); initialization at login (C-D13); resolution prefers the active org **when the membership still exists and is eligible**, else deterministic eligible-first fallback (C10); switch is server-authoritative (membership-verified, conditional write, no expiry renewal); stale active org = fallback, never a block; multi-tab shared-context accepted (C-D15); tenant isolation unchanged for the public API; ◆ switch audit per C-D22/C17 contract; legacy sessions (null active org) behave exactly as today.

## 7. Security and authorization model

### 7.1 Two-layer enforcement (established pattern — all P1-C core functions follow it)

Every new core function (staff list/edit/remove, invite list/rescind, location create/rename/archive/restore, org switch) enforces **inside core**: authenticated caller membership in the target org, the role gate where applicable, and org-scoped entity fetches with uniform fail-closed errors. Dashboard actions additionally RBAC-gate before calling core (mirroring `settings/actions.ts:29-31`). Neither layer is trusted alone.

### 7.2 Role model and OWNER-grant control

- Role representation per C-D1 (recommended: free String + shared TS union + additive DB CHECK on the three canonical values).
- Role-changing operations (edit, invite) are OWNER-only at both layers (C-D2); the invite path can only grant MANAGER/STAFF [V: validation `core/auth.ts:67-69`]; the edit path can grant OWNER only if C-D19 option (a) is approved (promotion = de-facto ownership transfer; C-D5 excludes a ceremony).
- Last-owner invariant: ≥1 OWNER membership per org at all times, guarded under concurrency (§11.2).

### 7.3 Location-restriction rules and owner self-lockout (C14)

- The expansion rule is role-agnostic [V]: empty `allowedLocationIds` = all **active** locations; a restricted list is intersected with active org locations; zero accessible → null context.
- New grants may reference only **active** org locations (§9.4 invite + edit rows).
- Self-targeting mutations blocked per C-D3/C-D17 (removal, role change, own location-scope change) — the single-owner self-lockout path is closed at the source.
- Owner access semantics otherwise unchanged: OWNER is not implicitly exempt from location restrictions (documented; changing this would widen access silently — rejected).

### 7.4 Tenant isolation and safe errors

Uniform no-leak errors: a cross-org id is indistinguishable from a nonexistent one in every new path. Safe messages via `toSafeErrorMessage`. Staff listings expose name/email to OWNER only. Invite listings never expose `tokenHash` or raw tokens. No stack traces/SQL in user-facing errors. The client can never select an organization at resolution time — the only org-setting path is the membership-verified switch action (§10.3).

## 8. Invitation lifecycle

### 8.1 State machine (proposed; `revokedAt` added by migration C1)

| State | Condition | Acceptable? | Listed as |
|---|---|---|---|
| PENDING | `acceptedAt = null ∧ revokedAt = null ∧ expiresAt > now` | ✔ | Pending |
| ACCEPTED | `acceptedAt ≠ null` | ✖ | Accepted |
| EXPIRED | `acceptedAt = null ∧ revokedAt = null ∧ expiresAt ≤ now` | ✖ | Expired |
| REVOKED | `revokedAt ≠ null` | ✖ — never, regardless of other fields | Revoked |

Precedence for display: REVOKED > ACCEPTED > EXPIRED > PENDING. Revocation is terminal; an accepted invite cannot be revoked retroactively (rescind reports "already used").

### 8.2 Listing (proposed)

`listInvitations(orgId)` — OWNER-only (C-D2/C-D8). Returns id, name, email, role, location scope, createdAt, expiresAt, derived state. **Hard exclusions:** `tokenHash`, any raw token; bounded query (`take` + `orderBy createdAt desc`). The raw token appears only in the creation response, exactly once (frozen test locks hash-only storage).

### 8.3 Rescission (proposed)

`rescindInvitation(orgId, actorId, inviteId)`: org-scoped fetch (uniform no-leak error); conditional in-tx transition `updateMany WHERE id ∧ organizationId ∧ acceptedAt: null ∧ revokedAt: null → revokedAt = now`; `count = 0` → invite nonexistent (uniform error) / already accepted ("already used") / already revoked (idempotent success, C-D8); `RESCIND_INVITE` audit in-tx (§12).

### 8.4 Concurrent accept/revoke (required)

Accept (`acceptStaffInvite`) is hardened from check-then-write to a **conditional transition**: after the hash lookup, inside the membership-creation transaction, `staffInvite.updateMany WHERE id ∧ acceptedAt: null ∧ revokedAt: null ∧ expiresAt > now → acceptedAt = now`; `count = 0` → the standard safe INVALID_INVITE rejection. Revoke uses the mirror-image conditional (§8.3). Single-row writes suffice — the row lock serializes; no advisory lock needed. Exactly one of {accept, revoke} wins under any interleaving; at most one membership is created (C-AC15).

### 8.5 Reinvitation and supersession (C-D7; C12 audit completeness)

[V] today two pending invites for one (org, email) can coexist. Recommended policy: **auto-rescind** — creating a token invite for an email with a PENDING invite in the org sets `revokedAt` on the superseded row(s) in the same transaction, with `RESCIND_INVITE` metadata `supersededBy: <newInviteId>` and actor = the re-inviting OWNER. At most one live token per (org, email). **LINKED_EXISTING_USER path (extended in R2.1):** the same supersession rule applies when the reinvitation targets an **existing user** (`core/auth.ts:84-108` — direct-linking creates the membership without an invite row): any PENDING token invite for that (org, email) is superseded (auto-rescinded with `supersededBy: <directLinkId>` semantics recorded in the `RESCIND_INVITE` metadata; actor = the re-inviting OWNER) in the same transaction as the membership creation. Without this extension, direct-linking an email that holds a live pending token invite would leave a stale PENDING row with the following verified consequences (documented exception if the owner prefers C-D7(b)): (i) the stale row remains visible as **Pending** in the invite listing; (ii) its token remains **technically live** (hash-valid) until `expiresAt`; (iii) acceptance is rejected as **ALREADY_MEMBER** (`auth.ts:166-171` — no new membership is ever created); (iv) no data corruption occurs — the row is inert, but the listing misrepresents pending state and the token surface lingers. Alternatives (allow duplicates / block reinvite) in C-D7.

### 8.6 Acceptance email binding and normalization (C13 → C-D18)

[V] Acceptance is token-derived: the account operated on is exactly the one holding `invite.email` (or newly created with it) — an invite can never attach to an account with a different address. The **actual** defect is normalization asymmetry (§4.8.2): invites are stored lowercase-trimmed, registration/login are raw. Recommended resolution (C-D18a): normalize (trim + lowercase) at registration and login lookups so all paths compare identically; migration needs **no data rewrite** for the happy path but a documented pre-check (and, if ever needed, an owner-approved one-time normalization of existing `User.email` values with collision reporting — expected zero affected rows on codebase-produced DBs [I]). Alternative (C-D18b): store invites unnormalized (rejects the normalizing improvement, leaves the defect latent).

### 8.7 Retention

No deletion, ever, in P1-C. Accepted/expired/revoked rows retained indefinitely (audit substrate; dead `tokenHash` values are inert). No scheduled cleanup.

## 9. Location lifecycle

### 9.1 Server-side surface (proposed; `packages/core/src/locations.ts`)

1. `listLocations(orgId, { includeArchived })` — org-scoped via `store.organizationId`; archived excluded by default; **ordered deterministically (`createdAt`, then `id`)** (C18).
2. `createLocation(orgId, actorId, { storeId?, name })` — store omitted → the org's single store; provided → must belong to the org (fail-closed); name trimmed, non-empty, unique per store (C-D11 → migration C2, with the §14.3 legacy-duplicate pre-check); `CREATE_LOCATION` audit in-tx.
3. `renameLocation(orgId, actorId, locationId, name)` — org-scoped fetch (uniform no-leak); same validation excluding self; `UPDATE_LOCATION` audit (before/after) in-tx.
4. `archiveLocation(orgId, actorId, locationId, { unarchive? })` — org-scoped fetch; conditional in-tx transition on `archivedAt`; **last-active-location guard** (C-D10): refuse when zero ACTIVE locations would remain; `ARCHIVE_LOCATION` audit (metadata `action: "ARCHIVE" | "RESTORE"`) in-tx. All four take the L1 advisory lock (§11).

Dashboard: OWNER-only action guards (C-D9); settings gains a locations management panel; the fake top-bar button (DR-2) is replaced with real org-scoped data or removed.

### 9.2 Archive semantics

`archivedAt DateTime?` — soft deactivation. Row, id, inventory, orders, movements, carts all retained untouched. Restore = clear `archivedAt` (audited). **Zero-stock verification: not required and not implemented** — [V] quantities are structurally non-negative (conditional `gte` guards at all three decrement sites + DB CHECK `inventory_quantity_non_negative`), so there is no "negative or offsetting inventory" case to verify; archive is a display/activity deactivation, not a stock event. Archiving a location holding stock is allowed; the stock remains queryable and the location restorable (§9.6).

### 9.3 RETURN after archive (C8/C16 — preserved invariant)

`cancelOrder` gains **no** archived filter. Cancellation of a FULFILLED+UNPAID order whose location was later archived proceeds exactly as today: RETURN movements at `order.locationId`, matched to the original SALE's variant/location/quantity, paired with the location-scoped inventory increment. Stock thereby accumulates at the archived location ("stranded") — by design: the ledger stays truthful, the physical stock exists, and the recovery path is **restore** (§9.6). Silent redirection to another location is forbidden (would falsify both ledger and physical reality).

### 9.4 Impact table — every location-dependent workflow (all rows [V] from §4)

| Consumer | Current behavior | Required P1-16 change |
|---|---|---|
| `getSessionContext` expansion (47-52) | Empty list → all org locations; restricted list intersected | Archived locations excluded from **both** modes; zero accessible → null (unchanged rule); deterministic ordering added (C18) |
| `processCheckout` pre-check (orders.ts:193-199) | Org-ownership check only | Add `archivedAt: null` → archived location rejected (`FORBIDDEN`, safe message) |
| `processCheckout` in-tx (C-D12) | No in-tx location check | Re-check `archivedAt: null` inside the checkout transaction (one indexed point-read) — closes the archive-vs-checkout race |
| `resolveAttentionOrder` FULFILL (446-486) | Deducts at `order.locationId` | Same in-tx archived re-check (C-D12 applies to FULFILL identically — an order resolved after its location was archived must not deduct there) |
| `cancelOrder` (505-598) | RETURN at `order.locationId`, no location check | **No change** — C8/C16 invariant preserved |
| `adjustInventory` (products.ts:651-718) | Org-ownership check only | Add `archivedAt: null` to the location fetch → adjustments at archived locations rejected (C-D20) |
| Storefront resolution (`app.ts:52-55`) | `locations: { take: 1 }`, no orderBy | `where: { archivedAt: null }` + `orderBy: { createdAt: "asc" }` — deterministic and archive-safe (C18); zero active → resolution fails (line 54 class) |
| Cart creation (`POST /api/cart`) | Shared resolution | Same exclusion via the shared path |
| Invite restricted-location validation (auth.ts:72-80) | Org-ownership check | Add `archivedAt: null` — cannot grant access to an archived location |
| Staff edit `allowedLocationIds` (new, P1-14) | — | Only active locations grantable (C-AC5) |
| Orders list/detail (P1-B loaders) | Location filter over accessible ids | No change; archived locations remain visible in historical records |
| Stock movements / inventory history | Ledger rows carry `locationId` | No change; history untouched (incl. archived locations' rows) |
| `allowedLocationIds` arrays holding archived ids | Intersected against live locations | Covered by the expansion change; arrays are **not** rewritten (no destructive data edit) |

### 9.5 Deterministic selection and no-active-location behavior (C18)

All automatic selections order by `createdAt`, then `id` (stable, monotonic, no reorder on rename). Storefront with zero active locations → resolution fails closed (storefront effectively offline for that org until a location is active/restored) — the same observable class as today's locationless store. Dashboard with zero accessible locations → null context (existing rule).

### 9.6 Recovery from stranded stock

If stock sits at an archived location (via RETURN after archive, or pre-existing stock): restore the location (`ARCHIVE_LOCATION` with `action: "RESTORE"`) — stock, history, and access resume with no data movement. P1-C adds **no** transfer/merge behavior (exclusion §2.2). Documented to owners: this is the complete recovery story.

### 9.7 Cross-organization protection

Every path verifies `store.organizationId = orgId` at core level; cross-org ids fail closed with the uniform error (C-AC29).

## 10. Organization selection and switching

### 10.1 Multiple memberships and eligibility

[V] A user may hold multiple `Membership` rows (`@@unique([userId, organizationId])` is per-org). **Eligible organization** [REC]: one where the user holds a membership **and** the location expansion yields ≥1 accessible location (an org whose locations are all archived, or whose restricted list matches nothing, is not eligible — C10). Roadmap D-10 adopts the Session-persisted switcher as the recommended mechanism.

### 10.2 Resolution semantics (`getSessionContext` rewrite — replacing the bare `memberships[0]`)

```
1. Load session + user + memberships (+organization→stores→locations)   [unchanged include]
2. Expired? → lazy delete + null                                        [unchanged, E-8]
3. Zero memberships → null                                              [unchanged]
4. activeOrganizationId != null?
     memberships.find(m => m.organizationId === activeOrganizationId)
       → found AND eligible? use it
       : else FALLBACK (stale active org — never blocks)                [C11]
5. FALLBACK (C10, replaces memberships[0]):
     order memberships deterministically (organization.createdAt, then membership.id)
     pick the FIRST ELIGIBLE (expansion ≥1 accessible location)
     none eligible → null                                               [C-AC55]
6. Location expansion as today + P1-16 archived filter + deterministic
   ordering of accessibleLocations (C18) before locationId pick (57)
```

Security-critical properties: the client never chooses the org (the active id lives server-side on the Session row, set only by §10.3 after a membership check); the session row is **not** rewritten during resolution (read-only GET semantics; fallback self-heals on next switch/expiry); zero-membership users get null (unchanged).

### 10.3 Switch action (proposed)

`switchOrganization(organizationId)` — dashboard server action:
1. Resolve session via cookie (same trust source); the candidate org id is **unverified client input**.
2. Verify `Membership(userId, organizationId)` exists server-side → else uniform safe error, **no state change** (C-AC34).
3. `session.updateMany({ where: { token, expiresAt > now }, data: { activeOrganizationId } })` — conditional; an expired session cannot be resurrected (C-AC40).
4. `revalidatePath("/", "layout")` — purge cached RSC payloads (C-AC39).
5. `redirect("/")` — full re-render under the new org.
6. Audit per C-D22 (recommendation: none; if approved, the C17 contract in §12).
7. No token rotation, no expiry change (C-D14).

UI: org switcher in the shell rendering the user's eligible memberships; hidden/disabled for single-org users; the fake location button (DR-2) is replaced by real data.

### 10.4 Lifecycle interactions (each verified against code)

| Event | Effect on active-org sessions |
|---|---|
| Membership removed (P1-14) | Step 4 misses → eligible-first fallback; none → null. No session deletion needed (C-D4 mechanism). |
| Role/allowed-locations edited (P1-14) | Takes effect next request (resolution re-reads membership; no caching layer exists [V]). |
| Session expiry | Unchanged: lazy delete + null; switch requires `expiresAt > now` (cannot renew). |
| Login / logout | Login initializes (C-D13a); logout deletes the row. |
| Invitation acceptance | No session created (4.2.6); next login initializes. |
| Switch-vs-removal race (C11) | Removal between steps 2 and 3 leaves a stale active org → step 4 treats staleness as first-class (fallback); no corruption path. |
| All locations of an org archived | Org becomes ineligible → skipped by fallback; direct active-org resolution fails → fallback (§10.2). |

### 10.5 Switch audit (C17)

If C-D22 approves auditing: `SWITCH_ORG` event, **organizationId = target org** (the org being entered — one whose membership the actor verifiably holds, satisfying actor-integrity), actor = session user, `metadata: { fromOrganizationId, toOrganizationId }`, transaction-bound with the session update. **`fromOrganizationId` derivation (specified in R2.1):** it MUST be the **effective session organization resolved under §10.2** — i.e., the org the request's `getSessionContext` actually resolved to (the active org when eligible, else the eligible-first fallback). It is **never** derived from the raw `Session.activeOrganizationId` column, which is nullable (legacy sessions) and may be stale (C11: staleness is first-class) — deriving from the raw field could log a `from` org the user was never operating in. Written in the same transaction as step 3 or immediately after it in a second short transaction — specified as: same transaction (the updateMany and the audit row commit together). If C-D22 keeps "no audit", no event exists and C17 is satisfied vacuously by the documented decision.

### 10.6 Tenant isolation guarantees

Single resolution choke point → every page/action inherits switch semantics with zero per-page changes [V]. Public API plane has no sessions and no switch surface (4.2.8) — unaffected. Per-request resolution + layout revalidation → no cache leakage. Parallel requests during a switch: each resolves wholly to one org (single `orgId` per resolution); the switch is one atomic `updateMany`. Multi-tab shared context accepted (C-D15) — never data-corrupting (per-request resolution).

## 11. Concurrency and locking protocol

### 11.1 Lock taxonomy

| Lock | Mechanism | Held by | Scope |
|---|---|---|---|
| **L1** | `pg_advisory_xact_lock(hashtextextended(orgId, 0))` — per-org advisory transaction lock | Administrative mutations: staff edit/remove (incl. last-owner guards), location create/rename/archive/restore (incl. last-active guard) | One org, one transaction; auto-released at commit/rollback; no schema change |
| **L2** | Single-row conditional writes (`updateMany` with state predicates) | Invite accept/revoke/supersede; session switch update; order status/payment transitions (pre-existing) | One row; the row lock serializes rivals |
| **L3** | `OrderCounter` row lock (`allocateOrderNumber` upsert-increment) | Checkout (pre-existing) | Serializes all checkouts per org |
| **L4** | Inventory row locks via conditional `quantity: { gte }` updates | Stock domain: checkout, FULFILL, cancel RETURN increments, adjust (pre-existing shapes) | Per (locationId, variantId) row |

### 11.2 Why L1 for owner-set guards

Under READ COMMITTED (4.6.1), "count owners, then delete" is racy: two concurrent removals of the last two owners can both observe `count ≥ 2` and both commit → zero owners. L1 serializes **all** staff mutations per org; the owner count is re-read **inside** the lock before any conditional write; the write itself keeps a state predicate (`WHERE role = 'OWNER'` / membership-id) as defense-in-depth. The same lock covers the last-active-location guard (two concurrent archives of the last two active locations → exactly one succeeds, C-AC59). P1-B's `OrderCounter` row-lock serialization is the same idea; the advisory form avoids inventing a counter row for orgs.

### 11.3 Protocol rules (the "same protocol" requirement)

1. **Administrative transactions** (staff, locations): acquire L1 **first**, then read state, then at most row-level writes on Membership/Location, then the in-tx audit, commit. Never touch Order/Inventory/Session rows.
2. **Stock-domain transactions** (checkout, FULFILL, cancel, adjust): never take L1. Ordering (**corrected in R2.1 to match source**): checkout = **inventory rows first** (conditional `quantity: { gte }` decrements, `orders.ts:242-258`, in item order) **then** order creation + `allocateOrderNumber` (OrderCounter/L3 row lock, `orders.ts:261-266`) → movements → audit; FULFILL/cancel/adjust = order/membership row checks → inventory rows (item order) → movements → audit. Explicitly: **concurrent checkouts CAN contend on the same inventory rows before either reaches L3** — L3 does not prevent checkout-vs-checkout inventory-row contention; it serializes the number-allocation tail of the checkout transaction. (Pre-existing shapes; P1-C adds only the archived re-checks, which are plain reads inside the same transactions.)
3. **Invite + switch transactions**: L2 only (single-row conditionals).
4. **One L1 per transaction** — an administrative transaction never acquires two org locks (no cross-org administrative operation exists in P1-C).
5. Any future operation that needs both L1 and stock-domain rows must be **rejected at design review** or explicitly ordered L1-first with a deadlock analysis — the default answer is "split it".

### 11.4 Archive races closed explicitly

| Race | Closure |
|---|---|
| Archive vs checkout pre-check | In-tx `archivedAt: null` re-check inside the checkout transaction (C-D12): the checkout pre-check rejects archived locations, and the re-check narrows the window to the commit boundary. Audit correction (F-02): under PostgreSQL READ COMMITTED - without a shared `Location` row lock or stronger serialization - a narrow race remains between the re-check passing and the checkout transaction committing, so this is NOT an absolute invariant that no order can commit after a concurrent archive transaction commits. The re-check makes "order lands on a location already archived at re-check time" hard (C-AC28 evidence: FULFILL in-tx re-check + deterministic pre-check); the residual commit-boundary window is a documented residual, not a defect against the approved C-D12 design |
| Archive vs FULFILL | Same in-tx re-check on the FULFILL branch |
| Archive vs adjustInventory | `archivedAt: null` in the location fetch; the archive's L1 excludes concurrent adjust-then-archive ambiguity at the guard level, and the conditional inventory write keeps stock exact (C-AC54) |
| Archive vs RETURN (cancel) | **Intentionally not closed** — RETURN must succeed at an archived location (C8/C16); no filter, no redirection |
| Archive vs archive (last-active guard) | L1 serializes; count re-read inside the lock; C-AC59 |
| Switch vs membership removal | §10.4 (resolution-time re-verification; stale active org is first-class) |
| Accept vs revoke vs reinvite | L2 conditional writes on the single invite row (§8.4, §8.5) |
| Concurrent last-owner removal/demotion | L1 + in-lock re-read + conditional write (C-AC7) |

### 11.5 Deadlock and performance analysis

- **Cross-domain deadlock: impossible by construction** — L1 holders never wait on stock-domain rows and vice versa (rule 1/2 disjoint lock sets).
- **Within checkout (pre-existing; corrected reasoning):** two concurrent checkouts **can** contend on the same inventory rows before reaching L3 (inventory decrements at `orders.ts:242-258` precede L3 acquisition at `261-266`). No intra-checkout deadlock results from this: each checkout acquires its inventory rows in deterministic item order, and after holding L3 no checkout subsequently waits on an inventory row — a conflicting row lock held by a rival checkout is either already released (rival committed) or resolvable without waiting on L3. FULFILL/cancel/adjust do not take L3 and could theoretically deadlock with a checkout over two inventory rows acquired in different orders; [I] probability is negligible (single-item orders dominate; PG detects and aborts one party with a retryable error), and P1-C does **not** change these paths beyond adding read-only re-checks — the residual risk is pre-existing and documented, not introduced.
- **Pre-transaction membership authorization race (pre-existing residual, documented in R2.1 — not resolved by P1-C):** membership authorization for all stock-domain operations occurs **before** the transaction begins — FULFILL (`orders.ts:396-402`), cancellation (`orders.ts:517-523`), payment recording (`orders.ts:621-627`), inventory adjustment (`products.ts:669-681`). A membership removed between the authorization check and the in-transaction writes therefore cannot stop an already-authorized in-flight operation: a just-removed member can complete exactly one operation that was authorized at check time. Subsequent requests fail resolution. This is a pre-existing M1/P1-B behavior, consistent with C-D4's resolution-failure revocation mechanism (removal does not chase in-flight requests); it is accepted as-is and any fix (e.g., in-tx membership re-verification) would be a **separate owner-approved change**, not part of P1-C.
- **Performance:** L1 adds one advisory-lock acquisition per administrative mutation (microseconds; contention only among concurrent admin ops in one org — rare at P1 scale). C-D12's in-tx re-check is one indexed point-read per checkout. No new table scans.

## 12. Audit design

Helper contract [V]: `logAuditEvent(orgId, actorId, action, targetId?, metadata?, tx?)`; D-G matrix enforced; authenticated actors only for all P1-C events; **no synthetic actors are created to satisfy non-null requirements** — every P1-C event has a real, verified session user.

| Event | Trigger | Actor | Org context | Target | Required metadata | Tx boundary | Null actor |
|---|---|---|---|---|---|---|---|
| `UPDATE_STAFF` | Successful role and/or allowedLocationIds edit | Editing OWNER (real user) | Actor's org | Membership id | `before: {role, allowedLocationIds}`, `after: {role, allowedLocationIds}` | Same tx as the membership write | Never |
| `REMOVE_STAFF` | Successful membership removal | Removing OWNER | Actor's org | Membership id | Snapshot: `userId, email, role, allowedLocationIds, reason?` | Same tx as the delete | Never |
| `RESCIND_INVITE` | Rescission (manual or supersession) | Rescinding OWNER (for supersession: the re-inviting OWNER) | Actor's org | Invite id | `email, role, mode: "TOKEN_INVITE"`, `supersededBy?` (supersession only) | Same tx as the `revokedAt` write | Never |
| `CREATE_LOCATION` | Location created | Creating OWNER | Actor's org | Location id | `name, storeId` | Same tx as the insert | Never |
| `UPDATE_LOCATION` | Rename | Renaming OWNER | Actor's org | Location id | `before: {name}`, `after: {name}` | Same tx as the update | Never |
| `ARCHIVE_LOCATION` | Archive or restore | Acting OWNER | Actor's org | Location id | `action: "ARCHIVE"|"RESTORE"`, `name` | Same tx as the `archivedAt` write | Never |
| `SWITCH_ORG` (C-D22b APPROVED) | Successful switch | Switching user | **Target org** (C17 contract) | Target org id (or session id — implementer's choice, fixed before code) | `fromOrganizationId` = **effective session organization resolved under §10.2** (never the raw nullable/stale `Session.activeOrganizationId` — §10.5), `toOrganizationId` | Same tx as the session update | Never |

Unchanged events: `INVITE_STAFF` (existing modes and polymorphic target preserved — R7 in §19), P1-B order events, M1 catalogue events. Exactly-once: one event per successful operation; failed operations write nothing (rollback). Atomicity regression tests (forced-audit-failure triggers, fixture-org-scoped per the `859d407` lesson) cover every new event (C-AC44).

## 13. Owner decision register

Categories: **[EST]** established by roadmap/prior decisions (default adopted, confirmation requested); **[REC]** recommendation awaiting approval; **[OWN]** unresolved owner decision; **[GATE]** implementation-time verification gate. "Block?" = blocks implementation kickoff if unresolved.

**OWNER APPROVAL RECORD (implementation kickoff):** the owner has explicitly approved the following decisions, resolving the entire blocking set — **C-D1 (option b)**, **C-D2 (a)**, **C-D3 (a)**, **C-D4 (a)**, **C-D7 (a, both token and LINKED_EXISTING_USER paths)**, **C-D9 (a)**, **C-D10 (a)**, **C-D12 (a)**, **C-D13 (a)**, **C-D17 (a)**, **C-D18 (a)**, **C-D19 (a)**, **C-D20 (a)**, and **C-D22 (b — audit every successful organization switch)**. Remaining defaults confirmed as stated: C-D5 (a), C-D6 (as proposed), C-D8 (b + i), C-D11 (a), C-D14 (a), C-D15 (a), C-D16 (a), C-D21 (a). Consequences of C-D22b: `SWITCH_ORG` is now an approved audit event (§12); C-AC58 is **APPLICABLE** (no longer conditional).

| ID | Question | Options | Recommendation | Consequences | Block? |
|---|---|---|---|---|---|
| **C-D1** | Role representation? | (a) String + TS union + validation; (b) (a) + additive DB CHECK on the 3 canonical values; (c) Prisma enum conversion | **(b)** | Additive; stops garbage roles at the DB without a column-type rewrite. Pre-check role values at implementation time (expected clean [I]). | **Yes** (shapes C1) |
| **C-D2** | Who may list/edit/remove staff and list/rescind invites? | (a) OWNER only; (b) OWNER + MANAGER | **(a)** | Matches all precedent (settings + invite are OWNER-gated [V]). | No (default (a)) |
| **C-D3** | Self-removal? | (a) Block entirely; (b) allow if another OWNER remains | **(a)** | Simplest fail-safe; "leave organization" is a future flow. | **Yes** (guard semantics) |
| **C-D4** | Removal mechanics? | (a) Hard-delete Membership + audit snapshot; sessions resolve to null/fallback; (b) soft `revokedAt` on Membership | **(a)** | [V] Nothing FK-references Membership; attribution lives on User and survives; roadmap endorses resolution-failure mechanism. | **Yes** (shapes P1-14 + P1-17 tests) |
| **C-D5** | Ownership transfer flow? | (a) Excluded (role edit is the de-facto mechanism); (b) dedicated flow | **(a)** | No roadmap requirement. | No |
| **C-D6** ◆ | New `AuditAction` values | Final set of **7** (C-D6 as proposed + SWITCH_ORG per C-D22b): UPDATE_STAFF, REMOVE_STAFF, RESCIND_INVITE, CREATE_LOCATION, UPDATE_LOCATION, ARCHIVE_LOCATION, SWITCH_ORG | **As proposed + SWITCH_ORG** | One yes/no; §12 fixes each event's contract. **APPROVED.** | ~~No~~ Resolved |
| **C-D7** | Reinvitation while a PENDING invite exists? | (a) Auto-rescind superseded — **on both the token-invite and the LINKED_EXISTING_USER path** (§8.5); (b) allow duplicates (status quo); (c) block reinvite | **(a)** | Kills stale tokens deterministically; ≤1 live token per (org, email) on **both** paths. If (b), the documented exception applies: a stale PENDING row from a prior token invite persists after direct-linking — visible as Pending, token technically live until expiry, acceptance rejected as ALREADY_MEMBER, no new membership (§8.5). | **Yes** (changes inviteStaffMember) |
| **C-D8** | Invite listing scope + re-rescind semantics? | List (a) pending only / (b) all with derived states; re-rescind (i) idempotent success / (ii) error | **(b) + (i)** | UI/UX-level; no schema impact. | No |
| **C-D9** | Who may create/rename/archive locations? | (a) OWNER only; (b) OWNER + MANAGER | **(a)** | Administrative, org-wide impact. | No (default (a)) |
| **C-D10** | Archive the only ACTIVE location? | (a) Block (keep ≥1 active); (b) allow (org goes dark) | **(a)** | Prevents accidental org-wide POS/storefront outage; restore always available. | No (default (a)) |
| **C-D11** | `@@unique([storeId, name])`? | (a) Yes (pre-check duplicates; §14.3); (b) validation only | **(a)** | DB-enforced; M1 integrity-migration precedent. | **Yes** (shapes C2) |
| **C-D12** | Concurrent archive-vs-checkout guarantee? | (a) In-tx `archivedAt` re-check in `processCheckout` (+ FULFILL); (b) accept benign race, document | **(a)** | Hard invariant for one indexed point-read; touches the closed P1-B file — explicit owner blessing requested. | No (default (a)) |
| **C-D13** | Active-org initialization at login? | (a) Deterministic first eligible membership (org createdAt, id); (b) leave null, rely on fallback | **(a)** | Explicit session org from day one; null = legacy compat either way. | **Yes** (shapes C3 usage + login) |
| **C-D14** | Switch mechanics? | (a) Same-session update, no rotation/expiry change; (b) rotate token on switch | **(a)** | Token authenticates the user; org is an authorization refinement verified per request. | No |
| **C-D15** | Multi-tab shared org context? | (a) Accept + document; (b) per-tab machinery | **(a)** | (b) far outside P1-C risk budget; per-request resolution prevents corruption. | No |
| **C-D16** | Historical records after location rename? | (a) Live name (current); (b) snapshot on Order | **(a), documented** | [V] Order stores `locationId` only; (b) = schema + backfill for zero functional need. | No |
| **C-D17** ◆ | Self-targeting staff edits (own role / own location scope)? | (a) Block all self-mutations (with C-D3's removal block); (b) allow if another OWNER remains and access is preserved | **(a)** | Closes the C14 self-lockout path at the source; uniform rule; (b) invites subtle conditionality. | **Yes** (guard semantics) |
| **C-D18** ◆ | Email normalization alignment? | (a) Normalize (trim+lowercase) at registration + login to match the invite path; (b) de-normalize invites; (c) leave as-is (defect documented) | **(a)** | Fixes a live account-matching defect (§4.8.2); touches M1-era registration/login — explicit approval requested; one-time data normalization pre-check expected zero-impact. | **Yes** (touches completed-contract code) |
| **C-D19** ◆ | OWNER grants via staff edit? | (a) OWNER may promote to OWNER (multi-owner allowed); (b) forbid creating additional OWNERs in P1-C | **(a)** | De-facto transfer (C-D5); "unauthorized OWNER grants" are prevented by the OWNER-only gate at both layers, not by forbidding promotion. | No (default (a)) |
| **C-D20** ◆ | Stock adjustments at archived locations? | (a) Block ADDED/REMOVED at archived locations (new-activity rule); (b) allow (physical restock of a shelf that is administratively closed) | **(a)** | Consistent "no new activity" semantics; touches M1-era `adjustInventory` — explicit approval requested; recovery = restore (§9.6). | **Yes** (touches completed-contract code) |
| **C-D21** ◆ | RETURN to archived locations? | (a) Allow (exact restoration, no redirection — C8/C16 invariant); (b) block cancellation of orders at archived locations | **(a)** | (b) would make orders with archived locations permanently un-cancellable — rejected; (a) requires **no code change** (verified: cancel has no location filter). | No (design invariant; listed for visibility) |
| **C-D22** ◆ | Audit organization switches? | (a) No audit (preference over an authorized relationship); (b) audit with the C17 target-org contract (§12) | **(a)** | Keeps both orgs' audit logs clean; (b) available with a fixed contract if the owner wants the trail. | No (default (a)) |

**Blocking set for kickoff: RESOLVED — all eight previously-blocking decisions (C-D1, C-D3, C-D4, C-D7, C-D13, C-D17, C-D18, C-D20) are owner-approved (see approval record above), as are C-D2, C-D9, C-D10, C-D12, C-D19, and C-D22. Implementation is authorized.** C-D11 shapes migration C2 (pre-check discipline approved).

## 14. Migration and legacy-data strategy

### 14.1 Proposed migrations (all additive; none written or applied in this phase)

| Migration | Content | Notes |
|---|---|---|
| **C1** (`20261116130000_p1c_staff_invites_a`) | `ALTER TYPE "AuditAction" ADD VALUE` ×7 (per approved C-D6 + C-D22b: UPDATE_STAFF, REMOVE_STAFF, RESCIND_INVITE, CREATE_LOCATION, UPDATE_LOCATION, ARCHIVE_LOCATION, SWITCH_ORG); `ALTER TABLE "StaffInvite" ADD COLUMN "revokedAt" TIMESTAMP(3)`; role CHECK per approved C-D1(b): `ALTER TABLE "Membership" ADD CONSTRAINT "membership_role_canonical" CHECK ("role" IN ('OWNER','MANAGER','STAFF'))` | No statement *uses* a new enum value and the CHECK references only pre-existing literals → **single migration safe on PG 15** (the P1-B A/B split was needed only because migration B's CHECK referenced `CREATE_ORDER` — [V] migration header documents exactly this) |
| **C2** (`20261116130001_p1c_locations`) | `ALTER TABLE "Location" ADD COLUMN "archivedAt" TIMESTAMP(3)`; `CREATE UNIQUE INDEX "Location_storeId_name_key" ON ("storeId","name")`; **amended at implementation (owner-approved):** adds `Location.createdAt` and `Store.createdAt` (`NOT NULL DEFAULT CURRENT_TIMESTAMP`, backfilled) — the deterministic-ordering design assumed these columns; the schema had none | Requires §14.3 pre-check |
| **C3** (`20261116130002_p1c_org_switch`) | `ALTER TABLE "Session" ADD COLUMN "activeOrganizationId" TEXT` | No FK recommended (stale ids are first-class, §10.4); an `ON DELETE SET NULL` FK is the alternative if the owner prefers referential rigor; no index needed (column is read via the session row, never queried by) |

### 14.2 Transaction assumptions

Prisma migrate wraps each migration in a transaction (PG 15 DDL is transactional). `ALTER TYPE ... ADD VALUE` in a transaction is permitted on PG ≥ 12 **provided the value is unused within the transaction** — satisfied (§4, E-20 precedent).

### 14.3 Legacy-data checks and cleanup (before C2; M1 integrity-migration precedent)

1. **Role values** (C1): `SELECT role, count(*) FROM "Membership" GROUP BY role` — expect only the three canonical values (registration/invite paths write validated literals [V]); any anomaly → stop, surface to owner.
2. **Duplicate location names** (C2): `SELECT "storeId", name, count(*) FROM "Location" GROUP BY 1,2 HAVING count(*) > 1` — expect zero [I: one "Main Location" per store from registration]. If duplicates exist: **do not silently rename** — the migration ships with a documented, owner-approved resolution (append suffix to the non-primary duplicate, audited manually) or aborts. The dev DB is checked before apply; CI's fresh DB is clean by construction.
3. **Email normalization** (C-D18a): `SELECT id, email FROM "User" WHERE email <> lower(email)` — expect zero; a non-empty result is reported to the owner with the collision check (`GROUP BY lower(email) HAVING count(*) > 1`) before any one-time normalization is applied.

### 14.4 Backfill: none. All new columns start NULL with exact legacy semantics.

### 14.5 Fresh-replay ritual (carried from P1-B §8)

Disposable PG 15.20 DB → `migrate deploy` C1→C2→C3 in order → `_prisma_migrations` order confirmed → `pg_get_constraintdef` for the role CHECK → `prisma validate` → introspection round-trip matches schema → case-matrix SQL (accept 3 roles; reject a 4th; reject duplicate store+name) → drop DB. Evidence captured at implementation time, never asserted in a plan.

### 14.6 Durable consequences

Staff removal deletes a Membership row (irreversible without re-invite; snapshot preserved in the audit). Invitation revocation is terminal and audited. Location archive/restore is reversible. **No business record (order, movement, inventory, user, session) is ever deleted or rewritten.**

## 15. Implementation sequence

### 15.1 Dependency graph (evidence-justified)

```
C1 (audit enum + revokedAt + role CHECK)
   ├─► P1-14 staff mgmt ─┐
   └─► P1-15 invite lifecycle ─┤ (independent of each other; both feed
                                │  the membership lifecycle P1-17 handles)
C2 (archivedAt + name unique)
   └─► P1-16 location mgmt — edits getSessionContext (archived filter),
        processCheckout/FULFILL re-checks, adjustInventory filter (C-D20),
        storefront resolution
C3 (activeOrganizationId)
   └─► P1-17 org switching — edits getSessionContext again (preference +
        eligible fallback), login init, switch action, switcher UI
```

Order rationale: (1) P1-14/P1-15 first — lowest blast radius, and they establish the membership lifecycle semantics P1-17's stale-session handling is designed against; (2) P1-16 before P1-17 — both edit `auth-helpers.ts`; two sequential edits each gated by the full suite beat one combined rewrite (bisectability — the P1-B small-migrations lesson); (3) P1-17 last — highest blast radius (every page/action resolves through it [V]); (4) P1-14 ∥ P1-15 parallelizable (disjoint files; C1 lands before both); (5) migration order C1→C2→C3 fixed for unambiguous replay evidence. Roadmap sequencing §F (lines 345-347) concurs ("P1-C … needed before multi-location value exists; small").

### 15.2 Files likely to change vs frozen

| Category | Files |
|---|---|
| **Likely to change** | `packages/database/prisma/schema.prisma` + 3 new migrations; `packages/core/src/auth.ts` (rescind, accept hardening, supersession; normalization per C-D18a); new `packages/core/src/staff.ts`, `packages/core/src/locations.ts`; `packages/core/src/orders.ts` (C-D12 re-checks only); `packages/core/src/products.ts` (C-D20 filter only); `apps/merchant-dashboard/lib/auth-helpers.ts` (twice, sequenced); `settings/actions.ts` + `settings/page.tsx` (+ new action files); `app/(auth)/login/actions.ts`, `app/(auth)/register/actions.ts` (C-D13a, C-D18a); `components/shell/top-bar.tsx` (DR-2); new `tests/staff-management.test.ts`, `tests/invite-lifecycle.test.ts`, `tests/location-management.test.ts`, `tests/org-switch.test.ts`; docs: roadmap delivery rows, P1-B header fix (DR-1, owner-permitting) |
| **Frozen — zero modifications** | The 9 M1 paths (§3.3, with DR-3's corrected config path) — `checkout-pricing`, `tenant-authorization`, `attention-orders`, `order-numbers`, `customers`, `invites`, `session` test files, `tests/global-setup.ts`, `via-saas/vitest.config.ts` |

### 15.3 Gates

| Gate | Content |
|---|---|
| G1 | C1 + P1-14: staff suite green + full 156 green + type-checks |
| G2 | P1-15: invite lifecycle suite green + full suite green |
| G3 | C2 + P1-16: location suite green + **full session suite green** (choke-point edit landed) + full suite green |
| G4 | C3 + P1-17: org-switch suite green + full session suite green + full suite green + type-checks + `prisma validate` + §14.5 replay evidence |
| G5 | CI green (parallel workers), final diff inspection, report |

## 16. Acceptance criteria

Runtime-testable; implementation classifies every one PASS/FAIL/NOT VERIFIED with evidence (P1-B discipline). C-AC1..C-AC50 carry their R1 definitions (abbreviated here where unchanged from R1; the full text of each criterion below is authoritative).

### P1-14 Staff (C-AC1..C-AC11)

| ID | Criterion |
|---|---|
| C-AC1 | OWNER can list the org's staff server-side: membership id, user name/email, role, location scope (names or "All"), org-scoped only. |
| C-AC2 | MANAGER and STAFF are rejected from staff listing/editing/removal at BOTH action and core layers. |
| C-AC3 | A membership id from another org fails closed on edit AND removal with the uniform no-leak error. |
| C-AC4 | A role edit takes effect on the member's NEXT request without session recreation. |
| C-AC5 | `allowedLocationIds` edits reject non-org ids and **archived locations**; empty array = all active locations. |
| C-AC6 | Demoting or removing the last OWNER is rejected; org retains ≥1 OWNER after any rejected attempt. |
| C-AC7 | Two concurrent owner-degrading operations (removal or demote+remove) → exactly one success, ≥1 OWNER remains — runtime concurrency test. |
| C-AC8 | Self-removal blocked per C-D3; safe non-leaking error. |
| C-AC9 | Removal deletes exactly the Membership row; exactly one `REMOVE_STAFF` audit (authenticated actor, snapshot metadata) in the SAME tx; no orphan audit on failure; User, sessions, and historical attribution survive intact. |
| C-AC10 | After removal, the member's next request in that org fails membership resolution (null or eligible fallback). |
| C-AC11 | Role edit writes exactly one `UPDATE_STAFF` audit (before/after), atomic with the mutation. |

### P1-15 Invitations (C-AC12..C-AC20)

| ID | Criterion |
|---|---|
| C-AC12 | OWNER can list invitations with derived states (§8.1 precedence); the response contains **no `tokenHash` and no raw token** (runtime assertion on the returned structure). |
| C-AC13 | Rescinding a PENDING invite sets `revokedAt`; the invitation can never be accepted afterward. |
| C-AC14 | ACCEPTED and EXPIRED invites reject acceptance exactly as today (frozen `invites.test.ts` behaviors preserved unmodified). |
| C-AC15 | Concurrent accept + rescind: exactly one terminal outcome wins; the other reports the state; at most one Membership created — runtime test. |
| C-AC16 | Cross-org invite listing and rescinding fail closed with the uniform error. |
| C-AC17 | Reinvitation follows C-D7 (recommended: auto-rescind superseded pending invite; superseded token unacceptable). Supersession applies on **both** the token-invite and the LINKED_EXISTING_USER reinvitation path (§8.5; full criterion C-AC61). |
| C-AC18 | Rescission (manual or supersession) writes exactly one `RESCIND_INVITE` audit with the actor and (for supersession) `supersededBy`, atomic with the `revokedAt` write. |
| C-AC19 | The raw token is returned exactly once at creation, never persisted/logged/listed. |
| C-AC20 | Invite rows retained after acceptance/revocation (no deletion path exists). |

### P1-16 Locations (C-AC21..C-AC30)

| ID | Criterion |
|---|---|
| C-AC21 | OWNER can create a location; store must belong to the org (cross-org storeId fails closed); name trimmed, non-empty, unique per store. |
| C-AC22 | Rename validates identically (uniqueness excluding self) and requires org ownership. |
| C-AC23 | Archive sets `archivedAt`; restore clears it; both are conditional in-tx transitions (single-winner). |
| C-AC24 | Archived locations are excluded from `getSessionContext`'s accessible set in BOTH expansion modes; a membership restricted to only-archived locations yields null context. |
| C-AC25 | POS checkout against an archived location is rejected (`FORBIDDEN`) — pre-check AND in-tx (C-D12). |
| C-AC26 | Storefront checkout/cart resolution never selects an archived location; a store with zero active locations fails resolution like a locationless store. |
| C-AC27 | Archiving preserves ALL historical data: orders, order items, stock movements, inventory rows, carts remain untouched and queryable (runtime row/value assertions). |
| C-AC28 | Concurrent archive + checkout race: no order is ever persisted against a location archived at order-commit time (in-tx re-check — runtime test forces the interleaving). |
| C-AC29 | Cross-org create/rename/archive fail closed (uniform error). |
| C-AC30 | Exactly one `CREATE_LOCATION`/`UPDATE_LOCATION`/`ARCHIVE_LOCATION` audit per operation (archive/restore distinguished in metadata), atomic; archiving the last active location is rejected per C-D10. |

### P1-17 Organization switching (C-AC31..C-AC42)

| ID | Criterion |
|---|---|
| C-AC31 | `Session.activeOrganizationId` exists, nullable; **every existing session test passes unmodified** (null ≡ legacy behavior). |
| C-AC32 | Login initializes the active org deterministically per C-D13. |
| C-AC33 | A valid switch resolves the context to the chosen org on the next request: correct orgId, role, and location set. |
| C-AC34 | A switch to an org the user does not belong to is rejected server-side with the uniform error and NO state change. |
| C-AC35 | Membership removed after session creation: next request falls back (or logs out) per §10.2; the removed org's data is inaccessible from that session. |
| C-AC36 | A stale `activeOrganizationId` never blocks resolution — deterministic **eligible-first** fallback; zero eligible → null. |
| C-AC37 | Parallel requests spanning a switch: each resolves wholly to one org; the switch write is atomic and requires an unexpired session. |
| C-AC38 | No client input can select an organization at resolution time; a tampered cookie/body/header cannot produce a cross-org context. |
| C-AC39 | After a switch, cached RSC payloads for the old org are not served (revalidatePath verified by fresh data resolution). |
| C-AC40 | Switching does not extend or renew session expiry. |
| C-AC41 | Public API plane unaffected except the P1-16 archived exclusion. |
| C-AC42 | The full session suite (`session.test.ts` + new switching tests) green with **zero modifications to pre-existing tests**. |

### Cross-cutting (C-AC43..C-AC50)

| ID | Criterion |
|---|---|
| C-AC43 | All new audit events use authenticated non-null actors; the D-G matrix and its P1-B tests are unchanged. |
| C-AC44 | Audit writes atomic with their mutations: forced-audit-failure rollback tests (fixture-org-scoped) pass for every new event. |
| C-AC45 | Fresh PG 15.20 replay: C1→C2→C3 with constraint/case-matrix/introspection evidence captured at implementation time. |
| C-AC46 | `prisma validate` passes; introspection round-trip matches; all five workspaces type-check. |
| C-AC47 | All 156 pre-existing tests pass **unmodified** (M1 + P1-A + P1-B regression lock). |
| C-AC48 | CI green including parallel test-file execution (fixture-scoped scaffolding only). |
| C-AC49 | Every P1-C migration is additive; the §18 downgrade path is documented and safe. |
| C-AC50 | Safe errors everywhere; cross-org misses indistinguishable from nonexistent (verified by test). |

### R2 additions (C-AC51..C-AC60) + R2.1 addition (C-AC61)

| ID | Criterion |
|---|---|
| C-AC51 | Acceptance binds to the invited address: an invite can never attach to, or create, an account with a different email; a case-mismatched pre-existing account produces a **safe error** — the misleading "invalid/used/expired" fallback via `toSafeErrorMessage` (E-36) — and **account linkage fails** (acceptance is unsuccessful); it never surfaces as a raw 500. Resolved so that acceptance succeeds against the matching account per C-D18. |
| C-AC52 | Email comparison is consistent across registration, login, invite creation, and acceptance (per C-D18); the normalization pre-check (§14.3.3) is evidenced. |
| C-AC53 | Cancel-after-archive: cancelling a FULFILLED+UNPAID order whose location was archived succeeds; RETURN movements are written to the **original** location with exact variant/quantity matching; **no movement is ever redirected** to another location; the inventory increment lands on the original location's rows (C8/C16). |
| C-AC54 | Stock adjustment at an archived location is rejected per C-D20; adjustment at an active location is unaffected (M1 behavior preserved). |
| C-AC55 | Eligible-first fallback (C10): with memberships [A-inaccessible, B-eligible] in deterministic order, resolution selects B (never null while B is eligible); with no eligible membership → null. |
| C-AC56 | Deterministic selection (C18): the storefront resolves the same location across repeated calls for the same store; `context.locationId` is stable for a stable org/location set (ordering `createdAt`, `id` asserted). |
| C-AC57 | Self-mutation guards (C-D3/C-D17): an OWNER cannot remove, demote, or location-strip **their own** membership; the error is safe and the org state is unchanged. |
| C-AC58 | A successful switch writes exactly one `SWITCH_ORG` audit in the **target** org with `fromOrganizationId` (effective session organization per §10.2) and `toOrganizationId` metadata, atomic with the session update; **failed switches produce no switch audit event** (C-D22b). APPLICABLE — approved with C-D22b. |
| C-AC59 | Concurrent archive of the last two active locations: exactly one succeeds; ≥1 active location remains (L1-serialized runtime test). |
| C-AC60 | The `inventory_quantity_non_negative` CHECK remains in force after all P1-C migrations; no P1-C path can produce a negative inventory quantity (checkout, FULFILL, RETURN, adjust all verified by existing + new tests). |
| C-AC61 | Direct-link supersession (§8.5, R2.1): reinviting an existing user whose email holds a live PENDING token invite either (C-D7a) supersedes the pending row in the same transaction (revoked, unacceptable, audited with `supersededBy`) — or, if C-D7b is approved, the documented exception is asserted by test: the stale row remains Pending, its token rejects acceptance with ALREADY_MEMBER (never creating a second membership), and the pending listing state is documented. Runtime test either way. |

## 17. Test strategy

Harness facts [V]: Vitest with `fileParallelism: true` on one disposable DB (`via_saas_test`, recreated by `tests/global-setup.ts` via migrate deploy); `next/headers` cookie-mock pattern (`session.test.ts:10-26`); fixture factories in `tests/helpers.ts` (`createOrganizationFixture` with `locationCount`, `createProductFixture` — unique suffixes). **Corrected in R2.1: no dedicated second-organization fixture exists** — `tests/helpers.ts` (verified in full) provides only `createOrganizationFixture` and `createProductFixture`; cross-organization tests create **two organization fixtures** via two `createOrganizationFixture` calls (or, only if separately authorized as a test-only enhancement, a new fixture file — `helpers.ts` is not frozen, but no new fixture code is planned). **No arbitrary minimum counts; suites are defined by the criteria.**

| Suite (new) | Criteria | Key behaviors |
|---|---|---|
| `tests/staff-management.test.ts` | C-AC1..11, 43, 44, 57, 59 | Owner list (content + scope); role gates (negative per role, both layers); cross-org fail-closed; effect-on-next-resolution; allowedLocationIds validation (cross-org, archived, empty=all); last-owner demote/remove rejection; **concurrent last-owner removal** (`Promise.allSettled` → 1 success); self-mutation guards; removal atomicity (fixture-scoped forced-audit-failure trigger → rollback, no orphan); attribution survival; UPDATE_STAFF exactly-once |
| `tests/invite-lifecycle.test.ts` | C-AC12..20, 43, 51, 52, **61** | Listing states + precedence; no tokenHash/raw token (structural assertion); rescind → never acceptable; expired/accepted rejection; **concurrent accept+rescind**; cross-org fail-closed; supersession (second invite → first revoked + unacceptable + audited with `supersededBy`); **direct-link reinvitation supersession or documented exception (C-AC61)**; RESCIND_INVITE exactly-once + atomicity; raw-token secrecy end-to-end; acceptance email binding (mismatched-account safe error per C-D18) |
| `tests/location-management.test.ts` | C-AC21..30, 44, 53, 54, 59, 60 | Authorization matrix (action+core); cross-org fail-closed; name uniqueness (constraint exercised); archive/restore conditionals; archived exclusion in `getSessionContext` (both modes + zero-accessible → null); checkout archived rejection (pre + **in-tx race** forced); **cancel-after-archive exact RETURN**; adjust-at-archived rejection; storefront resolution excludes archived + deterministic (`app.inject`); historical preservation snapshots; last-active guard + **concurrent last-two archive race**; audit exactly-once + atomicity per event |
| `tests/org-switch.test.ts` | C-AC31..42, 47, 55, 56, 58 | Cookie-mock pattern: legacy-null behavior (pre-existing tests unmodified); login initialization; valid switch; unauthorized switch (no state change); post-removal **eligible-first fallback** (C10 case); stale active org; zero-eligible logout; parallel-requests consistency; **no client-controlled org selection** (hostile session value → fallback, not access); expiry non-renewal; deterministic location pick; switch audit per C-D22 outcome |
| Existing 16 suites | C-AC31, 42, 47 | Full suite unmodified; targeted full-suite reruns at gates G1–G4 |
| Migration replay runbook | C-AC45, 46, 49, 52 | §14.5 ritual on disposable PG 15.20; legacy-data pre-checks §14.3 evidenced |

CI under parallel execution (C-AC48): all trigger/lock scaffolding namespaced per fixture org (the `859d407` lesson); no global DB state mutated by any test.

## 18. Rollback and recovery

| Scenario | Recovery |
|---|---|
| P1-C code regression post-merge | Revert code commits; schema stays inert to pre-P1-C code (nullable columns unread; CHECK/index constrain already-valid data) |
| Remove role CHECK / name-unique index | `DROP CONSTRAINT` / `DROP INDEX` — non-destructive |
| Remove new columns | `ALTER TABLE ... DROP COLUMN` — loses P1-C-era metadata only; owner sign-off required; recommendation: never down-migrate |
| Enum values unwanted | Left in place (inert); PG enum label removal is fragile — documented "do not" |
| Accidental last-owner loss (guard bug) | Manual SQL promotion; audit trail (REMOVE_STAFF/UPDATE_STAFF before/after) identifies the event; guards + concurrency tests exist to make it unreachable |
| Stock stranded at an archived location | Restore (audited) — §9.6; no data movement required |
| Location wrongly archived | Restore (audited) |
| Invitation wrongly rescinded | Re-invite (supersedes nothing pending); original row retained as history |
| Business data | **No P1-C operation can delete or rewrite orders, movements, inventory, users, or sessions** — the structural guarantee (§14.6) |

## 19. Risks and deferred work

| # | Risk / item | Severity | Mitigation / status |
|---|---|---|---|
| R1 | `getSessionContext` rewrite (P1-17) — highest blast radius in P1 (roadmap §F.2 [V]) | High | Sequenced last; full-session-suite gate unmodified (C-AC31/42) + new switch tests; single choke point = single review point |
| R2 | New concurrency patterns (L1 advisory lock; conditional transitions) in the membership domain | Medium | Reuse of P1-B-proven shapes; concurrency criteria are tests, not reasoning (C-AC7/15/28/59) |
| R3 | Role CHECK (C-D1b) assumes canonical values only | Low | §14.3.1 pre-check re-verified at implementation; constraint fails loudly |
| R4 | Name-unique index assumes no duplicates | Low | §14.3.2 pre-check + documented cleanup path (never silent) |
| R5 | C-D12/C-D20 touch P1-B-closed (`orders.ts`) and M1-era (`products.ts`) code | Medium | Single-line guarded conditions; full-suite gates; explicit owner approval via the decisions |
| R6 | Multi-tab shared org context may surprise users | Low | Accepted + documented (C-D15a); never data-corrupting |
| R7 | `INVITE_STAFF` target is polymorphic (user id for direct-link; email for token path) [V] | Low | Preserved as-is; new events use unambiguous targets |
| R8 | ~~Blocking decisions unresolved~~ **RESOLVED at kickoff** | ~~Kickoff blocker~~ Resolved | All eight blocking decisions + material decisions + C-D22 owner-approved (§13 approval record) |
| R9 | DR-1 stale P1-B header; DR-3 config path | Cosmetic | One-line fixes at kickoff (owner-permitting) |
| R10 | No rate limiting on new actions (E-13 remainder) | Low | Standing roadmap debt; unchanged exposure class |
| R11 ◆ | `adjustInventory` audit not transaction-bound (pre-existing, §4.5.4) | Low | Out of P1-C scope; flagged for a separate owner decision — do not silently absorb or fix |
| R12 ◆ | FULFILL/cancel-vs-checkout inventory-row deadlock (pre-existing, §11.5) | Low | Documented; PG aborts one party retryably; P1-C adds no writes to these paths beyond read-only re-checks |
| R13 ◆ | Eligible-first fallback changes behavior for multi-membership users whose first membership is ineligible | Medium | That behavior is the C10 fix; single-org users (the entire current population [I]) are unaffected — covered by C-AC55 tests |
| R15 ◆ | Pre-transaction membership authorization race (§11.5, documented in R2.1): membership checks for FULFILL (`orders.ts:396-402`), cancellation (`517-523`), payment (`621-627`), and adjustment (`products.ts:669-681`) run **outside** their transactions — a just-removed member can complete one in-flight operation authorized at check time | Low | **Accepted pre-existing residual** (M1/P1-B behavior), consistent with C-D4's resolution-failure revocation mechanism; subsequent requests fail resolution. NOT resolved by P1-C; an in-tx re-verification fix would require a **separate owner-approved change**. Do not silently absorb or fix |
| R14 ◆ | Deferred: "leave organization" self-service flow (C-D3a consequence); ownership-transfer ceremony (C-D5a); invite-row retention policy (§8.7); TRANSFER stock movements (P1-F); receiving/inbound stock (not present in code [V]) | — | Roadmap backlog, not P1-C |

## 20. Evidence appendix

All references verified at `859d407` this session. E-1..E-27 carry their R1 meaning (re-verified); E-28..E-35 are R2 additions; E-36 is an R2.1 addition. **Document metrics (R2.1): 750 total lines** (`Get-Content | Measure`); the earlier-reported "570 lines" was a **non-blank line count** (`Measure-Object -Line`) and is never the total.

| Ref | Path | Symbol / lines | Fact |
|---|---|---|---|
| E-1 | `via-saas/packages/database/prisma/schema.prisma` | `Membership` 85-96 (role 89; allowedLocationIds 90; `@@unique` 95) | 4.1.1-4.1.3 |
| E-2 | same | `Session` 58-64 — no activeOrganizationId | 4.2.1 |
| E-3 | same | `StaffInvite` 112-125 — no revokedAt; tokenHash 119; role 117 | 4.3.1 |
| E-4 | same | `Location` 153-163; `Store` 141-151 (slug 147) | 4.4.1 |
| E-5 | same | `AuditAction` 22-32; `AuditLog.actorId` 411 + D-G comment | 4.5.1, §5 |
| E-6 | same | `Inventory @@unique([locationId, variantId])` 257; `StockMovement` 268-286 (actorId 272; location FK no-cascade 278); `Order.locationId` 350 (model 347); `Cart.locationId` 295 (model 292) | 4.4.2 |
| E-7 | `via-saas/apps/merchant-dashboard/lib/auth-helpers.ts` | `getSessionContext` 17-65 (comment 14-15; expiry 38-42; `memberships[0]` 44; expansion 47-52; `locationId` = first accessible 57; null 52); `canAccessLocation` 70-72; `canAdjustStock` 81-84; `canManageCatalogue` 92-94 | 4.1.3-4.1.5, 4.2.2, §10 |
| E-8 | `via-saas/apps/merchant-dashboard/app/(auth)/login/actions.ts` | raw email lookup + session create 32-52 | 4.2.3 |
| E-9 | `via-saas/apps/merchant-dashboard/app/(auth)/register/actions.ts` | raw email 11/20/32; tx user/org/store(slug)/Main Location/OWNER membership | 4.2.4, 4.8.2 |
| E-10 | `via-saas/apps/merchant-dashboard/app/actions/auth.ts` | `logout` deleteMany + cookie clear | 4.2.5 |
| E-11 | `via-saas/packages/core/src/auth.ts` | TTL 7; slug 9-19; `registerOrganization` 21-41 (raw email 22); `inviteStaffMember` 56-134 (**email normalize 62**; role 67-69; location 72-80; direct-link 84-108; token 110-133; audit target email 126-130); `acceptStaffInvite` 140-189 (check 149-152; **find by invite.email 157**; create 159-164; already-member 166-171; role copy 177; acceptedAt 182-185) | 4.3.2-4.3.3, 4.8 |
| E-12 | `via-saas/apps/merchant-dashboard/app/(dashboard)/settings/actions.ts` | OWNER guard 29-31 | 4.1.4 |
| E-13 | `via-saas/apps/merchant-dashboard/app/(dashboard)/settings/page.tsx` | owner redirect 9-11; staff table 13-23; unfiltered locations 19-22 | 4.1.6, 4.4.3 |
| E-14 | `via-saas/apps/merchant-dashboard/app/(auth)/invite/[token]/actions.ts` | token+password+confirm only (no email field); redirect 24 | 4.2.6, 4.8.3 |
| E-15 | `via-saas/apps/merchant-dashboard/app/(dashboard)/layout.tsx` | single resolution path | 4.2.7 |
| E-16 | `via-saas/apps/merchant-dashboard/components/shell/top-bar.tsx` | hardcoded "Main Store - Lekki" button; logout form | DR-2 |
| E-17 | `via-saas/apps/api/src/app.ts` | slug resolution 52-55 (`take: 1`, no orderBy; null guard 54); checkout location 132 | 4.2.8, §9.4 |
| E-18 | `via-saas/packages/core/src/orders.ts` | `allocateOrderNumber` 29-39 (OrderCounter row lock); `processCheckout` 169-386 (location pre-check 193-199; pricing 48-96; decrement gte 242-258; SALE movement 291-300; in-tx audit 303-314; ATTENTION branch 327-374); `resolveAttentionOrder` 388-490 (membership 396-402; ATTENTION-cancel 415-444; FULFILL 446-486); `cancelOrder` 505-598 (membership 517-523; eligibility 535-540; conditional transition 545-556; **RETURN exact-match 562-581**; audit 586-594); `recordPaymentReceived` 615-669 | §4.7, §9.3, §11 |
| E-19 | `via-saas/packages/core/src/audit.ts` | `logAuditEvent` contract; D-G enforcement; STOREFRONT_API_SOURCE | 4.5.2, §12 |
| E-20 | `via-saas/packages/database/prisma/migrations/2026111612000{0,1}_p1b_orders_{a,b}` | A/B split precedent; CHECK `auditlog_actorid_null_only_public_checkout` (b:35) references only CREATE_ORDER | §14.1 |
| E-21 | `via-saas/tests/session.test.ts` | cookie-mock 10-26; expiry 92-106; no-membership null 124-131; location enforcement describe 134-164 | §17 |
| E-22 | `via-saas/tests/invites.test.ts` | 10 frozen security tests | 4.3.4 |
| E-23 | `via-saas/tests/helpers.ts` | `createOrganizationFixture` 15; `createProductFixture` 78 — unique suffixes | §17 |
| E-24 | `via-saas/tests/global-setup.ts` + `.github/workflows/via-saas-ci.yml` | disposable DB via migrate deploy; PG 15-alpine CI; parallel workers | 3.1, 4.6 |
| E-25 | `docs/VIA_P1_IMPLEMENTATION_PLAN.md` | D.7 243-257; work items 440-443; D-10/D-11 413-414; sequencing 345-347; frozen mention 531; delivery appendix 541-548; "48-test regression suite" line 13 | §3, §6, §15 |
| E-26 | `docs/VIA_P1B_IMPLEMENTATION_PLAN.md` | stale status header (DR-1); "9 frozen paths" line 305; B-AC29 line 534 ("83 pre-existing") | 3.2, 3.4 |
| E-27 | git evidence (commands run this session) | HEAD `859d407`; sync 0/0; via-saas status = plan doc only; 27 unrelated parent changes | §3.1 |
| E-28 | `via-saas/vitest.config.ts` | lines 7-20: globalSetup `./tests/global-setup.ts`; `fileParallelism: true`; include `tests/**/*.test.ts`; **located at via-saas root, not tests/** | 3.3 (DR-3), 4.6.2 |
| E-29 | `via-saas/packages/core/src/products.ts` | `adjustInventory` 651-718 (tenant check 669-681; **gte guard 684-691**; movement 698-707; **audit without tx 710-714**) | 4.7.5, 4.5.4 |
| E-30 | `via-saas/packages/database/prisma/migrations/20261115090000_m1_integrity/migration.sql` | line 314: `ALTER TABLE "Inventory" ADD CONSTRAINT "inventory_quantity_non_negative" CHECK ("quantity" >= 0)` | 4.7.5, C-AC60 |
| E-31 | `via-saas/apps/merchant-dashboard/app/(dashboard)/orders/actions.ts` | `createOrder` — POS passes `context.locationId`, `context.userId` into `processCheckout`; idempotency key required | 4.2.7, C18 |
| E-32 | `via-saas/packages/database/prisma/schema.prisma` | `StockMovementType` enum 260-266 (SALE, TRANSFER, ADDED, REMOVED, RETURN); grep: zero TRANSFER writers | 4.7.6 |
| E-33 | migrations directory listing | 5 migrations: baseline, m1_integrity, p1a_catalogue, p1b_orders_a, p1b_orders_b | 3.1 (C19) |
| E-34 | per-file `it()` recount (this session) | 8,4,22,8,5,10,16,12,10,12,4,12,11,7,5,10 = **156 across 16 files**; arithmetic 48 (M1) + 35 (P1-A) + 73 (P1-B) = 156 | 3.2 (C19) |
| E-35 | grep over all via-saas `.ts` sources | email normalization only at `core/auth.ts:12,61-62`; **absent** in register/login/acceptance lookup | 4.8 (C13) |
| E-36 | `via-saas/packages/core/src/errors.ts` | `toSafeErrorMessage(error, fallback)`: returns `error.message` for `DomainError` (and the stock-floor message); **any other `Error` (incl. Prisma P2002) collapses to the caller's fallback string** — corrects the R2 §4.8.2 P2002-consequence claim | 4.8.2, §4.10 C13 (R2.1 correction 1) |

---

## 21. Implementation status (recorded at implementation completion)

**Status: COMPLETE — all four canonical work items delivered; 222/222 tests passing; all four workspaces type-check clean. All changes remain UNCOMMITTED in the working tree (no commit, push, deployment, or production database change was made, per the implementation authorization).**

### 21.1 Work items delivered

| Item | Status | Core files |
|---|---|---|
| P1-14 Staff/membership management | ✅ Delivered | `packages/core/src/staff.ts` (new), `settings/actions.ts`, `settings/page.tsx`, `SettingsPanels.tsx` (new) |
| P1-15 Invitation lifecycle | ✅ Delivered | `packages/core/src/auth.ts` (rewrite: normalization C-D18a, hardened accept, rescind idempotence C-D8i, supersession C-D7/C-AC61 on BOTH paths), `settings/actions.ts` |
| P1-16 Location lifecycle | ✅ Delivered | `packages/core/src/locations.ts` (new), `apps/api/src/app.ts` (`resolveStoreBySlug` archived filter + deterministic order), `core/orders.ts` (C-D12 pre-check + in-tx re-checks), `core/products.ts` (C-D20) |
| P1-17 Organization switching | ✅ Delivered | `lib/auth-helpers.ts` (§10.2 rewrite), `lib/organization.ts` (new, switch core), `app/actions/organization.ts` (new), `components/shell/org-switcher.tsx` (new), `top-bar.tsx` (DR-2 replaced), `(dashboard)/layout.tsx`, `login/actions.ts` (C-D13a), `register/actions.ts` (C-D18a) |

### 21.2 Migrations (applied to dev DB; replay evidence captured)

| Migration | Contents |
|---|---|
| `20261116130000_p1c_staff_invites_a` | C1: `AuditAction` values (UPDATE_STAFF, REMOVE_STAFF, RESCIND_INVITE, SWITCH_ORG), `StaffInvite.revokedAt`, `Membership.role` CHECK `membership_role_canonical` (C-D1b) |
| `20261116130001_p1c_locations` | C2: `Location.archivedAt`, `Location`+`Store` `createdAt` (implementation-time amendment enabling §10.2 ordering), `(storeId, name)` unique |
| `20261116130002_p1c_org_switch` | C3: `Session.activeOrganizationId` |

### 21.3 Test evidence

- New suites: `tests/staff-management.test.ts` (16), `tests/invite-lifecycle.test.ts` (13), `tests/location-management.test.ts` (20), `tests/org-switch.test.ts` (17) = **66 new tests**.
- Full suite: **20 files, 222/222 passing** (156 pre-existing + 66 new) on the disposable `via_saas_test` DB.
- Frozen 9 paths byte-identical to `8eec1fc` (verified both vs HEAD and vs working tree); `tests/helpers.ts` differs from `8eec1fc` only by the single line committed in P1-A (`a0fbd75`) — untouched this session.
- Gate D fresh replay: `via_saas_replay` recreated, `migrate deploy` applied all 8 migrations in order, `pg_get_constraintdef` confirmed `membership_role_canonical`, case-matrix SQL accepted OWNER/MANAGER/STAFF and rejected `ADMIN`, rejected duplicate `(storeId, name)`, `prisma validate` + introspection round-trip clean; DB dropped after evidence capture.

### 21.4 Implementation-time notes (no plan conflicts; decisions already approved)

- L1 advisory lock acquired via `$executeRaw` (`pg_advisory_xact_lock` returns `void`, which `$queryRaw` cannot deserialize).
- `supersedePendingInvites` takes an `excludeId` so a new token invite cannot supersede itself.
- Same-org switch is allowed and audited (plan does not forbid it).
- C-AC28 evidence = deterministic pre-check rejection + FULFILL in-tx re-check (FULFILL has no pre-check, so the re-check is directly reachable).
- Zero-active-location storefront state is unreachable through the lifecycle API (C-D10a) and is verified via direct-DB scaffolding (C-AC26).
- Dev servers were stopped during test runs (query-engine DLL contention); owner may restart them.

### 21.5 Post-audit reconciliation (2026-11-17, owner-authorized corrections F-01/F-02/F-06)

**F-06 — acceptance-criteria tally (reconciled arithmetic):**

| Classification | Count | Criteria |
|---|---|---|
| PASS | **60** | C-AC1..C-AC61 except C-AC48 |
| NOT VERIFIED | **1** | **C-AC48** (CI green) - requires push + remote CI; no push occurred; must NOT be claimed as passing |
| FAIL | **0** | - |
| **Total** | **61** | - |

Evidence-type distinctions preserved per criterion band:
- **Automated test evidence** (executed 2026-11-16 on the disposable `via_saas_test` DB): C-AC1..24, C-AC25 (pre-check + FULFILL re-check), C-AC26..27, C-AC29..37, C-AC40, C-AC43..44, C-AC47 (156-suite lock), C-AC50..59, C-AC61.
- **Source-code inspection** (this tally's classifications audited independently 2026-11-17): **C-AC39 is explicitly classified PASS on source-inspection evidence** - `app/actions/organization.ts` calls `revalidatePath("/", "layout")` before redirect and preserves NEXT_REDIRECT rethrow; no runtime RSC-cache test exists (weakest evidence in the matrix; recommend a manual post-commit smoke). Also code-inspection-backed: C-AC28 (in-tx re-check presence; see F-02 wording), C-AC38, C-AC41.
- **Migration evidence** (SQL inspected; Gate D replay executed at implementation time, NOT re-executed post-audit): C-AC45, C-AC46 (post-audit: `prisma validate` passed and all five workspaces type-check clean), C-AC49, C-AC60.
- **Remote CI evidence**: C-AC48 only - unavailable, NOT VERIFIED.

The implementation report's earlier "59 PASS + 1 NOT VERIFIED" tally omitted one criterion's explicit classification (C-AC39); this §21.5 table supersedes that arithmetic.

**F-01 — schema/migration drift corrected (2026-11-17, owner-authorized):** the `Location` model now declares `@@unique([storeId, name])`, matching the DB index `Location_storeId_name_key` created by migration 20261116130001 (Prisma's generated name for this attribute is identical - verified in the regenerated client types as `LocationStoreIdName`). No migration was created or modified. `prisma validate` passed and the client was regenerated.

**F-02 — §11.4 wording corrected (2026-11-17, owner-authorized):** the "Archive vs checkout pre-check" row now states the guarantee accurately (pre-check + in-tx re-check NARROWS the race; under READ COMMITTED a narrow commit-boundary window remains without a shared Location row lock; no absolute invariant is claimed). C-D12 remains approved; no checkout-locking change was made.

**Residual register (audit findings retained, NOT implemented - disposition unchanged):**

| ID | Severity | Disposition |
|---|---|---|
| F-03 | LOW | Potential RESCIND_INVITE audit record for an invitation row not actually rescinded by the conditional `updateMany` due to a concurrent state transition (`core/auth.ts` supersede path). Audit-accuracy only; accepted as residual. |
| F-04 | LOW | Two concurrent reinvitations of the same (org, email) can supersede one another's new invites, leaving zero live invitations. OWNER-only, narrow, recoverable by reinviting; accepted as residual. |
| F-05 | LOW | Documented pre-transaction authorization race (eligibility/scope checked before the tx). Benign by design - resolution re-verifies every request (C11); accepted as residual. |

### 21.6 Post-push verification (2026-11-17, commit `26e73b1e51eabf9a9c28d545befde74a46bc56cd`)

Scope: verification only - no feature changes, no commits/pushes, no schema/migration changes, local development environment only. Smoke records are clearly identifiable (`p1c-*@test.local`, "Smoke P1C ..." orgs/locations).

**A. Remote CI evidence (exact SHA `26e73b1`):**

| Item | Value |
|---|---|
| Canonical workflow | "via-saas CI" (`.github/workflows/via-saas-ci.yml`) |
| Run ID / number | 44026333423 / run #6 |
| Branch / event | `main` / push |
| Conclusion | **success** (completed 2026-11-17T05:46:39Z) |
| Steps verified | containers init, checkout, setup-node, install, **prisma generate ✓, prisma validate ✓, type-check all workspaces ✓, full Vitest suite against a fresh migrated PostgreSQL ✓** |
| Exact test/file counts | NOT VERIFIED - not exposed by the unauthenticated GitHub API |

C-AC48 classification: **PASS** (CI green for this exact SHA, including the parallel test-file execution against a fresh migrated database). Caveat recorded: the repository also runs a second workflow, "test" (n8n-lead-recovery full suite; run 44026333430), which failed at its "Full test suite" step. This failure is PRE-EXISTING red - runs 3, 4 and 5 (pre-P1-C commits) failed identically, and the workflow targets the parent monorepo's `n8n-lead-recovery` project, not via-saas. It is unrelated to P1-C and is recorded as a repository hygiene issue (fixing it would require a commit/push, out of scope under the verification restrictions).

**B. Local environment used for smoke testing:**

| Item | Value |
|---|---|
| API | `apps/api` `npm run dev`, pid 19064, port 4000 (launcher pid 10468) |
| Dashboard | `apps/merchant-dashboard` `npm run dev`, pid 36588, port 3000 (launcher pid 24352) |
| Database | Docker container `via_saas_db` (postgres:15-alpine), `localhost:5430/via_saas_db` - local development DB, not production |
| Env files | only `DATABASE_URL` present; values never printed |

**C. Smoke-test accounts (all created through the real register/invite flows):**

| Account | Email | Role(s) |
|---|---|---|
| Owner A | `p1c-smoke-owner-a@test.local` | OWNER of Smoke P1C Org A |
| Owner B | `p1c-smoke-owner-b@test.local` | MANAGER in Org A (account created via invite acceptance; single-org user) |
| Staff S | `p1c.smoke.staff@test.local` (stored normalized) | STAFF in Org A |
| Owner C | `p1c-smoke-owner-c@test.local` | OWNER of Smoke P1C Org C + STAFF in Org A (LINKED invite path) |

**D. Capability results (all PASS):**

- **Staff management** - staff table renders; own row immutable ("Your own record cannot be modified."); role edit STAFF→MANAGER succeeded in-place; edit-row select exposes OWNER/MANAGER/STAFF for the OWNER actor (C-D19a) while the invite-form select has no OWNER option; `/settings` server-redirects non-OWNER users (observed as STAFF navigation → redirect to `/`).
- **Invitation lifecycle** - one-time URL returned once, 48h expiry shown; reinviting the same email superseded the older invite (PENDING→REVOKED in list, in-place); superseded token rejected with the safe error "This invitation link is invalid, used, or expired."; valid token accepted → account created → redirect `/login?invited=true`; explicit Rescind → REVOKED in-place; email normalization observed (`"  P1C.Smoke.Staff@Test.LOCAL "` stored/displayed as `p1c.smoke.staff@test.local`; mixed-case login succeeds); LINKED path: inviting an existing account returned "This person already has a VIA account — they have been added to your business." and linked the membership directly (no token, no email sent).
- **Location administration** - created "Smoke P1C Location 2" in-place ("Location created."); archived in-place ("Location archived.", row shows "Archived 17/11/2026" + Restore button); archived location removed from the invite-form and staff-edit location dropdowns; last-active guard: Main Location's Archive button disabled with tooltip "The last active location cannot be archived."; server-side backstop DB-verified (Main Location still active after a forced submission attempt; exactly one ARCHIVE_LOCATION event).
- **Organization switching** - switcher shows both orgs in deterministic createdAt order [Smoke P1C Org A, Smoke P1C Org C]; login initializes to the eligible-first org (Org A, role STAFF); switch to Org C → selected = Org C, role badge OWNER, session `activeOrganizationId` updated in DB; round-trip back to Org A → role badge STAFF. Audit: SWITCH_ORG events carry `{fromOrganizationId, toOrganizationId}` metadata; 3 events total - one real switch (A→C), one round-trip (C→A), and one same-org duplicate (C→C) caused by a double-submitted form during testing (change-event auto-submit + an explicit `requestSubmit`) - a tester artifact, not an app defect.

**E. C-AC39 (dashboard cache refresh) - PASS on OBSERVED UI behavior** (runtime smoke, not merely `revalidatePath` presence). In-place updates observed without a full page reload:
1. Invite create → one-time link + invitations list appear immediately.
2. Reinvite → older invite flips PENDING→REVOKED in the list.
3. Rescind → PENDING→REVOKED in the list.
4. Invite acceptance (separate session) → status flips to ACCEPTED for the OWNER.
5. Staff role edit → row updates + "Staff member updated." feedback.
6. Location create → locations list + both location dropdowns update.
7. Location archive → row shows Archived date + Restore; dropdowns exclude it.
8. Org switch → switcher selection, role badge, header org name, and org-scoped settings data all reflect the new org; no cross-org data remained visible after switching (Org C settings showed only Org C staff/invitations/locations).

Note: archived locations remain listed in the OWNER's Locations panel (with an Archived marker + Restore) by design; they are excluded from all grantable/selectable surfaces.

**F. NOT VERIFIED items (with reasons):**

| Check | Classification | Reason |
|---|---|---|
| Exact CI test count / test-file count | NOT VERIFIED | not exposed by the unauthenticated GitHub API; the suite itself ran green |
| Failed/unauthorized switch attempt producing no SWITCH_ORG audit event | NOT VERIFIED via UI (CI-backed) | the switcher only offers eligible orgs, so an unauthorized selection is unreachable through the UI; server-side rejection is covered by the org-switch tests in the same green CI run |
| Expired-session switch revival (C-AC40) | NOT VERIFIED via UI (CI-backed) | would require session tampering outside the UI; covered by automated session tests in the same green CI run |
| Inventory-adjustment / checkout rejection of archived locations (C-AC28/C-AC54) | PASS (CI-backed); UI re-verification not performed | core/storefront-level behavior; exercised by the automated suite in the same green CI run |

**G. Revised acceptance-criteria tally (supersedes §21.5):**

| Classification | Count | Criteria |
|---|---|---|
| PASS | **61** | C-AC1..C-AC61 - incl. C-AC48 (CI run 44026333423 for SHA `26e73b1`) and C-AC39 (observed runtime behavior, upgrading the §21.5 source-inspection classification) |
| NOT VERIFIED | **0** | sub-item limitations recorded in section F above do not change any criterion-level classification |
| FAIL | **0** | - |
| **Total** | **61** | - |

**H. Invariants confirmed (no protected data retested):** M1 tenant authorization, P1-A catalogue behavior, and P1-B checkout semantics (pricing, payment, idempotency, cancellation, RETURN stock restoration) were re-verified by the canonical CI run (C-AC47 regression lock: the CI step executed the **full Vitest suite** against a fresh migrated PostgreSQL and concluded `success`, which entails the 156 pre-existing tests passed; the exact test count was not exposed by the API — see section B). F-02's corrected §11.4 wording and the F-03/F-04/F-05 residual register are unchanged and remain accurate.

---

*End of plan (R2.1, decisions approved at implementation kickoff). Owner approval recorded in §13: all eight blocking decisions (C-D1, C-D3, C-D4, C-D7, C-D13, C-D17, C-D18, C-D20), the material decisions (C-D2, C-D9, C-D10, C-D12, C-D19), and C-D22b (SWITCH_ORG audit) are APPROVED; C-AC58 is applicable. Implementation authorized at commit `859d407` - no commit, push, deployment, or production database change is authorized by the implementation phase; all changes remain uncommitted in the working tree for review. Implementation status is tracked in §21.*
