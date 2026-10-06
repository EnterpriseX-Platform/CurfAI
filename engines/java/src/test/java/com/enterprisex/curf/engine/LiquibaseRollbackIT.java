package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import liquibase.Liquibase;
import liquibase.database.Database;
import liquibase.database.DatabaseFactory;
import liquibase.database.jvm.JdbcConnection;
import liquibase.resource.ClassLoaderResourceAccessor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/** Every changeset must roll back cleanly. Runs in its own schema so it never touches shared data. */
@EnabledIfEnvironmentVariable(named = "CURF_ENGINE_DB_URL", matches = ".+")
class LiquibaseRollbackIT {

    private static final String SCHEMA = "rollback_check";

    @Test
    void allChangesetsApplyAndRollBack() throws Exception {
        try (Connection conn = DriverManager.getConnection(
                System.getenv("CURF_ENGINE_DB_URL"),
                System.getenv("CURF_ENGINE_DB_USER"),
                System.getenv("CURF_ENGINE_DB_PASSWORD"))) {
            try (Statement st = conn.createStatement()) {
                st.execute("drop schema if exists " + SCHEMA + " cascade");
                st.execute("create schema " + SCHEMA);
                st.execute("set search_path to " + SCHEMA);
            }
            Database db = DatabaseFactory.getInstance().findCorrectDatabaseImplementation(new JdbcConnection(conn));
            db.setDefaultSchemaName(SCHEMA);
            db.setLiquibaseSchemaName(SCHEMA);
            Liquibase liquibase = new Liquibase(
                    "db/changelog/db.changelog-master.yaml", new ClassLoaderResourceAccessor(), db);

            liquibase.update("");
            assertThat(tableExists(conn, "engine_audit_event")).isTrue();

            liquibase.rollback(1000, "");
            assertThat(tableExists(conn, "engine_audit_event")).isFalse();

            try (Statement st = conn.createStatement()) {
                st.execute("set search_path to public");
                st.execute("drop schema " + SCHEMA + " cascade");
            }
        }
    }

    private static boolean tableExists(Connection conn, String table) throws Exception {
        try (Statement st = conn.createStatement();
                ResultSet rs = st.executeQuery(
                        "select 1 from information_schema.tables where table_schema = '" + SCHEMA
                                + "' and table_name = '" + table + "'")) {
            return rs.next();
        }
    }
}
