package com.enterprisex.curf.engine.domain.query;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The corpus proves these are refused. This proves they are refused by the rule meant to catch them,
 * not just because the parser gave up, so the deny-lists cannot silently stop working.
 */
class SqlGuardReasonTest {

    private static final Map<String, String> EXPECTED = Map.ofEntries(
            Map.entry("SELECT pg_read_file('/etc/passwd')", "pg_read_file"),
            Map.entry("SELECT pg_catalog.pg_read_file('/etc/passwd')", "pg_read_file"),
            Map.entry("SELECT \"pg_read_file\"('/etc/passwd')", "pg_read_file"),
            Map.entry("SELECT PG_READ_FILE('/etc/passwd')", "pg_read_file"),
            Map.entry("SELECT * FROM (SELECT pg_read_file('/x') AS f) s", "pg_read_file"),
            Map.entry("WITH x AS (SELECT pg_read_file('/x') AS f) SELECT * FROM x", "pg_read_file"),
            Map.entry("SELECT 1 WHERE pg_read_file('/x') IS NOT NULL", "pg_read_file"),
            Map.entry("SELECT lo_import('/etc/passwd')", "lo_import"),
            Map.entry("SELECT * FROM dblink('host=x', 'select 1') AS t(a int)", "dblink"),
            Map.entry("SELECT set_config('x', 'y', false)", "set_config"),
            Map.entry("SELECT pg_sleep(10)", "pg_sleep"),
            Map.entry("SELECT LOAD_FILE('/etc/passwd')", "load_file"),
            Map.entry("SELECT SLEEP(10)", "sleep"),
            Map.entry("SELECT BENCHMARK(100000000, MD5('x'))", "benchmark"),
            Map.entry("SELECT UTL_HTTP.REQUEST('http://x') FROM dual", "utl_http"),
            Map.entry("SELECT DBMS_XMLGEN.GETXML('select 1') FROM dual", "dbms_xmlgen"),
            Map.entry("SELECT * FROM pg_shadow", "pg_shadow"),
            Map.entry("SELECT * FROM mysql.user", "user"),
            Map.entry("SELECT * FROM guard_probe FOR UPDATE", "locking"),
            Map.entry("SELECT * INTO guard_new FROM guard_probe", "INTO"),
            Map.entry("SELECT 1 /*!50000 ; DROP TABLE guard_probe */", "comments"),
            Map.entry("SELECT 1; SELECT 2", "exactly one"),
            Map.entry("DROP TABLE guard_probe", "only SELECT"),
            Map.entry("DELETE FROM guard_probe", "only SELECT"));

    @Test
    void theParsedTreeCatchesDeniedFunctionsEvenWhenNested() {
        for (String sql : new String[] {
            "SELECT pg_read_file('/x')",
            "SELECT * FROM (SELECT pg_read_file('/x') AS f) s",
            "WITH x AS (SELECT pg_read_file('/x') AS f) SELECT * FROM x",
            "SELECT 1 WHERE pg_read_file('/x') IS NOT NULL",
            "SELECT * FROM dblink('host=x', 'select 1') AS t(a int)"
        }) {
            assertThat(SqlGuard.check(sql).rejection()).as(sql).startsWith("function '");
        }
    }

    @Test
    void eachAttackIsStoppedByItsOwnRule() {
        EXPECTED.forEach((sql, fragment) -> {
            var verdict = SqlGuard.check(sql);
            assertThat(verdict.accepted()).as(sql).isFalse();
            assertThat(verdict.rejection()).as(sql).containsIgnoringCase(fragment);
        });
    }
}
