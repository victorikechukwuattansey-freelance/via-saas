# VIA SaaS — Product Blueprint and Development Backlog

**Status:** Authoritative phase deliverable — implementation-ready
**Date:** 2026-11-15
**Prepared from:** Direct repository inspection of `via-saas/` (all source files read; type-checks and Prisma schema validation executed; live local database and running dev servers inspected read-only), plus the prior comprehensive repository audit (findings re-verified against current code — no drift detected).
**Evidence legend:** OBSERVED = directly verified in source or execution this session · INFERRED = concluded from observed code · UNVERIFIED = could not be established (reason stated).

---

## A. Executive Conclusion

### A.1 Current product maturity

VIA SaaS is an **early pre-alpha development foundation**: a working single-tenant demo loop (register → add products → POS sale with atomic stock deduction → order history → analytics) running on a local machine. It is **not** a production-ready merchant platform, and it is not yet mechanically capable of serving more than one merchant end-to-end because the public storefront API is hardcoded to a single organization and location (`apps/api/src/server.ts:18,43–44`).

Maturity by layer:

| Layer | Maturity | Basis |
|---|---|---|
| Data model | Foundation-grade, ahead of the code that uses it | 17-model Prisma schema; `prisma validate` passes (OBSERVED) |
| Business logic (`packages/core`) | Correct patterns, prototype shortcuts | Transactional inventory guard is sound; money and authorization are not server-authoritative (OBSERVED) |
| Merchant dashboard | Usable demo for the happy path | All pages type-check; session guard verified at runtime (OBSERVED) |
| Storefront + API | Demo-grade | Hardcoded org/location, CORS `*`, no cart persistence (OBSERVED) |
| Security / operations | Absent or bypassed | See Section E |
| Testing / CI | None | Zero test files, no CI (OBSERVED) |

### A.2 What has been established (verified)

- The modular monorepo compiles: `npm run type-check` passes across all five workspaces with zero errors (OBSERVED).
- The local Postgres (docker-compose, port 5430) has the full schema applied, including the manual CHECK constraint `inventory_quantity_non_negative` (OBSERVED via `pg_constraint`).
- A seeded organization ("VIA Autos", GROWTH plan), 2 users, 6 orders, 4 products, 3 customers, 1 audit row exist in the dev database (OBSERVED).
- The checkout inventory guard (`updateMany` with `quantity: { gte }` inside `$transaction`, `packages/core/src/orders.ts:19–31`) is a sound optimistic-decrement pattern.
- Session-backed auth, registration, staff invitation, product creation, stock adjustment, ATTENTION-order resolve, analytics, and customers pages exist and are org-filtered on reads (OBSERVED).

### A.3 What remains unproven

- **No feature has ever been exercised by an automated test.** Zero test files exist (OBSERVED).
- **No mutating flow has been runtime-verified** in this phase (POST endpoints were not executed, per audit boundaries). In particular, ATTENTION-order FULFILL is very likely broken at runtime because it writes an invalid `actorId` (see E-3) — the code contradiction is OBSERVED; the runtime failure is INFERRED.
- No production deployment, no CI, no migrations, no backups, no monitoring (OBSERVED absences).
- No customer validation, demand evidence, or revenue — none is claimed anywhere in this document.

### A.4 Should the current architecture be retained?

**Yes.** There is no evidence requiring a rewrite, microservices, a new framework, or a different database (Section H). The workspace layout (`apps/api`, `apps/merchant-dashboard`, `apps/storefront`, `packages/core`, `packages/database`, `packages/ui`), Next.js 14 App Router + Server Actions, Fastify for the public plane, Prisma + PostgreSQL, and the `core`-as-business-logic package are all sound for the target product. The debt is in correctness, authorization, and operations — not architecture.

### A.5 Immediate development priority

**P0 security and correctness remediation (Milestone M1, Section J).** The order is: protect history (git baseline) → remove hardcoded secrets → make money server-authoritative → enforce tenant/location authorization → fix the actor FK defect → add a regression test harness. Feature expansion is explicitly deferred until M1 is done.

---

## B. Product Definition

### B.1 Purpose

VIA is a **merchant operating platform** for small and growing commerce businesses: one place to run catalogue, inventory, sales (POS and online), customers, staff, locations, payments, and reporting — replacing ad-hoc combinations of notebooks, spreadsheets, WhatsApp, and disconnected tools.

### B.2 Target customer segments (working hypothesis — requires validation)

| Segment | Description | Initial fit |
|---|---|---|
| S1 — Single-location retailer | 1–5 staff, mixed POS + WhatsApp/Instagram orders (e.g., phone accessories, fashion, beauty) | Primary candidate; matches current data model (1 org → 1 store → N locations) |
| S2 — Multi-branch SME | 2–10 locations, needs stock transfers and per-location visibility | Secondary; schema supports it, code does not yet |
| S3 — Wholesale/distribution | Suppliers, purchase orders, credit terms | Later-stage |

**These are assumptions, not validated segments.** No customer research has been performed (UNVERIFIED — no evidence exists in this repository or workspace).

### B.3 Primary merchant problems addressed

1. Stock that doesn't match reality (overselling, unrecorded sales, theft/shrinkage).
2. Money that can't be reconciled (cash, transfers, and gateway payments tracked in different places).
3. Orders arriving through too many channels with no unified history.
4. No visibility into what sells, what's low, and who the best customers are.
5. Staff access with no controls or audit trail.

### B.4 Core value proposition (proposed, unvalidated)

"Know your stock, trust your numbers, sell everywhere" — a connected merchant lifecycle where every sale, adjustment, transfer, and payment is one consistent ledger rather than disconnected screens.

### B.5 Nigeria-first requirements

- **Currency:** ₦ (NGN) is hardcoded in every UI surface today (e.g., `app/(dashboard)/page.tsx:71`); a currency setting is required before international use.
- **Payments:** card + bank transfer + USSD are the dominant Nigerian online methods; payment provider selection is an **open decision** (Section I; decision criteria in F.4). No provider is selected in this document.
- **Offline/intermittent connectivity:** Nigerian merchant reality; POS flows should tolerate poor networks (design consideration for P1).
- **Channels:** WhatsApp/DM-originated orders are a first-class sales channel expectation in this market (feature, not integration, in early phases).
- **International expansion:** deferred; requires multi-currency, multi-timezone reporting, and provider coverage per market. Not a current requirement.

### B.6 Assumptions requiring customer validation (explicit register)

| # | Assumption | Risk if wrong | Validation method |
|---|---|---|---|
| AV-1 | Nigerian SMEs will pay for inventory + sales + reporting in one tool | Wrong segment → wasted build | 10–15 structured merchant interviews; competitor trial teardown |
| AV-2 | POS + online storefront in one system is the wedge feature (vs pure bookkeeping) | Building commerce when demand is finance | Interview funnel analysis |
| AV-3 | Staff roles/location permissions matter at this segment's size | Building RBAC nobody uses | Ask about current staff practice |
| AV-4 | Transfer-verified orders (not card checkout) are the primary online flow | Wrong payment UX | Observe real order flow on WhatsApp |
| AV-5 | Willingness to pay supports a subscription model at viable price points | Wrong monetization | Pricing research + trial conversion data (later) |

**Do not treat this roadmap as product-market fit evidence. None exists.**

---

## C. Existing Implementation Inventory

Re-inspected this session (code unchanged since the prior audit — `git status` still shows `?? via-saas/`, and all flagged lines re-confirmed by grep).

### C.1 Authentication and sessions

- **Files:** `apps/merchant-dashboard/app/(auth)/login/actions.ts`, `.../register/actions.ts`, `app/actions/auth.ts`, `lib/auth-helpers.ts`, `app/(dashboard)/layout.tsx`
- **Models:** `User`, `Session`, `Membership`
- **Behavior:** email/password login → bcrypt compare → DB session row (UUID token, 7-day expiry) → httpOnly/sameSite=lax cookie; logout deletes session; `getSessionContext()` resolves session → user → `memberships[0]` → orgId/locationId/role.
- **Verified status:** Type-checks pass; unauthenticated dashboard access redirects to `/login` (runtime-observed). Login/register/checkout POST flows were not executed (audit boundary) — flow correctness is code-verified only.
- **Missing:** password reset, email verification, 2FA, session expiry check inside `getSessionContext` (only the layout checks it, `layout.tsx:33`), expired-session cleanup, org switching (`memberships[0]` is arbitrary, `auth-helpers.ts:27`).
- **Risks:** E-8 (expiry), E-10 (hardcoded credentials), registration logs `DATABASE_URL` to console (`register/actions.ts:8`).

### C.2 Organization, memberships, staff

- **Files:** `packages/core/src/auth.ts` (`registerOrganization` — dead code; `addStaffMember`), `app/(dashboard)/settings/{page.tsx,actions.ts}`
- **Models:** `Organization`, `Membership`, `Store`, `Location`, `ApiKey` (unused)
- **Behavior:** registration transactionally creates user→org→store→"Main Location"→OWNER membership (duplicated in `register/actions.ts:29–59`; the core version is never called). Staff invite creates or reuses a user and attaches a membership with role + `allowedLocationIds`.
- **Verified status:** implemented, unverified at runtime.
- **Missing:** staff edit/remove, password reset for invited staff, business profile settings, location CRUD.
- **Risks:** **hardcoded `password123`** for every invited staff user (`core/auth.ts:34`, advertised at `settings/page.tsx:67`); `allowedLocationIds` stored and displayed but **never enforced** (grep: zero authorization reads); no audit log written for invites.

### C.3 Catalogue and inventory

- **Files:** `packages/core/src/products.ts`, `app/(dashboard)/products/{page.tsx,actions.ts,adjust-actions.ts,AdjustStockForm.tsx}`
- **Models:** `Product`, `ProductVariant`, `Inventory`, `StockMovement`, `AuditLog`
- **Behavior:** create product = transaction creating product + one "Default" variant + inventory row + audit event. Adjust = atomic guarded decrement/increment + movement + audit.
- **Verified status:** implemented; type-checked; not runtime-executed this phase.
- **Missing:** edit/delete, images, categories, true multi-variant flows (UIs always use `variants[0]`), low-stock thresholds (dashboard card is literally "Coming Soon", `(dashboard)/page.tsx:79`), inventory history UI, product status filtering on public reads.
- **Risks:** `costPrice` fabricated as `price * 0.5` (`products.ts:27`); `adjustInventory` performs **no organization/ownership validation** of `locationId`/`variantId` (`products.ts:53–60`) — cross-org adjustment possible in principle (potential vulnerability; requires testing).

### C.4 POS, orders, and ATTENTION resolution

- **Files:** `packages/core/src/orders.ts`, `app/(dashboard)/orders/{page.tsx,actions.ts,list/page.tsx,list/ResolveButton.tsx,resolve/actions.ts}`
- **Models:** `Order`, `OrderItem`, `StockMovement`, `Customer`
- **Behavior:** POS cart in React state → server action → `upsertCustomer` → `processCheckout`: per-item atomic guarded decrement inside `$transaction`; success creates FULFILLED order + items + SALE movements; stock failure creates an ATTENTION order (no stock deducted); resolve = re-deduct (FULFILL) or cancel/refund-status-flip.
- **Verified status:** implemented; type-checked; not runtime-executed.
- **Missing:** payment rails, receipts/invoices, order edit, cancellation outside ATTENTION, pagination, per-location views.
- **Risks:** **client-supplied `price` values define `totalAmount`** (`orders.ts:12`, `orders/actions.ts:8`) — confirmed defect; **random non-unique order numbers** (`orders.ts:39,77`); `resolveAttentionOrder` fetches the order **without an organization filter** (`orders.ts:104–108` — `orgId` param unused); FULFILL writes `actorId: "SYSTEM"` into `StockMovement.actorId`, an FK to `User` (`orders.ts:144` vs `schema.prisma:180`) — likely runtime failure (confirmed contradiction, runtime unverified); same for `"SYSTEM_STOREFRONT"` (`server.ts:57`).

### C.5 Customers

- **Files:** `packages/core/src/customers.ts`, `app/(dashboard)/customers/page.tsx`
- **Models:** `Customer`
- **Behavior:** find-by-phone-then-create upsert (no unique constraint on `(organizationId, phone)`); list page shows name/contact/order count.
- **Verified status:** implemented; duplicate race is a confirmed structural gap (no DB guard exists).
- **Missing:** profiles, purchase history view, segmentation, communication, loyalty.

### C.6 Analytics and reporting

- **Files:** `app/(dashboard)/page.tsx`, `app/(dashboard)/analytics/page.tsx`
- **Behavior:** aggregates on org-filtered orders; top-products computed in JS over all paid order items (no GROUP BY, unbounded memory at scale).
- **Verified status:** implemented for small data; owner-only.
- **Missing:** exports, date ranges, comparison periods, inventory/customer reports.

### C.7 Storefront API (Fastify)

- **Files:** `apps/api/src/server.ts` (81 lines — the entire public plane)
- **Endpoints:** `GET /health` (runtime-verified `{"status":"ok"}`); `GET /api/products` (hardcoded `MOCK_ORG_ID`; runtime-verified returning live data); `POST /api/cart` (mints a token, **never persisted or validated**); `POST /api/checkout` (hardcoded org + location, `"SYSTEM_STOREFRONT"` actor, no validation, CORS `*`).
- **Models written:** `Customer`, `Order`, `OrderItem`, `StockMovement`
- **Verified status:** health + products GET verified running; checkout code-reviewed only (mutating).
- **Missing:** org resolution by store token/subdomain, cart persistence (`Cart`/`CartItem` have **zero code references** and 0 rows in the live DB), draft filtering (`Product.status` never read), rate limiting, input validation, payment verification.
- **Risks:** E-6, E-7, E-12, E-13 below.

### C.8 Database

- **Files:** `packages/database/prisma/schema.prisma` (17 models; `prisma validate` passes), `packages/database/index.ts`, `packages/database/add-constraint.sql`
- **Verified state (live DB, OBSERVED):** all 17 tables exist; the CHECK constraint `inventory_quantity_non_negative` is applied; the only non-PK indexes are unique constraints (no FK/query indexes); the hardcoded org id from `server.ts` exists in the DB.
- **Missing:** migrations directory (`db push` only), unique `(organizationId, phone)` on Customer, unique `orderNumber`, FK/query indexes, soft deletion, audit coverage.
- **Risks:** E-9, E-16.

---

## D. Target Product Capabilities

Legend per capability: **Exists** (today, in code) / **MVP** (required for a commercially viable v1) / **Later** (post-MVP). This is a capability map, **not** an instruction to build everything now.

### D.1 Organization and access management
- Exists: registration → org/store/location/membership bootstrap; membership model with role string.
- MVP: multi-org user support (switcher), business profile settings, org-level settings.
- Later: white-label, multiple businesses per user with billing separation.

### D.2 Store and location management
- Exists: Org→Store→Location created once at registration; inventory is per-location.
- MVP: location CRUD, per-location views and stock, **enforcement of `allowedLocationIds`**.
- Later: warehouses vs storefront locations, stocktake zones.

### D.3 Product catalogue and variants
- Exists: single-variant product creation, SKU, prices, status field (unfiltered).
- MVP: product edit/archive, true variants, categories, images, DRAFT/PUBLISHED enforcement everywhere, duplicate product.
- Later: bulk import/export, barcode printing, collections.

### D.4 Inventory and stock control
- Exists: atomic adjustments + SALE movements, CHECK constraint, per-location stock.
- MVP: inventory history UI, low-stock thresholds + alerts, stock counts (reconciliation), negative-stock policy.
- Later: costing methods (FIFO/weighted average), batch/serial tracking, demand forecasting.

### D.5 Suppliers and procurement
- Exists: nothing (no models).
- MVP (P1): supplier records, purchase orders, goods receiving → inventory + movements.
- Later: PO approvals, supplier performance, backorders.

### D.6 POS and order management
- Exists: POS sale → atomic stock deduction; ATTENTION conflict orders + resolve; order history.
- MVP: complete order lifecycle states (Section F.2), server-authoritative pricing (with explicit merchant-facing price-override policy — open decision), receipts, order search/filters, refunds/cancellations.
- Later: quotations, held orders, split payments, offline mode.

### D.7 Online storefront and checkout
- Exists: single demo page → Fastify checkout; Cart model unused.
- MVP: per-merchant storefront resolution (store token/subdomain — open decision), server-side cart, published-only products, real stock display, order confirmation.
- Later: storefront themes, custom domains, multiple storefronts per org.

### D.8 Payments and financial transaction records
- Exists: nothing. `paymentStatus` (UNPAID/PAID/REFUNDED) is a status field only; TRANSFER creates UNPAID orders with no verification.
- MVP: payment provider integration (Section F.4), server-side verification, idempotent webhooks, unique payment references, payment records ledger, refunds as money movement.
- Later: payouts/settlement reporting, partial refunds, reconciliation tooling, accounting exports.

### D.9 Customer management
- Exists: auto-created customers on checkout; list with order counts.
- MVP: customer CRUD, purchase history view, deduplication guard.
- Later: segments, credit/IOU tracking (a real Nigerian-merchant need — validate first), loyalty.

### D.10 Staff and permissions
- Exists: invite (hardcoded password), roles OWNER/MANAGER/STAFF with coarse backend gates.
- MVP: secure invites (token or one-time password), remove/edit staff, enforced location scoping, permission matrix.
- Later: granular permissions, staff activity reports, shift concepts.

### D.11 Reporting and analytics
- Exists: today's sales, order counts, revenue, top products (in-memory aggregation).
- MVP: date-range filtering, sales/inventory/customer report exports (CSV), per-location reporting.
- Later: cohort/retention, forecasting, benchmarking.

### D.12 Notifications and integrations
- Exists: nothing.
- MVP: transactional email/SMS for invites and receipts (provider choice deferred), payment webhooks.
- Later: WhatsApp integration, accounting integrations (QuickBooks/Xero), public API with the (currently dead) ApiKey model, webhooks, Zapier-class automation, AI-assisted ops.

### D.13 Platform administration and operational controls
- Exists: nothing (no admin plane, no feature flags, no usage metering).
- MVP: internal admin views for support (org/user lookup), plan enforcement hooks (`subscriptionPlan` exists but nothing reads it), rate limiting, structured logging.
- Later: self-serve billing, plan limits, abuse controls.

---

## E. Security and Data Integrity Assessment — Remediation Register

Classifications: **Confirmed defect** (contradiction verified in code) · **Potential vulnerability** (plausible, needs testing) · **Unverified concern** · **Accepted limitation** (deliberate, documented).

| ID | Finding | Evidence (file:line) | Classification | Impact | Required correction | Verification method | Priority |
|---|---|---|---|---|---|---|---|
| E-1 | Client-supplied item prices define order totals | `core/orders.ts:12`; `orders/actions.ts:8`; `server.ts:36` (`items[].price` from request body; `totalAmount` summed from them) | **Confirmed defect** | Any client can post a ₦5,000 item as ₦1; all revenue reporting is untrustworthy | Look up `sellingPrice` server-side from `variantId` inside the transaction; define price-override policy separately (Section I) | Unit test: post price 1 vs DB price 5000 → total = 5000; integration test via API | **P0** |
| E-2 | Staff invitations create accounts with hardcoded `password123` | `core/auth.ts:34`; advertised `settings/page.tsx:67` | **Confirmed defect** | Every invited staff member has a known credential; combined with no reset flow, any invite is a live account | Replace with one-time invite token (or generated one-time password delivered out-of-band) forcing password set on first login | Test: invited user cannot log in with any default password; invite token single-use and expiring | **P0** |
| E-3 | Invalid actor FK values (`"SYSTEM"`, `"SYSTEM_STOREFRONT"`) written to `StockMovement.actorId` (FK → User) | `core/orders.ts:144`; `apps/api/src/server.ts:57` vs `schema.prisma:180` | **Confirmed defect** (contradiction verified; runtime failure INFERRED, not executed) | FULFILL resolution and storefront sales movements will roll back with FK violations | Nullable-system-actor design: add a nullable `isSystem` flag or a real service principal row; never write a fake user id | Integration test: FULFILL an ATTENTION order → StockMovement row created with valid actor semantics | **P0** |
| E-4 | `resolveAttentionOrder` fetches order by id only; `orgId` param accepted but unused | `core/orders.ts:102–108` | **Potential vulnerability** (needs valid order cuid; no cross-org exposure demonstrated) | Cross-org order resolution possible if ids leak | Add `where: { id, organizationId }` and fail closed | Test: resolve another org's order id → not found/denied | **P0** |
| E-5 | `adjustInventory` does not validate location/variant ownership | `core/products.ts:53–60` (`orgId` used only for audit) | **Potential vulnerability** | Cross-org stock manipulation possible if ids leak | Verify `variant → product.organizationId` and `location → store.organizationId` match inside the transaction | Test: adjust another org's variant → denied; same-org other-location → allowed per policy | **P0** |
| E-6 | Storefront API hardcoded to one org/location | `server.ts:18,43–44` (with "PASTE YOUR REAL ORG ID HERE") | **Confirmed defect** (for the multi-tenant premise) | Second merchant impossible; all public traffic writes to one org | Resolve org from a store/public token or subdomain before any operation | Test: two orgs → each storefront endpoint returns/creates only its own data | **P0** |
| E-7 | CORS `origin: "*"` on public API | `server.ts:8` | **Accepted limitation** (self-annotated) — becomes defect at production | Any origin can call the API; combined with no auth it's an open write surface for checkout spam | Allowlist storefront origins via env | Config test: disallowed origin rejected | **P0** (config) |
| E-8 | Session expiry not enforced in `getSessionContext` | `lib/auth-helpers.ts:8–25` (no `expiresAt` check) vs `(dashboard)/layout.tsx:33` (checks it) | **Confirmed defect** (inconsistent enforcement) | Expired sessions authorized wherever the layout guard doesn't run (e.g., server actions reachable without layout re-render paths) | Centralize expiry check in `getSessionContext`; delete expired sessions on access | Test: expired session → every action/page behaves as logged out | **P0** |
| E-9 | Hardcoded DB URL with credentials in source, overriding env config | `packages/database/index.ts:13` ("HARDCODED FOR NOW TO BYPASS GHOST ENV VARS") | **Confirmed defect** | Credential in code; env configuration effectively bypassed | Read `DATABASE_URL` from env only; fail fast if absent; remove `datasources` override | Boot test: server refuses to start without env; grep shows no credentials in source | **P0** |
| E-10 | Registration logs `process.env.DATABASE_URL` (contains credentials) | `register/actions.ts:8` | **Confirmed defect** | Credential leakage into logs | Remove the line | grep: gone; no other env logging | **P0** |
| E-11 | `allowedLocationIds` stored and displayed but never enforced | Grep: only writes (`core/auth.ts:17,53`) and display (`settings/page.tsx:98`) | **Confirmed defect** | Advertised permission model is cosmetic; restricted staff act org-wide | Enforce in `getSessionContext`/`requireLocationAccess`; apply to location-scoped queries and actions | Test: STAFF restricted to location A cannot act on location B data | **P0** |
| E-12 | Public product endpoints do not filter `Product.status` (DRAFT would be exposed) | `server.ts:15–24`; `Product.status` never read (grep) | **Potential vulnerability** (no draft products exist yet) | Draft/unpublished products publicly visible once drafts exist | Filter `status: "PUBLISHED"` (plus org resolution from E-6) | Test: draft product absent from public endpoint, present in dashboard | **P0** |
| E-13 | No request validation; no rate limiting anywhere | `server.ts:36` (`request.body as any`); no zod/valibot; no rate-limit plugin (grep) | **Confirmed gap** | Malformed/b malicious input; unbounded ATTENTION-order creation (rows without stock deduction) | Schema validation on all public endpoints; rate limit `/api/checkout`, `/api/cart`, login/register actions | Test: invalid payloads → 400; burst → 429 | **P0** |
| E-14 | Random non-unique order numbers, no unique constraint | `core/orders.ts:39,77`; `Order.orderNumber` plain `String` (`schema.prisma:243`); live DB shows uniform-random numbers, 0 duplicates in 6 orders | **Confirmed defect** (uniqueness not guaranteed; collision >50% by ~order #118 at 10k values — INFERRED from birthday bound) | Order ambiguity, financial reporting mismatch, no idempotency key | Per-org sequential counter (row/table) or collision-safe generation + `@@unique([organizationId, orderNumber])` | Test: generate N orders in parallel → all distinct within org | **P0** |
| E-15 | Customer find-then-create race; no unique `(organizationId, phone)` | `core/customers.ts:7–13`; schema has no such constraint | **Confirmed structural gap** | Duplicate customer records under concurrency | Add `@@unique([organizationId, phone])` (or nullable-normalized phone) and upsert on conflict | Test: concurrent same-phone upserts → single row | **P0** (with migrations) |
| E-16 | CHECK constraint applied via ad-hoc SQL, not migrations; no migrations directory | `packages/database/add-constraint.sql`; no `prisma/migrations/` (OBSERVED) | **Confirmed defect** (environment reproducibility) | Fresh environments lack the constraint the code relies on (`orders.ts:92–96` comment) | Baseline migrations from current schema; migrate the constraint into the migration history; never `db push` again | `prisma migrate diff` clean against a fresh DB | **P0** |
| E-17 | Audit logging coverage thin | `core/audit.ts` called only for product create/update and resolve; live DB has **1 audit row** vs 6 orders (OBSERVED) | **Confirmed gap** | Staff actions largely unaudited; compliance and dispute risk | Audit all state-changing actions incl. invite, checkout, refund, settings | Test: each action writes exactly one audit row | **P1** |
| E-18 | No tests, no CI | Zero test files; no CI workflows (OBSERVED) | **Confirmed gap** | Every defect above can silently regress | Vitest (+ Playwright later); CI running type-check, lint, unit, integration | CI green on the M1 merge | **P0** |
| E-19 | Whole repository untracked in git | `git status --porcelain` → `?? via-saas/`; 0 tracked files (OBSERVED, re-verified this session) | **Confirmed gap** | No history, no rollback, total-loss exposure | Initialize tracking with a curated `.gitignore` (exclude `node_modules`, `.next`, `*.tsbuildinfo`, `.env`) as M1 prerequisite | `git log` shows baseline commit | **P0** |
| E-20 | Expired sessions never cleaned up | Only deletion path is logout (`app/actions/auth.ts:12–15`) | Accepted limitation (MVP) | Row growth | Cleanup on login or scheduled task | — | **P2** |
| E-21 | `costPrice` fabricated (`price * 0.5`) | `core/products.ts:27` | Confirmed defect (data quality) | Wrong margins everywhere | Make cost price an explicit input | Test: created variant cost equals provided value | **P1** |
| E-22 | Error messages leak internals to API clients | `server.ts:68` returns `error.message` | Potential vulnerability | Info disclosure | Map errors to safe envelopes | Test: generic error body | **P1** |
| E-23 | Fastify plane has no CSRF/origin hardening beyond CORS | `server.ts` (no hooks) | Accepted limitation pending payments | State-changing public endpoint | Origin checks + idempotency keys with payments (F.4) | — | **P2** |

**Not reclassified:** none of the previous audit's 19 findings were resolved in code since the audit — all remain open (re-verified this session by grep and `git status`).

---

## F. Target Domain Workflows

### F.1 Inventory

**State model:** per `(locationId, variantId)` quantity ≥ 0 (DB-enforced).

| Flow | Expected behavior |
|---|---|
| **Stock adjustment** | Actor picks variant + location + signed delta + reason → server validates ownership (E-5) → guarded atomic increment → `StockMovement(ADDED/REMOVED)` with real actor → audit event. Deny if removal exceeds available. |
| **Stock count** | Open count → enter counted qty per variant → variance computed vs system → approve → single corrective `StockMovement(type: REMOVED/ADDED, reference: countId)` → quantity set to counted value. |
| **Low-stock threshold** | Per-variant `lowStockThreshold` (new field) → dashboard banner + report; evaluation at read time (no jobs needed for MVP). |
| **Purchase order** | Draft PO (supplier, location, lines, expected qty/cost) → sent → **goods receiving** creates per-line `StockMovement(ADDED, reference: PO)` in one transaction, updates variant cost, closes/completes PO. Receiving may be partial. |
| **Stock transfer** | Dispatch at location A: guarded decrement + `TRANSFER` movement (out) → transfer state `IN_TRANSIT` → receipt at location B: increment + `TRANSFER` movement (in) → `COMPLETED`; cancellation returns stock to A atomically. |
| **Inventory history** | Append-only `StockMovement` ledger view per variant/location, filterable; every mutation path writes exactly one movement. |

### F.2 Orders

**State machine (target):**

```
DRAFT → PENDING_PAYMENT → PAID ──→ FULFILLED → (COMPLETED)
   │            │              └→ CANCELLED
   │            └→ PAYMENT_FAILED ─→ (retry) 
   └→ CANCELLED
Refund: PAID/FULFILLED → REFUND_PENDING → REFUNDED (money moved, not just status)
Stock: deducted at PAID (POS immediate) or at FULFILLED for attention/transfer flows; ATTENTION retained as an exception state with resolution paths (FULFILL with recheck / CANCEL).
```

Rules:
- Totals computed **server-side only** (E-1). Any merchant price override is an explicit, permissioned, audited act (Section I, open decision).
- Cancellation after payment requires a refund flow, never a bare status flip (current `orders.ts:113–122` behavior is a status flip only — insufficient once real money moves).
- Idempotency: order creation keyed on cart token + idempotency key to prevent double charges (see F.3).

### F.3 Payments

- **Initiation:** order created `PENDING_PAYMENT` → provider transaction initiated with a **unique, collision-safe payment reference** (never the random order number).
- **Server-side verification:** after redirect/timeout, the server queries the provider's verification API — never trusts client claims or redirect parameters.
- **Webhook processing:** signature verification (provider-specific scheme) → idempotent event handling (processed-event ledger keyed on event id) → mark PAID only on verified success events **and** match on amount + currency against the order.
- **Reconciliation:** expected (order total) vs received (provider amount) compared; mismatches flagged for review rather than auto-PAID.
- **Refunds:** initiated server-side via provider API; recorded as movements in a payments ledger; status REFUND_PENDING → REFUNDED.

### F.4 Payment provider decision framework (no selection made)

**No provider is selected in this document.** The prior instructions require documenting criteria and verifying eligibility/pricing/settlement/methods before choosing. Live verification was **not possible in this session** (external web access blocked — see Section K), so the following are the **criteria and verification checklist**, not facts:

| Criterion | What to verify on official documentation |
|---|---|
| Nigerian merchant eligibility | Registration requirements (business documentation, CAC status flexibility), settlement bank support |
| Pricing | % + capped fee per method (card local/international, transfer, USSD); verified against the provider's official pricing page |
| Settlement | T+1 vs T+0, minimum settlement amounts, failure/reversal handling |
| Methods | Card, bank transfer (with name-enquiry/auto-match), USSD, mobile money — coverage and status |
| Technical | API quality: server-side verification endpoint, signed webhooks, idempotency guidance, test-mode support (test keys only in development; rule 8 forbids real transactions), SDK quality for Next.js server actions |
| Operational | Dashboard tooling for disputes/chargebacks, support quality, downtime history |

Candidate providers to verify (official domains, UNVERIFIED this session): Paystack (`paystack.com`), Flutterwave (`flutterwave.com`), plus bank-transfer-native options. Decision recorded in Section I as open.

---

## G. Development Backlog and Sequencing

The provisional P0→P3 sequence is **retained**; the repository evidence supports it (every P0 item below traces to a confirmed defect in Section E). Item IDs reference the remediation register.

### P0 — Foundation and risk remediation (Milestone M1 = the P0 core; Section J)

| # | Item | Outcome | Existing status | Dependencies | Scope | Acceptance criteria | Tests | DoD |
|---|---|---|---|---|---|---|---|---|
| P0-1 | **Git baseline + `.gitignore`** | Protected history | Untracked (E-19) | None | Create curated `.gitignore`; initial commit | `git log` shows baseline; `.env`, `node_modules`, `.next`, `*.tsbuildinfo` excluded | — | Committed and pushed to a remote (user to provide remote) |
| P0-2 | **Secrets and env centralization** | No credentials in code | E-9, E-10 confirmed | P0-1 | Remove hardcoded URL + console.log; single env loading path; document required vars (names only) | Boot fails fast without env; grep clean; no secrets in docs/logs | Boot-failure test | Merged |
| P0-3 | **Server-side pricing** | Trustworthy money | E-1 confirmed | P0-2 | `processCheckout` looks up variant prices in-tx; drop client `price`; API + dashboard action updated | Total = Σ DB sellingPrice × qty in all flows | Unit + integration (price manipulation attempt) | Merged |
| P0-4 | **Tenant + location authorization** | No cross-org/cross-location action | E-4, E-5, E-11 confirmed | P0-2 | Org filter in resolve; ownership validation in adjust/checkout; enforce `allowedLocationIds` in `getSessionContext` | Cross-org and cross-location attempts denied; tests prove it | Authorization matrix tests (rule 10) | Merged |
| P0-5 | **Actor FK fix** | Stock movements always persist | E-3 confirmed | P0-3 | Service-actor design (nullable system flag or principal row) in movements | FULFILL and storefront sale write valid movements | Integration tests | Merged |
| P0-6 | **Auth/session hardening** | Sessions expire centrally; invites secure | E-2, E-8 confirmed | P0-2 | Expiry in `getSessionContext`; one-time invite credentials replacing `password123` | Expired session = logged out everywhere; no default password works | Unit + integration | Merged |
| P0-7 | **Order numbering + customer uniqueness** | Deterministic identifiers | E-14, E-15 confirmed | P0-2 | Per-org sequence + unique constraints | Parallel order creation → unique numbers; concurrent upsert → one customer | Concurrency tests | Merged (with P0-9) |
| P0-8 | **API surface hardening** | Public plane bounded | E-6, E-7, E-12, E-13 confirmed | P0-2 | Org resolution by store token; origin allowlist; validation; rate limits; published-only filter | Two-org test; invalid payload 400; burst 429; drafts hidden | API tests | Merged |
| P0-9 | **Managed migrations** | Reproducible schema | E-16 confirmed | P0-1 | Baseline `migrate init` + migrate CHECK constraint; retire `db push` habit and `add-constraint.sql` | `migrate diff` clean on fresh DB | Migration run in CI against disposable Postgres | Merged |
| P0-10 | **Test harness + CI** | Regressions caught | E-18 confirmed | P0-1 | Vitest unit + integration (disposable DB via docker-compose service), CI: type-check, lint-add, unit, integration | CI green on M1 merge; all P0 fixes have regression tests | All above | CI live |

**Deliberately deferred from P0:** audit coverage (E-17 → P1), error envelopes (E-22 → P1), session cleanup (P2). Justification: they don't gate correctness of money/tenancy.

### P1 — Complete core merchant operations

- Catalogue management (edit/archive, variants, categories, images, status enforcement) — builds on P0-8.
- Inventory history UI, stock counts, low-stock thresholds (F.1).
- Suppliers, purchase orders, goods receiving (F.1) — **depends on** P0-3/P0-4 (same transaction patterns).
- Multi-location transfers (F.1) — depends on location authorization P0-4.
- Complete POS/order lifecycle (F.2 states, receipts as records, cancellation rules) — depends on P0-3, P0-5, P0-7.
- Customer management (CRUD, history view, dedup) — depends on P0-7.
- Staff roles/permissions matrix + audit coverage (E-17) — depends on P0-4, P0-6.
- Error-envelope + input validation for dashboard actions (E-22).

### P2 — Commerce and financial operations

- Payment provider integration per F.4 decision → initiation, verification, signed idempotent webhooks, reconciliation.
- Refunds as money movement; cancellation workflows (F.2).
- Receipts/invoices (PDF/print), storefront hardening (real cart, themes-lite), shipping/delivery records, business reporting exports, session cleanup (E-20), CSRF/origin hardening with payments (E-23).

### P3 — Expansion and differentiation

- Advanced segmentation, promotions/discounts, multiple storefronts, advanced analytics, accounting integrations, public API (activate the dead `ApiKey` model with hashed secret keys as designed in `schema.prisma:81–90`), webhooks, automation, AI-assisted ops.
- Gated on: P1/P2 completion **and** validated demand (Section B.6) — do not start P3 on unvalidated assumptions.

---

## H. Architecture and Engineering Decisions

### Retain (no change)

| Decision | Rationale |
|---|---|
| Modular monolith: Next.js dashboard + Fastify public API + shared `packages/core` | Matches team scale; one deployable unit per plane; the only cross-plane consistency need (inventory) lives in one transactional package |
| PostgreSQL + Prisma | Relational integrity is the product's core value; schema is sound; no evidence of a limitation |
| npm workspaces (no Turborepo/Nx) | Six packages; build orchestration overhead not yet justified |
| Server Actions for dashboard mutations | Next.js-native; cookie session fits RSC model; keep, but centralize authorization (P0-4) |
| DB-backed opaque session tokens | Simple, revocable; adequate until SSO/2FA needs arrive (P3) |
| Append-only StockMovement ledger + AuditLog | Correct foundation for the F.1 workflows |
| ATTENTION conflict-order pattern | Merchant-sensible resolution of oversell; retain, fix the FK bug (E-3) |

### Correct (no new tech, corrections within existing stack)

1. **Env/secret handling** (E-9/E-10): read config from environment only, fail fast. No config library needed.
2. **Authorization layer** (E-4/E-5/E-11): centralize in `getSessionContext` + a `require*` helper in core; keep Prisma, add missing unique constraints via migrations (P0-9). *Alternative considered: Postgres RLS — rejected for now (migration cost, Prisma interaction complexity) with application-level filters as the MVP control; revisit at scale.*
3. **Test harness** (E-18): add Vitest (unit + integration against the existing docker-compose Postgres) and CI. This is a justified dependency addition (rule 4) — no test runner currently exists.
4. **API validation** (E-13): schema validation on public endpoints (e.g., zod or Fastify's built-in JSON Schema — choose during implementation; either avoids a heavy dependency).

### Explicitly rejected (no evidence supports them)

Microservices; a new framework; a different database; queues/job infrastructure (nothing async yet); Redis/caching (no measured need); a second ORM.

---

## I. Open Decisions and Unknowns (require user input — none decided here)

| # | Decision | Options | What's needed to resolve |
|---|---|---|---|
| 1 | Initial customer segment | S1 single-location retailer / S2 multi-branch / S3 wholesale | Merchant interviews (AV-1..3) |
| 2 | Initial merchant size target | 1–5 staff vs 5–50 | Same |
| 3 | Nigeria-first vs international sequencing | NGN-only v1 vs multi-currency from start | Market priority + provider coverage |
| 4 | Pricing & monetization | Subscription tiers vs freemium vs transaction cut | Pricing research; competitor plan structures (UNVERIFIED — see Section K) |
| 5 | Payment provider | Paystack vs Flutterwave vs transfer-native | Verify criteria in F.4 against official docs; merchant eligibility check |
| 6 | POS price overrides | Hard-forbid vs permissioned override with audit | Merchant workflow research (AV-4) |
| 7 | Multi-currency | NGN-only first vs currency field from day one | Affects schema now (Decimal currency column) — cheap to add, expensive to retrofit |
| 8 | Inventory costing method | Weighted average vs FIFO vs none (MVP) | Segment + accounting depth decision |
| 9 | Staff permission granularity | 3 roles coarse vs permission matrix | Validate AV-3 |
| 10 | Storefront URL model | Subdomain (`store.via.ng`) vs path (`/s/token`) vs custom domains | Domain/infra cost + SEO needs |
| 11 | Accounting depth | Export CSV only vs ledger-level double-entry | Segment needs; affects financial models now |
| 12 | Hosting & operating cost | Single VPS vs managed PaaS vs containers | Budget assumptions; also affects backup/monitoring plan (P2) |
| 13 | Git remote | Where to host the repo (none exists) | User provides remote — required to finish P0-1 |

---

## J. Recommended Immediate Milestone

### Milestone M1 — "Trustworthy Money and Tenant Safety" (P0 core)

**Objective:** make every money/stock mutation server-authoritative and organization-scoped, eliminate the known integrity defects, protect the project's history, and establish the test/CI harness that makes all subsequent work verifiable.

**Scope (exact):**
1. Git baseline + curated `.gitignore` (P0-1). *Requires the user to provide a remote; a local baseline commit can proceed without it.*
2. Secrets/env centralization (P0-2): remove `packages/database/index.ts:13` hardcoded URL and `register/actions.ts:8` logging.
3. Server-side pricing in `processCheckout` (P0-3) for both the dashboard action and the API path.
4. Authorization hardening (P0-4): org filter in `resolveAttentionOrder`; ownership validation in `adjustInventory`/`processCheckout`; enforce `allowedLocationIds`.
5. Actor FK fix (P0-5) for FULFILL and storefront movements.
6. Session expiry centralized in `getSessionContext`; invite flow replaces `password123` (P0-6).
7. Managed migrations baseline including the CHECK constraint + new unique constraints (P0-9), which unblocks the uniqueness fixes (P0-7) in the same migration.
8. Vitest harness + CI (type-check, schema validate, unit, integration against a disposable Postgres) with regression tests for **every** corrected defect (P0-10, rule 11).

**Explicitly out of scope:** payment integration, storefront org resolution (P0-8 may ship as a separate fast-follow on the same branch train), catalogue features, reporting, notifications.

**Entry criteria:** current code state as audited (unchanged); user approves Milestone scope; user provides git remote (or approves local-only baseline).

**Exit criteria (all must hold before M2):**
- AC-1 `git log` shows a baseline commit; no `.env`/artifacts tracked (`git ls-files` check).
- AC-2 `grep` finds no credentials or connection strings in source; app boots only with env present.
- AC-3 Attempting a checkout/order with manipulated prices produces totals from DB prices — proven by an automated test.
- AC-4 Cross-org resolve, cross-org adjust, and restricted-location actions are denied — proven by automated authorization-matrix tests (rule 10).
- AC-5 FULFILL of an ATTENTION order persists a valid StockMovement (no FK violation) — proven by an integration test.
- AC-6 An expired session is treated as logged out by pages **and** actions — test-proven.
- AC-7 Invited staff have no usable default password; the invite credential is single-use and expiring — test-proven.
- AC-8 Fresh DB from migrations contains all 17 tables + CHECK + new unique constraints (`prisma migrate diff` clean).
- AC-9 CI runs all checks green on the M1 commit.
- AC-10 No secrets appear in any test output or log (rule 7); no real payments involved (rule 8 — none exist yet).

**Estimated shape:** one focused engineering phase; all changes are within existing files and packages; no new runtime dependencies except a test runner.

---

## K. Audit Limitations and Unverified Items (carried forward)

1. **External web access was unavailable this session** (search returned HTTP 402; Paystack and Bumpa official pages returned 403/transport errors). All competitive and payment-provider facts are therefore **UNVERIFIED**; Section F.4 provides the verification checklist instead of claims. Re-verify against official documentation before any pricing/positioning decision.
2. **No mutating runtime tests were executed** (checkout, resolve, invite, login) — flow correctness beyond type-checking and read-path verification is code-inferred. The E-3 FK failure is a confirmed code contradiction with an inferred (not demonstrated) runtime effect.
3. **No adversarial authorization testing** (IDOR, cross-org probing) was performed, per execution boundaries; E-4/E-5 remain *potential* vulnerabilities pending M1's authorization-matrix tests.
4. **Concurrency semantics** (checkout race, customer upsert race) were assessed by code reading, not load testing.
5. Production behavior (builds, HTTPS, deployments) has never been observed — no production environment exists.
6. Customer/demand facts: none exist; no research was performed and none is claimed.

---

*End of blueprint. Next action on approval: execute Milestone M1 (Section J) — nothing else.*
