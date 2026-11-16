/*
  P1-B Migration B (additive, D-G sequencing — part 2 of 2):
  - Adds the auditlog_actorid_null_only_public_checkout CHECK constraint
    (defense in depth for the D-G null-actor invariant).

  This migration MUST run only after 20261116120000_p1b_orders_a has
  completed successfully and committed: the CHECK expression references the
  CREATE_ORDER enum label added there, and PostgreSQL (>= 12) makes a newly
  added enum value usable only after the adding transaction has committed.
  The two-migration boundary itself is the guarantee.

  The constraint expresses the STRUCTURAL invariant:
    - any row with a non-null actorId is permitted (all merchant-attributed
      events), and
    - a null actorId is permitted ONLY for public storefront/API checkout:
      action = CREATE_ORDER with a non-null metadata object carrying the
      TOP-LEVEL "source" key = "STOREFRONT_API".
  It cannot verify that "source" was server-authored (it inspects only the
  stored value) — the central audit helper (packages/core/src/audit.ts) plus
  automated tests (B-AC31) remain the mandatory enforcement boundary for
  server authorship. Metadata "source" is a TOP-LEVEL JSON key, stamped by
  the server-side public checkout path; it is never a client-controlled
  authorization claim.
*/

-- AddConstraint
-- NOTE (implementation-time correction): a bare `metadata->>'source' = 'STOREFRONT_API'`
-- comparison evaluates to NULL (not FALSE) when the top-level key is absent or
-- non-text, and PostgreSQL CHECK constraints PASS on NULL — verified against
-- PostgreSQL 15.20 by direct case-matrix replay during implementation. The
-- extra `IS NOT NULL` guard below forces the absent/nested-source cases to a
-- definitive FALSE, making the constraint exactly match the approved D-G
-- truth table: null actor is permitted ONLY for CREATE_ORDER with non-null
-- metadata and a top-level "source" key equal to "STOREFRONT_API".
ALTER TABLE "AuditLog" ADD CONSTRAINT "auditlog_actorid_null_only_public_checkout" CHECK (
  "actorId" IS NOT NULL
  OR (
    "action" = 'CREATE_ORDER'
    AND "metadata" IS NOT NULL
    AND "metadata"->>'source' IS NOT NULL
    AND "metadata"->>'source' = 'STOREFRONT_API'
  )
);
