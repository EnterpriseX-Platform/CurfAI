package com.enterprisex.curf.engine;

import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.params.provider.Arguments;

/**
 * The databases the integration tests run against and the data they find there. PostgreSQL is always
 * present (it is also the engine's own database); MySQL, MariaDB, Oracle, SQL Server and Trino are included when their environment is set. The Trino target is its
 * in-memory catalog; which user may write is decided by the rules in src/test/resources/trino/rules.json, so its test accounts need no password.
 *
 * <p>Oracle tables are owned by CURF_OWNER with lower-case quoted column names, so the same view and rule definitions work on every
 * database; public synonyms let the two test accounts name the tables without a schema.
 */
final class DbTargets {

    static final String PASSWORD = "Pw-test-1";

    record Target(String kind, String host, int port, String database, String adminUser, String adminPassword, String heavySql) {
        @Override
        public String toString() {
            return kind;
        }

        boolean postgres() {
            return kind.equals("POSTGRESQL");
        }

        boolean oracle() {
            return kind.equals("ORACLE");
        }

        boolean sqlServer() {
            return kind.equals("SQLSERVER");
        }

        boolean trino() {
            return kind.equals("TRINO");
        }

        boolean mysqlFamily() {
            return kind.equals("MYSQL") || kind.equals("MARIADB");
        }

        /** Database name as the engine's connection must name it (for Oracle, the service name). */
        String connectionDatabase() {
            return postgres() ? database : oracle() ? "FREEPDB1" : trino() ? "memory.default" : "curf_guard";
        }

        String schema() {
            return postgres() ? "public" : oracle() ? "CURF_OWNER" : sqlServer() ? "dbo" : trino() ? "default" : "curf_guard";
        }

        /**
         * Test SQL written for the other databases, made valid here. Oracle's test tables have lower-case quoted column names, so a
         * bare column name in the statement is quoted; everything else is unchanged.
         */
        String sql(String statement) {
            if (!oracle()) {
                return statement;
            }
            return statement.replaceAll("(?<![:\\w\"])(id|label|agency_code|name|email|salary|amount|created|national_id|note|password_hash)(?![\\w\"])", "\"$1\"");
        }

        /** A table as the admin connection must name it (Oracle: its owner; SQL Server: the database and schema). */
        String qualified(String table) {
            return postgres() ? "public." + table : oracle() ? "curf_owner." + table : sqlServer() ? "curf_guard.dbo." + table
                    : trino() ? "memory.default." + table : "curf_guard." + table;
        }

        /** A column or table name quoted the way this database quotes it. */
        String quoted(String name) {
            return mysqlFamily() ? "`" + name + "`" : sqlServer() ? "[" + name + "]" : "\"" + name + "\"";
        }
    }

    private DbTargets() {}

    static Stream<Arguments> targets() {
        List<Arguments> list = new ArrayList<>();
        var m = Pattern.compile("jdbc:postgresql://([^:/]+):(\\d+)/(.+)").matcher(System.getenv("CURF_ENGINE_DB_URL"));
        if (m.matches()) {
            list.add(Arguments.of(new Target("POSTGRESQL", m.group(1), Integer.parseInt(m.group(2)), m.group(3),
                    System.getenv("CURF_ENGINE_DB_USER"), System.getenv("CURF_ENGINE_DB_PASSWORD"),
                    "SELECT count(*) AS c FROM generate_series(1, 2000000000)")));
        }
        for (String kind : new String[] {"MYSQL", "MARIADB"}) {
            String host = System.getenv("CURF_ENGINE_TEST_" + kind + "_HOST");
            if (host != null && !host.isBlank()) {
                list.add(Arguments.of(new Target(kind, host, Integer.parseInt(System.getenv("CURF_ENGINE_TEST_" + kind + "_PORT")),
                        "curf_guard", "root", System.getenv("CURF_ENGINE_TEST_ROOT_PASSWORD"),
                        "SELECT count(*) AS c FROM information_schema.columns a, information_schema.columns b, information_schema.columns c")));
            }
        }
        String oracleHost = System.getenv("CURF_ENGINE_TEST_ORACLE_HOST");
        if (oracleHost != null && !oracleHost.isBlank()) {
            list.add(Arguments.of(new Target("ORACLE", oracleHost, Integer.parseInt(System.getenv("CURF_ENGINE_TEST_ORACLE_PORT")),
                    "FREEPDB1", "system", System.getenv("CURF_ENGINE_TEST_ORACLE_PASSWORD"),
                    "SELECT count(*) AS c FROM all_objects a, all_objects b, all_objects c")));
        }
        String mssqlHost = System.getenv("CURF_ENGINE_TEST_MSSQL_HOST");
        if (mssqlHost != null && !mssqlHost.isBlank()) {
            list.add(Arguments.of(new Target("SQLSERVER", mssqlHost, Integer.parseInt(System.getenv("CURF_ENGINE_TEST_MSSQL_PORT")),
                    "curf_guard", "sa", System.getenv("CURF_ENGINE_TEST_MSSQL_PASSWORD"),
                    "SELECT count_big(*) AS c FROM sys.all_columns a, sys.all_columns b, sys.all_columns c")));
        }
        String trinoHost = System.getenv("CURF_ENGINE_TEST_TRINO_HOST");
        if (trinoHost != null && !trinoHost.isBlank()) {
            list.add(Arguments.of(new Target("TRINO", trinoHost, Integer.parseInt(System.getenv("CURF_ENGINE_TEST_TRINO_PORT")),
                    "memory.default", "admin", "",
                    "SELECT count(*) AS c FROM unnest(sequence(1, 10000)) a(x) CROSS JOIN unnest(sequence(1, 10000)) b(y) "
                            + "CROSS JOIN unnest(sequence(1, 10000)) c(z)")));
        }
        return list.stream();
    }

    static java.sql.Connection adminConnection(Target t) throws Exception {
        if (t.trino()) {
            java.util.Properties user = new java.util.Properties();
            user.setProperty("user", t.adminUser());
            return DriverManager.getConnection("jdbc:trino://" + t.host() + ":" + t.port() + "/memory/default?SSL=false", user);
        }
        if (t.oracle()) {
            return DriverManager.getConnection("jdbc:oracle:thin:@//" + t.host() + ":" + t.port() + "/FREEPDB1", t.adminUser(), t.adminPassword());
        }
        if (t.sqlServer()) {
            return DriverManager.getConnection("jdbc:sqlserver://" + t.host() + ":" + t.port()
                    + ";databaseName=master;encrypt=true;trustServerCertificate=true", t.adminUser(), t.adminPassword());
        }
        String url = t.postgres()
                ? "jdbc:postgresql://" + t.host() + ":" + t.port() + "/" + t.database()
                : (t.kind().equals("MYSQL") ? "jdbc:mysql://" : "jdbc:mariadb://") + t.host() + ":" + t.port() + "/?"
                        + (t.kind().equals("MYSQL") ? "allowPublicKeyRetrieval=true&sslMode=DISABLED&characterEncoding=UTF-8"
                                : "allowPublicKeyRetrieval=true&sslMode=disable");
        return DriverManager.getConnection(url, t.adminUser(), t.adminPassword());
    }

    static void prepareAll() {
        targets().forEach(a -> {
            try {
                prepare((Target) a.get()[0]);
            } catch (Exception e) {
                throw new IllegalStateException("could not prepare " + a.get()[0], e);
            }
        });
    }

    /** Tables, rows and two accounts per database: one that can write and one that can only SELECT. */
    static void prepare(Target t) throws Exception {
        List<String> sql = new ArrayList<>();
        String s = t.postgres() ? "" : t.oracle() ? "curf_owner." : t.sqlServer() ? "" : t.trino() ? "memory.default." : "curf_guard.";
        String q = t.mysqlFamily() ? "`" : t.sqlServer() ? "" : "\"";
        String n = t.sqlServer() ? "N" : "";

        if (t.mysqlFamily()) {
            sql.add("create database if not exists curf_guard default character set utf8mb4");
        }
        if (t.sqlServer()) {
            sql.add("if db_id('curf_guard') is null create database curf_guard");
            sql.add("use curf_guard");
        }
        if (t.oracle()) {
            for (String user : new String[] {"curf_owner", "curf_writer", "curf_reader"}) {
                sql.add("begin execute immediate 'create user " + user + " identified by \"" + PASSWORD + "\"'; exception when others then null; end;");
                sql.add("alter user " + user + " identified by \"" + PASSWORD + "\"");
                sql.add("grant create session to " + user);
            }
            sql.add("alter user curf_owner quota unlimited on users");
            sql.add("grant create table to curf_owner");
            sql.add("grant create table to curf_writer");
            sql.add("alter user curf_writer quota unlimited on users");
        }
        for (String table : new String[] {"guard_probe", "guard_new", "pii_probe", "agency_data"}) {
            if (t.oracle()) {
                sql.add("drop table if exists curf_writer." + table);
            }
            sql.add("drop table if exists " + s + table);
        }

        // Oracle names every column in lower case inside quotes, so view and rule definitions read the same on every database.
        String id = t.oracle() ? q + "id" + q : "id";
        String label = t.oracle() ? q + "label" + q : "label";
        String intType = t.oracle() ? "number(10)" : "int";
        String key = t.trino() ? "" : " primary key";
        String text = t.oracle() ? "varchar2" : "varchar";
        String wide = t.sqlServer() ? "nvarchar" : text;
        sql.add("create table " + s + "guard_probe(" + id + " " + intType + key + ", " + label + " " + text + "(50))");
        sql.add("insert into " + s + "guard_probe values (1,'one')");
        sql.add("insert into " + s + "guard_probe values (2,'two')");
        sql.add("insert into " + s + "guard_probe values (3,'three')");
        String[] pii = t.oracle() ? new String[] {"id", "email", "password_hash", "note"} : new String[] {"id", "email", "password_hash", "note"};
        sql.add("create table " + s + "pii_probe(" + col(t, pii[0]) + " " + intType + key + ", " + col(t, pii[1]) + " " + text + "(100), "
                + col(t, pii[2]) + " " + text + "(100), " + col(t, pii[3]) + " " + text + "(10))");
        sql.add("create table " + s + "agency_data(" + col(t, "id") + " " + intType + key + ", " + col(t, "agency_code") + " " + text
                + "(10), " + col(t, "name") + " " + text + "(50), " + col(t, "email") + " " + text + "(100), " + col(t, "salary") + " " + intType
                + ", " + col(t, "national_id") + " " + text + "(13), " + col(t, "amount") + " " + (t.oracle() ? "number(10,2)" : t.trino() ? "decimal(10,2)" : "numeric(10,2)")
                + ", " + col(t, "created") + " date, " + q + "ที่อยู่" + (t.mysqlFamily() ? "`" : t.sqlServer() ? "" : "\"") + " " + wide + "(100))");
        String[][] rows = {
            {"1", "A001", "Somchai", "somchai@a001.go.th", "30000", "1100100000011", "100.50", "2026-01-10", "กรุงเทพ"},
            {"2", "A001", "Malee", "malee@a001.go.th", "42000", "1100100000022", "200.25", "2026-02-10", "เชียงใหม่"},
            {"3", "A001", "Anan", "anan@a001.go.th", "28000", "1100100000033", "50.00", "2026-03-10", "ขอนแก่น"},
            {"4", "A002", "Pim", "pim@a002.go.th", "51000", "1100100000044", "300.00", "2026-01-20", "ภูเก็ต"},
            {"5", "A002", "Nok", "nok@a002.go.th", "39000", "1100100000055", "10.75", "2026-02-20", "สงขลา"},
            {"6", "B001", "Dao", "dao@b001.go.th", "60000", "1100100000066", "999.99", "2026-03-20", "ระยอง"},
            {"7", null, "Orphan", "orphan@x.go.th", "1", "1100100000077", "1.00", "2026-04-01", "ไม่ระบุ"},
        };
        for (String[] r : rows) {
            sql.add("insert into " + s + "agency_data values (" + r[0] + "," + (r[1] == null ? "NULL" : "'" + r[1] + "'") + ",'" + r[2] + "','" + r[3]
                    + "'," + r[4] + ",'" + r[5] + "'," + r[6] + "," + (t.oracle() || t.trino() ? "date '" + r[7] + "'" : "'" + r[7] + "'") + "," + n + "'" + r[8] + "')");
        }

        if (t.postgres()) {
            for (String role : new String[] {"curf_writer", "curf_reader"}) {
                sql.add("do $$ begin if not exists (select from pg_roles where rolname = '" + role + "') then create role " + role + " login; end if; end $$");
                sql.add("alter role " + role + " password '" + PASSWORD + "'");
            }
            sql.add("grant all on guard_probe, pii_probe, agency_data to curf_writer");
            sql.add("grant create on schema public to curf_writer");
            sql.add("revoke all on guard_probe, pii_probe, agency_data from curf_reader");
            sql.add("grant select on guard_probe, pii_probe, agency_data to curf_reader");
        } else if (t.trino()) {
            // Nothing to grant: rules.json gives curf_writer write access and curf_reader read-only access by user name.
        } else if (t.oracle()) {
            for (String table : new String[] {"guard_probe", "pii_probe", "agency_data"}) {
                sql.add("grant all on curf_owner." + table + " to curf_writer");
                sql.add("grant select on curf_owner." + table + " to curf_reader");
                sql.add("create or replace public synonym " + table + " for curf_owner." + table);
            }
        } else if (t.sqlServer()) {
            for (String user : new String[] {"curf_writer", "curf_reader"}) {
                sql.add("if not exists (select 1 from sys.server_principals where name = '" + user + "') create login " + user
                        + " with password = '" + PASSWORD + "', check_policy = off, default_database = curf_guard");
                sql.add("alter login " + user + " with password = '" + PASSWORD + "'");
                sql.add("if not exists (select 1 from sys.database_principals where name = '" + user + "') create user " + user + " for login " + user);
            }
            sql.add("alter role db_datareader add member curf_writer");
            sql.add("alter role db_datawriter add member curf_writer");
            sql.add("alter role db_ddladmin add member curf_writer");
            sql.add("alter role db_datareader add member curf_reader");
        } else {
            for (String user : new String[] {"curf_writer", "curf_reader"}) {
                sql.add("create user if not exists '" + user + "'@'%' identified by '" + PASSWORD + "'");
                sql.add("alter user '" + user + "'@'%' identified by '" + PASSWORD + "'");
            }
            sql.add("grant all on curf_guard.* to 'curf_writer'@'%'");
            sql.add("grant select on curf_guard.* to 'curf_reader'@'%'");
        }
        try (java.sql.Connection c = adminConnection(t); Statement st = c.createStatement()) {
            for (String statement : sql) {
                st.execute(statement);
            }
        }
    }

    /** A column name as the table must be created with it: quoted lower case on Oracle, plain elsewhere. */
    private static String col(Target t, String name) {
        return t.oracle() ? "\"" + name + "\"" : name;
    }

    /** Everything an attack on guard_probe could have changed, as one string. */
    static String snapshot(Target t) throws Exception {
        String schema = t.schema();
        try (java.sql.Connection c = adminConnection(t); Statement st = c.createStatement()) {
            if (t.sqlServer()) {
                st.execute("use curf_guard");
            }
            StringBuilder sb = new StringBuilder();
            String rowsSql = t.oracle() ? "select \"id\", \"label\" from curf_owner.guard_probe order by \"id\""
                    : "select id, label from " + t.qualified("guard_probe") + " order by id";
            try (ResultSet rs = st.executeQuery(rowsSql)) {
                while (rs.next()) {
                    sb.append(rs.getInt(1)).append('=').append(rs.getString(2)).append(';');
                }
            }
            String tablesSql = t.oracle()
                    ? "select lower(table_name) from all_tables where owner in ('CURF_OWNER', 'CURF_WRITER') and lower(table_name) in "
                            + "('guard_probe','guard_new','pii_probe','agency_data') order by 1"
                    : "select table_name from information_schema.tables where table_schema = '" + schema
                            + "' and table_name in ('guard_probe','guard_new','pii_probe','agency_data') order by 1";
            try (ResultSet rs = st.executeQuery(tablesSql)) {
                while (rs.next()) {
                    sb.append(rs.getString(1)).append(',');
                }
            }
            String colsSql = t.oracle()
                    ? "select count(*) from all_tab_columns where owner = 'CURF_OWNER' and table_name = 'GUARD_PROBE'"
                    : "select count(*) from information_schema.columns where table_schema = '" + schema + "' and table_name = 'guard_probe'";
            try (ResultSet rs = st.executeQuery(colsSql)) {
                rs.next();
                sb.append("cols=").append(rs.getInt(1));
            }
            return sb.toString();
        }
    }
}
