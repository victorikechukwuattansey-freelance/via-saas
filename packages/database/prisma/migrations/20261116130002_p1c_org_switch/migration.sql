/*
  P1-C Migration C3 (additive): active-organization switching (P1-17).
  - Adds Session.activeOrganizationId (approved C-D13a). Nullable column:
    NULL means "legacy session" and resolves exactly as before via the
    eligible-first fallback (P1-C section 10.2). No FK is added by design:
    a stale organization id (e.g. after membership removal) is first-class
    state that resolution re-verifies every request (C11) - an FK would
    either block removal or require cascade semantics the design rejects.
    The column is read only through the session row itself; no index needed.
*/

-- AddColumn
ALTER TABLE "Session" ADD COLUMN "activeOrganizationId" TEXT;
