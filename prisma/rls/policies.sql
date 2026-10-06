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

-- No workspace in context = system work: sign-in, cron, webhooks,
-- migrations, token-resolved public links before they know their owner.
-- Every request that resolved a signed-in user or an API key carries one
-- (src/lib/db.ts sets it on each query — BE-TEN-03), and inside that
-- context the policies below filter by it. Outside it they pass rows
-- through, exactly as before RLS — so a code path nobody has scoped yet
-- keeps working instead of silently returning nothing.
CREATE OR REPLACE FUNCTION app_rls_unscoped() RETURNS boolean AS $$
  SELECT app_is_super_admin() OR app_current_tenant() IS NULL;
$$ LANGUAGE sql STABLE;

-- OrgMembership's own policy (below) needs to ask "does a platform_admin
-- OrgMembership row exist for this org" — a query against OrgMembership,
-- inside OrgMembership's own policy. Written as a plain correlated
-- subquery, that self-reference is what makes Postgres bail with
-- "infinite recursion detected in policy for relation OrgMembership": with
-- FORCE ROW LEVEL SECURITY set (below), evaluating one row's policy
-- requires re-evaluating the same policy for the subquery's candidate
-- rows, which the planner can't bound. Confirmed live once the app
-- stopped connecting as a superuser (BE-TEN-03) — RLS had never actually
-- run for real traffic before that, so this was dormant.
--
-- SECURITY DEFINER breaks the cycle: the function body is planned as its
-- own opaque query, not inlined into the caller's policy expression, so
-- the rewriter never sees a self-reference to unbound. Run this file as a
-- superuser (as documented above) so the function is owned by one — a
-- SECURITY DEFINER function still has RLS applied to its own queries
-- unless its owner bypasses RLS, and FORCE RLS on OrgMembership means even
-- its owner isn't exempt otherwise.
CREATE OR REPLACE FUNCTION app_is_org_platform_admin(org_id text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "OrgMembership" me
    WHERE me."userId" = current_setting('app.user_id', true)
      AND me."organizationId" = org_id
      AND me."role" = 'platform_admin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Every table with a "tenantId" column — found from the catalog, not a
-- hand-kept list, so a table added later is covered the day it ships
-- (the old list had 13 of 73). The Prisma side covers exactly the same set:
-- every model with a tenantId field (src/lib/db.ts).
--
-- A nullable tenantId (AuditEvent's organisation-level events,
-- AppViewerToken) marks rows that belong to no single workspace; those are
-- readable in any context, but a workspace can still only write its own.
-- ---------------------------------------------------------------------------

-- One table's policy. SECURITY DEFINER and superuser-owned (this file runs
-- as the superuser) so a MIGRATION, which runs as the app role, can call it
-- for a table it just created — the new table is protected the moment it
-- exists instead of whenever someone next re-runs this file:
--   DO $$ BEGIN IF to_regproc('curf_apply_tenant_policy') IS NOT NULL THEN
--     PERFORM curf_apply_tenant_policy('NewTable'); END IF; END $$;
-- Only acts on a public table that really has a "tenantId" column.
CREATE OR REPLACE FUNCTION curf_apply_tenant_policy(tbl text) RETURNS void AS $$
DECLARE
  nullable boolean;
BEGIN
  SELECT c.is_nullable = 'YES' INTO nullable
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = tbl AND c.column_name = 'tenantId';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'curf_apply_tenant_policy: "%" has no tenantId column', tbl;
  END IF;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS curf_tenant_isolation ON public.%I', tbl);
  EXECUTE format(
    'CREATE POLICY curf_tenant_isolation ON public.%I
       USING (app_rls_unscoped() OR "tenantId" = app_current_tenant()%s)
       WITH CHECK (app_rls_unscoped() OR "tenantId" = app_current_tenant())',
    tbl,
    CASE WHEN nullable THEN ' OR "tenantId" IS NULL' ELSE '' END
  );
END
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
  LOOP
    PERFORM curf_apply_tenant_policy(t.table_name);
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
    app_rls_unscoped()
    OR id = current_setting('app.user_id', true)
    OR EXISTS (
      SELECT 1 FROM "Membership" m
      WHERE m."userId" = "User"."id" AND m."tenantId" = app_current_tenant()
    )
  )
  WITH CHECK (
    app_rls_unscoped()
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
    app_rls_unscoped()
    OR id = app_current_tenant()
    OR EXISTS (
      SELECT 1 FROM "OrgMembership" om
      WHERE om."userId" = current_setting('app.user_id', true)
        AND om."organizationId" = "Tenant"."organizationId"
    )
  )
  -- A workspace may update its own row (settings, branding, tier); creating
  -- or changing any other workspace happens in system context.
  WITH CHECK (app_rls_unscoped() OR id = app_current_tenant());

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
    app_rls_unscoped()
    OR id = (SELECT "organizationId" FROM "Tenant" WHERE id = app_current_tenant())
    OR EXISTS (
      SELECT 1 FROM "OrgMembership" om
      WHERE om."userId" = current_setting('app.user_id', true)
        AND om."organizationId" = "Organization"."id"
    )
  )
  WITH CHECK (app_rls_unscoped());

ALTER TABLE "OrgMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgMembership" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS curf_org_membership_visible ON "OrgMembership";
CREATE POLICY curf_org_membership_visible ON "OrgMembership"
  USING (
    app_rls_unscoped()
    OR "userId" = current_setting('app.user_id', true)
    OR app_is_org_platform_admin("organizationId")
  )
  WITH CHECK (app_rls_unscoped());

-- ---------------------------------------------------------------------------
-- Verification queries to run after applying:
--
--   SET app.user_tenant_id = 'demo';
--   SELECT count(*) FROM "Report";  -- only demo's reports
--
--   RESET app.user_tenant_id;
--   SELECT count(*) FROM "Report";  -- every row: no workspace = system work
--
--   SET app.user_role = 'super_admin';
--   SELECT count(*) FROM "Report";  -- everyone's reports
-- ---------------------------------------------------------------------------
