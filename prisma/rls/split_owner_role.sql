-- ============================================================================
-- Curf — split the schema OWNER from the role the app connects as
-- ============================================================================
--
-- create_app_role.sql made `curf_app` the owner of the `public` schema and of
-- every table, so `prisma migrate deploy` could run as the same role the app
-- uses. An owner can do what the app should never be able to do:
--   * ALTER TABLE ... DISABLE / NO FORCE ROW LEVEL SECURITY, or DROP POLICY —
--     switching off the database's workspace isolation (BE-TEN-03) from any
--     SQL the app role manages to run;
--   * UPDATE or DELETE "AuditEvent" rows, i.e. rewrite the audit trail.
--
-- After this script:
--   curf_owner  owns the schema, every table, sequence and function, and runs
--               migrations (the init container's MIGRATE_DATABASE_URL).
--   curf_app    owns nothing. It gets SELECT/INSERT/UPDATE/DELETE on tables,
--               USAGE/SELECT/UPDATE on sequences and EXECUTE on functions —
--               now and, through default privileges, for every table a later
--               migration creates — except:
--                 "AuditEvent"          SELECT, INSERT only
--                 "_prisma_migrations"  SELECT only
--               Retention deletes audit rows only through
--               curf_audit_retention_delete() (SECURITY DEFINER, owned by
--               curf_owner; migration 20261112130000_audit_event_append_only).
--
-- Run once per database, connected as the bootstrap superuser, AFTER
-- `prisma migrate deploy`, create_app_role.sql and policies.sql:
--   psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f prisma/rls/policies.sql
--   sed "s/CURF_OWNER_PASSWORD_PLACEHOLDER/<password>/" prisma/rls/split_owner_role.sql \
--     | psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1
-- Order matters: policies.sql run by the superuser creates its helper
-- functions (two of them SECURITY DEFINER) owned by the superuser; this
-- script moves them to curf_owner, so they never run with superuser rights.
-- Re-applying policies.sql later? Re-run this script after it.
-- Then add MIGRATE_DATABASE_URL (curf_owner) to the cluster secret: the init
-- container and the migrate/seed jobs use it, the app keeps DATABASE_URL
-- (curf_app). Seed jobs must use the owner URL from now on: the seeds reset
-- demo audit rows, which the app role can no longer delete.
--
-- Idempotent: safe to rerun (for example after restoring a dump that was
-- taken before the split). Replace CURF_OWNER_PASSWORD_PLACEHOLDER first.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'curf_app') THEN
    RAISE EXCEPTION 'curf_app does not exist yet: run prisma/rls/create_app_role.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'curf_owner') THEN
    CREATE ROLE curf_owner LOGIN PASSWORD 'CURF_OWNER_PASSWORD_PLACEHOLDER';
  END IF;
END
$$;

-- Neither role is exempt from row-level security. The owner is still bound
-- by it because policies.sql uses FORCE ROW LEVEL SECURITY.
ALTER ROLE curf_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE curf_app   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

-- Hand everything curf_app owns in this database (the schema, tables,
-- sequences, the RLS helper functions, curf_audit_retention_delete) to
-- curf_owner.
REASSIGN OWNED BY curf_app TO curf_owner;
ALTER SCHEMA public OWNER TO curf_owner;

-- Objects created earlier by the bootstrap superuser, before either role
-- existed, are moved too, so curf_owner can migrate them.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'curf_owner' LOOP
    EXECUTE format('ALTER TABLE %I OWNER TO curf_owner', t.tablename);
  END LOOP;
  FOR t IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' AND sequenceowner <> 'curf_owner' LOOP
    EXECUTE format('ALTER SEQUENCE %I OWNER TO curf_owner', t.sequencename);
  END LOOP;
  FOR t IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'curf_owner'
       AND p.prokind = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO curf_owner', t.sig);
  END LOOP;
END
$$;

-- What the app may do today…
GRANT USAGE ON SCHEMA public TO curf_app;
REVOKE CREATE ON SCHEMA public FROM curf_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO curf_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO curf_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO curf_app;

-- …and on every table a later migration (run as curf_owner) creates.
ALTER DEFAULT PRIVILEGES FOR ROLE curf_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO curf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE curf_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO curf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE curf_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO curf_app;

-- The audit trail is append-only for the app.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEvent" FROM curf_app;
-- Migration history is the owner's business.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "_prisma_migrations" FROM curf_app;
  END IF;
END
$$;
