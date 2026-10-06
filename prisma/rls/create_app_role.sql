-- ============================================================================
-- Curf — non-superuser application role
-- ============================================================================
--
-- Issue Log BE-TEN-03: the role the app connects as (`curf`, the Postgres
-- image's bootstrap POSTGRES_USER) is a superuser. Postgres exempts
-- superusers from row-level security unconditionally — FORCE ROW LEVEL
-- SECURITY in policies.sql has no effect on them, by design, with no
-- override. Confirmed live: `SET app.tenant_id` then `SELECT count(*) FROM
-- "Report"` with no WHERE clause returned every tenant's rows. RLS was
-- providing zero defense-in-depth for the connection the app actually uses;
-- tenant isolation rested entirely on tenantWhere() in application code.
--
-- This creates a second, non-superuser role for the app to connect as.
-- It owns the `public` schema (so `prisma migrate deploy` / `db push` keep
-- working — CREATE TABLE needs schema ownership or a CREATE grant, and
-- owning the tables it creates is what makes FORCE ROW LEVEL SECURITY bind
-- to it), but carries none of a superuser's blanket bypass.
--
-- Run once per database, connected as the bootstrap superuser:
--   psql "$DATABASE_URL" -f prisma/rls/create_app_role.sql
-- Then point the app's DATABASE_URL at this role instead (same host/db,
-- new user/password) and re-run policies.sql so FORCE RLS is in effect for
-- tables already owned by the old role too (ALTER TABLE ... OWNER TO below
-- covers existing tables; new ones created after the switch are owned by
-- curf_app automatically).
--
-- Idempotent: safe to rerun. The password is a placeholder — replace
-- CURF_APP_PASSWORD_PLACEHOLDER before running anywhere the bootstrap
-- password isn't already being rotated per environment.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'curf_app') THEN
    CREATE ROLE curf_app LOGIN PASSWORD 'CURF_APP_PASSWORD_PLACEHOLDER';
  END IF;
END
$$;

ALTER ROLE curf_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Schema ownership, not just grants: Prisma's migrate/db push run CREATE
-- TABLE, CREATE INDEX, etc. against `public`. Owning the schema lets
-- curf_app do that without any superuser privilege, and tables it creates
-- are owned by it directly — the precondition for FORCE ROW LEVEL SECURITY
-- to actually apply to this role (see policies.sql).
ALTER SCHEMA public OWNER TO curf_app;

-- Re-point any tables that already exist (created earlier by the bootstrap
-- superuser, before this role existed) so FORCE RLS binds to them too.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO curf_app', t.tablename);
  END LOOP;
  FOR t IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE %I OWNER TO curf_app', t.sequencename);
  END LOOP;
END
$$;
