package com.enterprisex.curf.engine.infrastructure.jdbc;

import com.enterprisex.curf.engine.application.connection.ConnectionProbe;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.connection.TlsMode;
import com.enterprisex.curf.engine.domain.query.PiiHeuristics;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * Health, version and what the database account is allowed to do. "Read-only verified" means the
 * account holds no write, DDL or administrative privilege, found by inspecting its grants.
 */
@Component
public class JdbcConnectionProbe implements ConnectionProbe {

    private static final int MAX_TABLES = 2000;
    private static final int MAX_COLUMNS_PER_TABLE = 500;
    private static final Set<String> SYSTEM_SCHEMAS = Set.of(
            "pg_catalog", "information_schema", "pg_toast", "sys", "mysql", "performance_schema",
            // Oracle's own schemas
            "system", "xdb", "ctxsys", "mdsys", "outln", "dbsnmp", "audsys", "lbacsys", "gsmadmin_internal", "appqossys",
            "ordsys", "ordplugins", "ordadmin", "si_informtn_schema", "olapsys", "wmsys", "dvsys", "dvf", "ojvmsys", "dip",
            "anonymous", "xs$null", "remote_scheduler_agent", "gsmcatuser", "gsmuser", "sysbackup", "sysdg", "syskm", "sysrac",
            "oracle_ocm", "ggsys", "dbsfwuser", "gsmrootuser", "mddata", "orddata", "sys$umf");
    private static final Set<String> HARMLESS_GRANTS = Set.of(
            "SELECT", "USAGE", "SHOW VIEW", "SHOW DATABASES", "REFERENCES");

    @Override
    public TestResult test(Connection c, String password) {
        List<String> warnings = new ArrayList<>();
        if (c.tlsMode() == TlsMode.REQUIRE) {
            warnings.add("TLS is encrypted but the server certificate is not verified");
        } else if (c.tlsMode() == TlsMode.DISABLE) {
            warnings.add("TLS is disabled; credentials and data cross the network unencrypted");
        }
        long started = System.nanoTime();
        try (java.sql.Connection conn = open(c, password)) {
            long latency = (System.nanoTime() - started) / 1_000_000;
            String version = conn.getMetaData().getDatabaseProductName() + " " + conn.getMetaData().getDatabaseProductVersion();
            if (c.kind() == ConnectionKind.TRINO) {
                // Trino's permissions live in its access-control configuration, which a query cannot reveal.
                warnings.add("Trino's permissions come from its own access-control configuration, which the engine cannot inspect; "
                        + "the read-only transaction and the guard apply, so give this account only SELECT in Trino.");
                return new TestResult(true, latency, version, false, warnings);
            }
            List<String> writePrivileges = writePrivileges(c.kind(), conn);
            warnings.addAll(writePrivileges.stream()
                    .map(p -> "The account can write: " + p + ". Use a SELECT-only account.").toList());
            return new TestResult(true, latency, version, writePrivileges.isEmpty(), warnings);
        } catch (SQLException e) {
            throw JdbcErrors.translate(e);
        }
    }

    @Override
    public Introspection introspect(Connection c, String password) {
        Map<String, List<TableInfo>> bySchema = new LinkedHashMap<>();
        boolean truncated = false;
        try (java.sql.Connection conn = open(c, password)) {
            DatabaseMetaData meta = conn.getMetaData();
            int tables = 0;
            try (ResultSet rs = meta.getTables(conn.getCatalog(), null, "%", new String[] {"TABLE", "VIEW"})) {
                while (rs.next()) {
                    String schema = rs.getString("TABLE_SCHEM") == null ? conn.getCatalog() : rs.getString("TABLE_SCHEM");
                    if (schema == null || SYSTEM_SCHEMAS.contains(schema.toLowerCase(Locale.ROOT))) {
                        continue;
                    }
                    if (++tables > MAX_TABLES) {
                        truncated = true;
                        break;
                    }
                    String table = rs.getString("TABLE_NAME");
                    bySchema.computeIfAbsent(schema, s -> new ArrayList<>())
                            .add(new TableInfo(table, rs.getString("TABLE_TYPE"), columns(meta, conn.getCatalog(), rs.getString("TABLE_SCHEM"), table)));
                }
            }
        } catch (SQLException e) {
            throw JdbcErrors.translate(e);
        }
        List<SchemaInfo> schemas = bySchema.entrySet().stream().map(e -> new SchemaInfo(e.getKey(), e.getValue())).toList();
        return new Introspection(schemas, truncated);
    }

    private static List<ColumnInfo> columns(DatabaseMetaData meta, String catalog, String schema, String table) throws SQLException {
        List<ColumnInfo> columns = new ArrayList<>();
        try (ResultSet rs = meta.getColumns(catalog, schema, table, "%")) {
            while (rs.next() && columns.size() < MAX_COLUMNS_PER_TABLE) {
                String name = rs.getString("COLUMN_NAME");
                columns.add(new ColumnInfo(name, rs.getString("TYPE_NAME"),
                        rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls,
                        PiiHeuristics.suggest(name).name()));
            }
        }
        return columns;
    }

    private static java.sql.Connection open(Connection c, String password) throws SQLException {
        Properties props = JdbcUrls.properties(c);
        props.setProperty("user", c.username());
        if (JdbcUrls.sendsPassword(c) && password != null && !password.isEmpty()) {
            props.setProperty("password", password);
        }
        return DriverManager.getConnection(JdbcUrls.of(c), props);
    }

    private static List<String> writePrivileges(ConnectionKind kind, java.sql.Connection conn) throws SQLException {
        return switch (kind) {
            case POSTGRESQL -> postgresWrites(conn);
            case MYSQL, MARIADB -> mysqlWrites(conn);
            case ORACLE -> oracleWrites(conn);
            case SQLSERVER -> sqlServerWrites(conn);
            case TRINO -> List.of();
        };
    }

    /** Privileges that let an Oracle account do more than read, from its enabled system privileges and its roles' object grants. */
    private static final Set<String> ORACLE_HARMLESS = Set.of(
            "CREATE SESSION", "SET CONTAINER", "SELECT ANY TABLE", "SELECT ANY DICTIONARY", "SELECT ANY SEQUENCE", "READ ANY TABLE",
            "FLASHBACK ANY TABLE", "SELECT", "READ", "DEBUG", "ON COMMIT REFRESH");

    private static List<String> oracleWrites(java.sql.Connection conn) throws SQLException {
        List<String> found = new ArrayList<>();
        try (Statement st = conn.createStatement()) {
            try (ResultSet rs = st.executeQuery("select privilege from session_privs")) {
                while (rs.next()) {
                    String privilege = rs.getString(1);
                    if (!ORACLE_HARMLESS.contains(privilege) && !found.contains(privilege)) {
                        found.add(privilege);
                    }
                }
            }
            // Object privileges held directly or through a role (grants to PUBLIC are everyone's and are left out).
            try (ResultSet rs = st.executeQuery("""
                    select distinct privilege from all_tab_privs
                    where grantee in (select sys_context('USERENV', 'SESSION_USER') from dual union select role from session_roles)
                      and privilege not in ('SELECT', 'READ', 'DEBUG', 'REFERENCES', 'ON COMMIT REFRESH', 'QUERY REWRITE')""")) {
                while (rs.next()) {
                    String privilege = rs.getString(1);
                    if (!found.contains(privilege)) {
                        found.add(privilege);
                    }
                }
            }
        }
        return found;
    }

    private static final Set<String> SQLSERVER_HARMLESS = Set.of(
            "SELECT", "CONNECT", "CONNECT SQL", "VIEW DEFINITION", "VIEW ANY DEFINITION", "VIEW ANY DATABASE", "REFERENCES",
            "VIEW ANY COLUMN ENCRYPTION KEY DEFINITION", "VIEW ANY COLUMN MASTER KEY DEFINITION");

    private static List<String> sqlServerWrites(java.sql.Connection conn) throws SQLException {
        List<String> found = new ArrayList<>();
        try (Statement st = conn.createStatement()) {
            for (String scope : new String[] {"DATABASE", "SERVER"}) {
                try (ResultSet rs = st.executeQuery("select distinct permission_name from sys.fn_my_permissions(null, '" + scope + "')")) {
                    while (rs.next()) {
                        String permission = rs.getString(1);
                        if (!SQLSERVER_HARMLESS.contains(permission) && !found.contains(permission)) {
                            found.add(permission);
                        }
                    }
                }
            }
        }
        return found;
    }

    private static List<String> postgresWrites(java.sql.Connection conn) throws SQLException {
        List<String> found = new ArrayList<>();
        try (Statement st = conn.createStatement();
                ResultSet rs = st.executeQuery("""
                        select
                          coalesce((select rolsuper from pg_roles where rolname = current_user), false) as su,
                          has_database_privilege(current_database(), 'CREATE') as db_create,
                          exists (select 1 from pg_namespace n
                                  where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
                                    and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'
                                    and has_schema_privilege(n.oid, 'CREATE')) as schema_create,
                          exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                  where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
                                    and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
                                      or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))) as table_write
                        """)) {
            if (rs.next()) {
                if (rs.getBoolean("su")) {
                    found.add("superuser");
                }
                if (rs.getBoolean("db_create")) {
                    found.add("CREATE on the database");
                }
                if (rs.getBoolean("schema_create")) {
                    found.add("CREATE in a schema");
                }
                if (rs.getBoolean("table_write")) {
                    found.add("INSERT/UPDATE/DELETE/TRUNCATE on a table");
                }
            }
        }
        return found;
    }

    private static List<String> mysqlWrites(java.sql.Connection conn) throws SQLException {
        List<String> found = new ArrayList<>();
        try (Statement st = conn.createStatement(); ResultSet rs = st.executeQuery("SHOW GRANTS FOR CURRENT_USER()")) {
            while (rs.next()) {
                String grant = rs.getString(1);
                String upper = grant.toUpperCase(Locale.ROOT);
                int start = upper.indexOf("GRANT ") + 6;
                int on = upper.indexOf(" ON ");
                if (start < 6 || on < 0) {
                    continue;
                }
                for (String privilege : upper.substring(start, on).split(",")) {
                    String name = privilege.trim();
                    if (!name.isEmpty() && !HARMLESS_GRANTS.contains(name) && !found.contains(name)) {
                        found.add(name);
                    }
                }
                if (upper.contains("WITH GRANT OPTION") && !found.contains("GRANT OPTION")) {
                    found.add("GRANT OPTION");
                }
            }
        }
        return found;
    }
}
