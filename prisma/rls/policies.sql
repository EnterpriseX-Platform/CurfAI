-- ============================================================================
-- Curf - Row-Level Security policies
-- ============================================================================
--
-- Apply AFTER `prisma db push` (or migrate deploy) against your Postgres
-- database. This file enables RLS on every tenant-scoped table and writes
-- the policies that read app.user_* GUCs set by withTenantContext()
-- (see src/lib/rls.ts).
--
--   psql "$DATABASE_URL" -f prisma/rls/policies.sql
--
-- Idempotent: rerunning replaces the policies. Drops are guarded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: a SQL function that returns the current tenantId from the GUC,
-- or NULL if unset. Policies use this directly.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.user_tenant_id', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_super_admin() RETURNS boolean AS $$
  SELECT current_setting('app.user_role', true) = 'super_admin';
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- Macro: enable RLS + set policies for one tenant-scoped table.
-- We can't use a real macro in plain SQL, so this is a generated block.
-- Add the table name to the list to extend coverage.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'Report', 'DataSource', 'Schedule', 'Role', 'Membership',
    'ActionRun', 'WatcherRun', 'ReportRun', 'ReportVersion',
    'Comment', 'PublicShareToken', 'ApiKey', 'PasswordResetToken'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS curf_tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY curf_tenant_isolation ON %I
         USING (app_is_super_admin() OR "tenantId" = app_current_tenant())
         WITH CHECK (app_is_super_admin() OR "tenantId" = app_current_tenant())',
      t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- User table: no longer tenant-scoped (one global row per email, id +
-- passwordHash + preferences shared across every workspace) — "which
-- tenant can see this row" is now indirect, via Membership. A session can
-- always see its own row (needed for the membership lookup at signin,
-- before any tenant GUC is set), plus any User who has a Membership in the
-- tenant currently active for this session (so admins can still list every
-- member of their workspace, matching the old tenant-column behaviour).
-- Writes stay self-only — nothing should update someone else's global
-- account row directly; role/rolesJson changes go through Membership.
-- ---------------------------------------------------------------------------

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS curf_user_self_or_tenant ON "User";
DROP POLICY IF EXISTS curf_user_self_or_tenant_member ON "User";
CREATE POLICY curf_user_self_or_tenant_member ON "User"
  USING (
    app_is_super_admin()
    OR id = current_setting('app.user_id', true)
    OR EXISTS (
      SELECT 1 FROM "Membership" m
      WHERE m."userId" = "User"."id" AND m."tenantId" = app_current_tenant()
    )
  )
  WITH CHECK (
    app_is_super_admin()
    OR id = current_setting('app.user_id', true)
  );

-- ---------------------------------------------------------------------------
-- Tenant table: every authenticated session can SELECT its own tenant row
-- (for the switcher), any tenant their email has a User row in, and (new)
-- every tenant under an Organization they hold a Platform Admin
-- OrgMembership for — even ones they've never joined. The Membership and
-- OrgMembership checks are both enforced at the app layer too
-- (loadMembershipsForEmail / loadMembershipsForUserId in src/lib/auth.ts);
-- this policy is the belt + braces.
-- ---------------------------------------------------------------------------

ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS curf_tenant_visible ON "Tenant";
CREATE POLICY curf_tenant_visible ON "Tenant"
  USING (
    app_is_super_admin()
    OR id = app_current_tenant()
    OR EXISTS (
      SELECT 1 FROM "OrgMembership" om
      WHERE om."userId" = current_setting('app.user_id', true)
        AND om."organizationId" = "Tenant"."organizationId"
    )
  )
  WITH CHECK (app_is_super_admin());

-- ---------------------------------------------------------------------------
-- Organization / OrgMembership: self-scoped, not tenant-scoped — neither
-- fits the generic tenantId macro above, so they get bespoke policies.
--
-- Organization: visible to super_admin, to any Platform Admin of it, and to
-- anyone whose currently-active tenant belongs to it (so a plain workspace
-- admin can still see their own org's name — just not other members' grants).
--
-- OrgMembership: visible to super_admin, to the row's own user (so a person
-- can tell they hold Platform Admin), and to any OTHER Platform Admin of the
-- same org (so the Organization tab can list/manage every grant). Writes are
-- app-layer only (isOrgPlatformAdmin() + featureGate("org.platform_admin")
-- in src/lib/orgAdmin.ts) — RLS here is defense-in-depth, not the gate.
-- ---------------------------------------------------------------------------

ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS curf_org_visible ON "Organization";
CREATE POLICY curf_org_visible ON "Organization"
  USING (
    app_is_super_admin()
    OR id = (SELECT "organizationId" FROM "Tenant" WHERE id = app_current_tenant())
    OR EXISTS (
      SELECT 1 FROM "OrgMembership" om
      WHERE om."userId" = current_setting('app.user_id', true)
        AND om."organizationId" = "Organization"."id"
    )
  )
  WITH CHECK (app_is_super_admin());

ALTER TABLE "OrgMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgMembership" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS curf_org_membership_visible ON "OrgMembership";
CREATE POLICY curf_org_membership_visible ON "OrgMembership"
  USING (
    app_is_super_admin()
    OR "userId" = current_setting('app.user_id', true)
    OR EXISTS (
      SELECT 1 FROM "OrgMembership" me
      WHERE me."userId" = current_setting('app.user_id', true)
        AND me."organizationId" = "OrgMembership"."organizationId"
        AND me."role" = 'platform_admin'
    )
  )
  WITH CHECK (app_is_super_admin());

-- ---------------------------------------------------------------------------
-- Verification queries to run after applying:
--
--   SET app.user_tenant_id = 'demo';
--   SELECT count(*) FROM "Report";  -- only demo's reports
--
--   RESET app.user_tenant_id;
--   SELECT count(*) FROM "Report";  -- 0 (no tenant set, no super_admin)
--
--   SET app.user_role = 'super_admin';
--   SELECT count(*) FROM "Report";  -- everyone's reports
-- ---------------------------------------------------------------------------
