/*
  P1-C Migration C1 (additive): staff/invitation lifecycle foundations.
  - Widens the AuditAction enum with the approved P1-C audit events
    (C-D6 as proposed + SWITCH_ORG per approved C-D22b).
  - Adds StaffInvite.revokedAt (terminal revocation: manual rescission or
    supersession; a revoked invite is never acceptable, P1-C section 8.1).
  - Adds the membership_role_canonical CHECK constraint (approved C-D1b):
    the three canonical roles are enforced at the database level, matching
    the application-level TS union.

  Single-migration safety on PostgreSQL 15: no statement in this migration
  USES a newly added enum value (the P1-B A/B split was required only
  because that migration's CHECK referenced CREATE_ORDER, added in the same
  transaction - see 20261116120000/20261116120001). The role CHECK below
  references only pre-existing string literals. PostgreSQL (>= 12) permits
  ALTER TYPE ... ADD VALUE inside a transaction provided the value is not
  used before the transaction commits; this migration satisfies that rule.
*/

-- EnumAddition
ALTER TYPE "AuditAction" ADD VALUE 'UPDATE_STAFF';
ALTER TYPE "AuditAction" ADD VALUE 'REMOVE_STAFF';
ALTER TYPE "AuditAction" ADD VALUE 'RESCIND_INVITE';
ALTER TYPE "AuditAction" ADD VALUE 'CREATE_LOCATION';
ALTER TYPE "AuditAction" ADD VALUE 'UPDATE_LOCATION';
ALTER TYPE "AuditAction" ADD VALUE 'ARCHIVE_LOCATION';
ALTER TYPE "AuditAction" ADD VALUE 'SWITCH_ORG';

-- AddColumn
ALTER TABLE "StaffInvite" ADD COLUMN "revokedAt" TIMESTAMP(3);

-- AddConstraint
-- Pre-checked before apply (P1-C section 14.3.1): only the three canonical
-- role values are written by the registration and invitation paths. Any
-- non-canonical value in the target database aborts this migration by
-- design (fail loudly rather than silently broadening or dropping data).
ALTER TABLE "Membership" ADD CONSTRAINT "membership_role_canonical" CHECK ("role" IN ('OWNER', 'MANAGER', 'STAFF'));
