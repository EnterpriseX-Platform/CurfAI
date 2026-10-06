package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.enterprisex.curf.engine.application.query.QueryBackend;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.connection.TlsMode;
import com.enterprisex.curf.engine.domain.query.QueryLimits;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The whole path over HTTP against real databases: the shared attack corpus on writable and read-only
 * accounts, secrets handling, limits, provenance, cache scoping and tenant isolation. A target is
 * included when its environment is set (PostgreSQL always; MySQL and MariaDB when their host is given).
 */
@EngineIT
class QueryEngineIT {

    static final String TENANT = "t-" + UUID.randomUUID();
    static final String OTHER_TENANT = "t-" + UUID.randomUUID();

    @BeforeAll
    static void prepareDatabases() {
        DbTargets.prepareAll();
    }

    @Autowired MockMvc mvc;
    @Autowired JsonMapper json;
    @Autowired JdbcClient jdbc;
    @Autowired QueryBackend backend;

    static String admin() {
        return TestIdp.bearer(TENANT, "admin-user", "curf-admin");
    }

    static String developer() {
        return TestIdp.bearer(TENANT, "dev-user", "curf-developer");
    }

    static String viewer() {
        return TestIdp.bearer(TENANT, "viewer-user", "curf-viewer");
    }

    // ---------------------------------------------------------------- HTTP helpers

    JsonNode body(MvcResult r) throws Exception {
        String text = r.getResponse().getContentAsString();
        return text.isEmpty() ? null : json.readTree(text);
    }

    MvcResult call(org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request, String token, Object payload)
            throws Exception {
        var builder = request.header("Authorization", token);
        if (payload != null) {
            builder = builder.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload));
        }
        return mvc.perform(builder).andReturn();
    }

    String createConnection(DbTargets.Target t, String user, boolean rawSql) throws Exception {
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("name", t.kind() + "-" + user + "-" + UUID.randomUUID());
        req.put("kind", t.kind());
        req.put("host", t.host());
        req.put("port", t.port());
        req.put("database", t.connectionDatabase());
        req.put("username", user);
        req.put("password", DbTargets.PASSWORD);
        req.put("tlsMode", "DISABLE");
        req.put("allowRawSql", rawSql);
        MvcResult r = call(post("/engine/v1/connections"), admin(), req);
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(201);
        return body(r).get("id").asString();
    }

    MvcResult query(String token, String connectionId, String sql, Map<String, Object> params, Integer limit, Integer timeoutMs, Integer maxAge)
            throws Exception {
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("connectionId", connectionId);
        req.put("sql", sql);
        if (params != null) req.put("params", params);
        if (limit != null) req.put("limit", limit);
        if (timeoutMs != null) req.put("timeoutMs", timeoutMs);
        if (maxAge != null) req.put("maxAgeSeconds", maxAge);
        return call(post("/engine/v1/queries/execute"), token, req);
    }

    static JsonNode corpus() throws Exception {
        return JsonMapper.builder().build().readTree(Files.readString(Path.of("..", "conformance", "corpus", "guard.json")));
    }

    // ---------------------------------------------------------------- the attack corpus, end to end

    @ParameterizedTest(name = "{0}: attack corpus changes nothing, on a writable and on a read-only account")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void attackCorpusIsRefusedAndNothingChanges(DbTargets.Target t) throws Exception {
        String before = DbTargets.snapshot(t);
        for (String user : new String[] {"curf_writer", "curf_reader"}) {
            String conn = createConnection(t, user, true);
            for (JsonNode attack : corpus().get("rejected")) {
                MvcResult r = query(admin(), conn, attack.get("sql").asString(), null, null, null, null);
                assertThat(r.getResponse().getStatus()).as("%s as %s: %s", attack.get("id").asString(), user, r.getResponse().getContentAsString())
                        .isEqualTo(422);
                assertThat(body(r).get("code").asString()).isEqualTo("CURF_SQL_REJECTED");
            }
        }
        assertThat(DbTargets.snapshot(t)).isEqualTo(before);
    }

    @ParameterizedTest(name = "{0}: harmless look-alikes run")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void harmlessLookAlikesRunReadOnly(DbTargets.Target t) throws Exception {
        String conn = createConnection(t, "curf_reader", true);
        for (JsonNode ok : corpus().get("accepted")) {
            Map<String, Object> params = ok.has("params")
                    ? json.convertValue(ok.get("params"), new tools.jackson.core.type.TypeReference<Map<String, Object>>() {})
                    : null;
            JsonNode variant = ok.path("variants").path(t.kind());
            String sql = variant.isString() ? variant.asString() : ok.get("sql").asString();
            MvcResult r = query(admin(), conn, sql, params, null, null, null);
            assertThat(r.getResponse().getStatus()).as("%s: %s", ok.get("id").asString(), r.getResponse().getContentAsString())
                    .isEqualTo(200);
            assertThat(body(r).get("rows").isArray()).isTrue();
        }
    }

    @ParameterizedTest(name = "{0}: the transaction itself is read-only even if the guard were bypassed")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void backendRefusesWritesEvenOnAWritableAccount(DbTargets.Target t) throws Exception {
        String before = DbTargets.snapshot(t);
        Connection connection = new Connection(UUID.randomUUID(), TENANT, "direct", ConnectionKind.valueOf(t.kind()), t.host(), t.port(),
                t.connectionDatabase(), "curf_writer", TlsMode.DISABLE, true, false, 1,
                Instant.now(), "t", Instant.now(), "t");
        var limits = new QueryLimits(100, Duration.ofSeconds(10), 1_000_000);
        // Oracle ends a transaction before any DDL statement (an implicit commit), so a read-only transaction cannot stop one there:
        // on Oracle only the account's rights and the guard stand in front of DDL, which is why the probe insists on a read-only account.
        // SQL Server has no read-only transaction, but its DDL is transactional, so the rollback undoes it.
        String[] writes = t.oracle()
                ? new String[] {"DELETE FROM guard_probe", "UPDATE guard_probe SET \"label\" = 'x'", "INSERT INTO guard_probe VALUES (99, 'x')"}
                : new String[] {"DELETE FROM guard_probe", "UPDATE guard_probe SET label = 'x'", "INSERT INTO guard_probe VALUES (99, 'x')",
                    "CREATE TABLE guard_new (a int)", "TRUNCATE TABLE guard_probe", "DROP TABLE guard_probe"};
        for (String write : writes) {
            assertThatThrownBy(() -> backend.execute(connection, DbTargets.PASSWORD, write, List.of(), limits)).as(write).isNotNull();
        }
        assertThat(DbTargets.snapshot(t)).isEqualTo(before);
    }

    // ---------------------------------------------------------------- connections and secrets

    @ParameterizedTest(name = "{0}: the account's privileges are inspected")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void connectionTestFlagsAccountsThatCanWrite(DbTargets.Target t) throws Exception {
        MvcResult writer = call(post("/engine/v1/connections/" + createConnection(t, "curf_writer", false) + "/test"), admin(), null);
        assertThat(writer.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(writer).get("ok").asBoolean()).isTrue();
        assertThat(body(writer).get("readOnlyVerified").asBoolean()).isFalse();
        if (t.trino()) {
            // Trino's permissions live in its own access-control rules, which the engine cannot inspect: it says so for every
            // account instead of claiming either one is read-only.
            assertThat(body(writer).get("warnings").toString()).contains("access-control").contains("TLS is disabled");
            MvcResult trinoReader = call(post("/engine/v1/connections/" + createConnection(t, "curf_reader", false) + "/test"), admin(), null);
            assertThat(body(trinoReader).get("readOnlyVerified").asBoolean()).as(trinoReader.getResponse().getContentAsString()).isFalse();
            assertThat(body(trinoReader).get("serverVersion").asString()).isNotBlank();
            return;
        }
        assertThat(body(writer).get("warnings").toString()).contains("can write").contains("TLS is disabled");

        MvcResult reader = call(post("/engine/v1/connections/" + createConnection(t, "curf_reader", false) + "/test"), admin(), null);
        assertThat(body(reader).get("readOnlyVerified").asBoolean()).as(reader.getResponse().getContentAsString()).isTrue();
        assertThat(body(reader).get("serverVersion").asString()).isNotBlank();
    }

    @ParameterizedTest(name = "{0}: the password is write-only and never stored in clear")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void secretsNeverLeak(DbTargets.Target t) throws Exception {
        String id = createConnection(t, "curf_reader", false);
        call(post("/engine/v1/connections/" + id + "/test"), admin(), null);

        for (String path : new String[] {"/engine/v1/connections/" + id, "/engine/v1/connections", "/engine/v1/audit-events?size=200"}) {
            MvcResult r = call(get(path), admin(), null);
            assertThat(r.getResponse().getContentAsString()).as(path).doesNotContain(DbTargets.PASSWORD).doesNotContain("secret");
        }
        String stored = jdbc.sql("select secret_ciphertext from engine_connection where id = :id")
                .param("id", UUID.fromString(id)).query(String.class).single();
        assertThat(stored).doesNotContain(DbTargets.PASSWORD);
        assertThat(jdbc.sql("select count(*) from engine_audit_event where details::text like :p")
                        .param("p", "%" + DbTargets.PASSWORD + "%").query(Long.class).single()).isZero();
        assertThat(jdbc.sql("select count(*) from engine_connection where id = :id and key_id = 'k1'")
                        .param("id", UUID.fromString(id)).query(Long.class).single()).isEqualTo(1L);
    }

    @ParameterizedTest(name = "{0}: connections are managed with optimistic locking")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void staleEditsAreRefusedAndTheOldPasswordSurvivesAnEditWithoutOne(DbTargets.Target t) throws Exception {
        String id = createConnection(t, "curf_reader", true);
        JsonNode current = body(call(get("/engine/v1/connections/" + id), admin(), null));
        Map<String, Object> edit = new LinkedHashMap<>();
        edit.put("name", current.get("name").asString() + "-renamed");
        edit.put("kind", t.kind());
        edit.put("host", t.host());
        edit.put("port", t.port());
        edit.put("database", current.get("database").asString());
        edit.put("username", "curf_reader");
        edit.put("tlsMode", "DISABLE");
        edit.put("allowRawSql", true);
        edit.put("version", current.get("version").asInt());

        MvcResult first = call(put("/engine/v1/connections/" + id), admin(), edit);
        assertThat(first.getResponse().getStatus()).as(first.getResponse().getContentAsString()).isEqualTo(200);
        assertThat(body(first).get("version").asInt()).isEqualTo(2);

        MvcResult stale = call(put("/engine/v1/connections/" + id), admin(), edit);
        assertThat(stale.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(stale).get("code").asString()).isEqualTo("CURF_STALE_VERSION");

        MvcResult stillWorks = query(admin(), id, "SELECT count(*) AS c FROM guard_probe", null, null, null, null);
        assertThat(stillWorks.getResponse().getStatus()).as(stillWorks.getResponse().getContentAsString()).isEqualTo(200);
    }

    @ParameterizedTest(name = "{0}: introspection lists tables and suggests PII columns")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void introspectionSuggestsPii(DbTargets.Target t) throws Exception {
        String id = createConnection(t, "curf_reader", false);
        MvcResult r = call(post("/engine/v1/connections/" + id + "/introspect"), admin(), null);
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(200);
        String text = r.getResponse().getContentAsString();
        assertThat(text.toLowerCase()).contains("pii_probe").contains("guard_probe").doesNotContain("pg_catalog").doesNotContain("information_schema");
        JsonNode columns = null;
        for (JsonNode schema : body(r).get("schemas")) {
            for (JsonNode table : schema.get("tables")) {
                if (table.get("name").asString().equalsIgnoreCase("pii_probe")) {
                    columns = table.get("columns");
                }
            }
        }
        assertThat(columns).isNotNull();
        Map<String, String> suggestions = new LinkedHashMap<>();
        columns.forEach(c -> suggestions.put(c.get("name").asString().toLowerCase(), c.get("piiSuggestion").asString()));
        assertThat(suggestions).containsEntry("email", "MASK").containsEntry("password_hash", "HIDE").containsEntry("note", "NONE");
    }

    // ---------------------------------------------------------------- limits, provenance, cache

    @ParameterizedTest(name = "{0}: row cap truncates and says so")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void rowCapTruncates(DbTargets.Target t) throws Exception {
        String conn = createConnection(t, "curf_reader", true);
        MvcResult r = query(admin(), conn, t.sql("SELECT id FROM guard_probe ORDER BY id"), null, 2, null, null);
        assertThat(body(r).get("rowCount").asInt()).isEqualTo(2);
        assertThat(body(r).get("truncated").asBoolean()).isTrue();

        MvcResult all = query(admin(), conn, t.sql("SELECT id FROM guard_probe ORDER BY id"), null, 10, null, null);
        assertThat(body(all).get("rowCount").asInt()).isEqualTo(3);
        assertThat(body(all).get("truncated").asBoolean()).isFalse();
    }

    @ParameterizedTest(name = "{0}: a runaway query is cancelled")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void timeoutKillsRunawayQueries(DbTargets.Target t) throws Exception {
        String conn = createConnection(t, "curf_reader", true);
        long started = System.nanoTime();
        MvcResult r = query(admin(), conn, t.heavySql(), null, null, 500, null);
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(504);
        assertThat(body(r).get("code").asString()).isEqualTo("CURF_QUERY_TIMEOUT");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(15));
    }

    @ParameterizedTest(name = "{0}: provenance hash follows the data")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void provenanceHashIsStableAndSensitive(DbTargets.Target t) throws Exception {
        String conn = createConnection(t, "curf_reader", true);
        String sql = t.sql("SELECT id, label FROM guard_probe WHERE id <= :max ORDER BY id");
        String a = body(query(admin(), conn, sql, Map.of("max", 2), null, null, null)).get("provenance").get("sha256").asString();
        String again = body(query(admin(), conn, sql, Map.of("max", 2), null, null, null)).get("provenance").get("sha256").asString();
        String otherParam = body(query(admin(), conn, sql, Map.of("max", 3), null, null, null)).get("provenance").get("sha256").asString();
        assertThat(again).isEqualTo(a);
        assertThat(otherParam).isNotEqualTo(a);

        String schema = t.qualified("").replaceAll("\\.$", "") + ".";
        try (java.sql.Connection c = DbTargets.adminConnection(t); Statement st = c.createStatement()) {
            // Trino's in-memory tables cannot update or delete rows: add one, and rebuild the tables afterwards.
            st.execute(t.trino() ? "insert into " + schema + "guard_probe values (0, 'changed')"
                    : t.sql("update " + schema + "guard_probe set label = 'changed' where id = 1"));
            try {
                String changed = body(query(admin(), conn, sql, Map.of("max", 2), null, null, null)).get("provenance").get("sha256").asString();
                assertThat(changed).isNotEqualTo(a);
            } finally {
                if (t.trino()) {
                    DbTargets.prepare(t);
                } else {
                    st.execute(t.sql("update " + schema + "guard_probe set label = 'one' where id = 1"));
                }
            }
        }
        JsonNode result = body(query(admin(), conn, sql, Map.of("max", 2), null, null, null));
        assertThat(result.get("provenance").get("connectionFingerprint").asString()).hasSize(64);
        assertThat(result.get("asOf").asString()).isNotBlank();
    }

    @ParameterizedTest(name = "{0}: cached answers are never shared across different viewers")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void cacheIsScopedToTheViewer(DbTargets.Target t) throws Exception {
        String conn = createConnection(t, "curf_reader", true);
        String sql = t.sql("SELECT count(*) AS c FROM guard_probe WHERE id > :n");
        Map<String, Object> params = Map.of("n", UUID.randomUUID().hashCode() % 1000 - 2000);

        assertThat(body(query(admin(), conn, sql, params, null, null, 60)).get("cache").asString()).isEqualTo("miss");
        assertThat(body(query(admin(), conn, sql, params, null, null, 60)).get("cache").asString()).isEqualTo("hit");
        assertThat(body(query(developer(), conn, sql, params, null, null, 60)).get("cache").asString())
                .as("a viewer with different roles must not read the admin's cached result").isEqualTo("miss");
        assertThat(body(query(admin(), conn, sql, params, null, null, null)).get("cache").asString()).isEqualTo("miss");
    }

    // ---------------------------------------------------------------- who may do what

    @ParameterizedTest(name = "{0}: permissions, raw-SQL switch and tenant isolation")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void authorizationAndTenantIsolation(DbTargets.Target t) throws Exception {
        String raw = createConnection(t, "curf_reader", true);
        String noRaw = createConnection(t, "curf_reader", false);
        String sql = "SELECT 1 AS one";

        assertThat(query(viewer(), raw, sql, null, null, null, null).getResponse().getStatus()).isEqualTo(403);
        assertThat(query(developer(), raw, sql, null, null, null, null).getResponse().getStatus()).isEqualTo(200);
        assertThat(query(admin(), noRaw, sql, null, null, null, null).getResponse().getStatus()).isEqualTo(403);

        assertThat(call(get("/engine/v1/connections"), developer(), null).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(post("/engine/v1/connections/" + raw + "/test"), viewer(), null).getResponse().getStatus()).isEqualTo(403);

        String stranger = TestIdp.bearer(OTHER_TENANT, "stranger", "curf-admin");
        assertThat(call(get("/engine/v1/connections/" + raw), stranger, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(query(stranger, raw, sql, null, null, null, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(call(delete("/engine/v1/connections/" + raw), stranger, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(body(call(get("/engine/v1/connections?size=200"), stranger, null)).get("totalElements").asInt()).isZero();
    }

    @ParameterizedTest(name = "{0}: hosts and names that could smuggle driver options are refused")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void hostileConnectionSettingsAreRefused(DbTargets.Target t) throws Exception {
        Map<String, Object> base = new LinkedHashMap<>();
        base.put("name", "bad-" + UUID.randomUUID());
        base.put("kind", t.kind());
        base.put("host", t.host());
        base.put("database", "db");
        base.put("username", "u");
        base.put("password", "p");

        for (Map.Entry<String, Object> bad : List.<Map.Entry<String, Object>>of(
                Map.entry("host", "169.254.169.254"),
                Map.entry("host", "db.internal;evil"),
                Map.entry("host", "db/../x"),
                Map.entry("database", "db?allowLoadLocalInfile=true"),
                Map.entry("database", "db&x=y"),
                Map.entry("port", 70000),
                Map.entry("kind", "DB2"))) {
            Map<String, Object> req = new LinkedHashMap<>(base);
            req.put(bad.getKey(), bad.getValue());
            MvcResult r = call(post("/engine/v1/connections"), admin(), req);
            assertThat(r.getResponse().getStatus()).as(bad.toString()).isEqualTo(422);
        }
        assertThat(call(post("/engine/v1/connections"), admin(), Map.of("name", "x")).getResponse().getStatus()).isEqualTo(422);
    }

    @ParameterizedTest(name = "{0}: deleting a connection removes it and is audited")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void deleteRemovesAndAudits(DbTargets.Target t) throws Exception {
        String id = createConnection(t, "curf_reader", true);
        assertThat(call(delete("/engine/v1/connections/" + id), admin(), null).getResponse().getStatus()).isEqualTo(204);
        assertThat(call(get("/engine/v1/connections/" + id), admin(), null).getResponse().getStatus()).isEqualTo(404);
        assertThat(query(admin(), id, "SELECT 1", null, null, null, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(body(call(get("/engine/v1/audit-events?entityId=" + id), admin(), null)).get("totalElements").asInt())
                .isGreaterThanOrEqualTo(2);
    }

    @ParameterizedTest(name = "{0}: every statement leaves a log row with hashes only")
    @MethodSource("com.enterprisex.curf.engine.DbTargets#targets")
    void queryLogHoldsHashesNotValues(DbTargets.Target t) throws Exception {
        String conn = createConnection(t, "curf_reader", true);
        String marker = "personal-data-" + UUID.randomUUID();
        query(admin(), conn, "SELECT CAST(:v AS CHAR(100)) AS v", Map.of("v", marker), null, null, null);
        query(admin(), conn, "DROP TABLE guard_probe", null, null, null, null);

        var rows = jdbc.sql("select outcome, params_hash, sql_hash from engine_query_log where connection_id = :id order by occurred_at")
                .param("id", UUID.fromString(conn)).query((rs, n) -> rs.getString(1) + "|" + rs.getString(2) + "|" + rs.getString(3)).list();
        assertThat(rows).hasSize(2);
        assertThat(rows.get(0)).startsWith("ok|").doesNotContain(marker);
        assertThat(rows.get(1)).startsWith("rejected|");
    }
}
