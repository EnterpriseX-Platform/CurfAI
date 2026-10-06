package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.enterprisex.curf.engine.DbTargets.Target;
import com.enterprisex.curf.engine.application.report.CurfHashes;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

/**
 * Reports in Curf's own format, stored with versions and run as the person asking, end to end over HTTP on every
 * database: governed queries through views (row rules and masking apply), raw administrator queries, parameters
 * as Curf binds them, drill-only queries skipped, one failing query not sinking the report.
 */
@EngineIT
class ReportIT extends ApiSupport {

    static final String SRC = "com.enterprisex.curf.engine.DbTargets#targets";

    // ---------------------------------------------------------------- building Curf definitions

    static Map<String, Object> param(String name, String type, Object fallback, boolean required) {
        Map<String, Object> p = req("name", name, "label", name, "type", type, "required", required);
        if (fallback != null) {
            p.put("default", fallback);
        }
        return p;
    }

    /** A governed query: Curf's data source fields plus an engine binding to a view. */
    static Map<String, Object> viewQuery(String id, String view, Map<String, Object> binding) {
        Map<String, Object> engine = new LinkedHashMap<>(binding);
        engine.put("viewId", view);
        return req("id", id, "name", "Query " + id, "dataSourceId", view, "engine", engine);
    }

    static Map<String, Object> rawQuery(String id, String connection, String sql) {
        return req("id", id, "name", "Query " + id, "dataSourceId", connection, "sql", sql);
    }

    static Map<String, Object> block(String id, String type, Map<String, Object> config) {
        return req("id", id, "type", type, "x", 0, "y", 0, "w", 12, "h", 4, "config", config);
    }

    static Map<String, Object> definition(String name, List<Map<String, Object>> parameters, List<Map<String, Object>> queries,
            List<Map<String, Object>> blocks) {
        return req("version", 1, "name", name, "parameters", parameters, "dataSources", queries,
                "pages", List.of(req("id", "p1", "size", "A4", "orientation", "portrait", "blocks", blocks)));
    }

    static Map<String, Object> saved(Map<String, Object> definition, Object... more) {
        Map<String, Object> body = req("definition", definition);
        for (int i = 0; i < more.length; i += 2) {
            body.put((String) more[i], more[i + 1]);
        }
        return body;
    }

    String createReport(Map<String, Object> body) throws Exception {
        MvcResult r = call(post("/engine/v1/reports"), admin(), body);
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        String id = body(r).get("id").asString();
        publishReport(id);
        return id;
    }

    MvcResult run(String token, String report, Map<String, Object> params) throws Exception {
        return call(post("/engine/v1/reports/" + report + "/run"), token, req("params", params));
    }

    static String unique(String prefix) {
        return prefix + "-" + UUID.randomUUID();
    }

    /** The standard report: rows and totals through one view, filtered by the report's parameters. */
    Map<String, Object> agencyReport(String name, String view) {
        return definition(name,
                List.of(param("from", "date", "2026-01-01", false), param("min", "number", 0, false), param("agency", "string", null, false)),
                List.of(
                        viewQuery("ds_rows", view, req(
                                "columns", List.of("id", "agency_code", "name", "email", "amount"),
                                "filters", List.of(
                                        req("column", "created", "op", "GE", "value", req("$param", "from")),
                                        req("column", "amount", "op", "GE", "value", req("$param", "min")),
                                        req("column", "agency_code", "op", "EQ", "value", req("$param", "agency"), "skipIfEmpty", true)),
                                "orderBy", List.of(req("column", "id", "descending", false)))),
                        viewQuery("ds_totals", view, req(
                                "groupBy", List.of("agency_code"),
                                "aggregates", List.of(req("fn", "SUM", "column", "amount", "as", "total"), req("fn", "COUNT")),
                                "orderBy", List.of(req("column", "agency_code", "descending", false))))),
                List.of(block("b_table", "table", req("queryId", "ds_rows", "title", "รายชื่อ")),
                        block("b_chart", "chart", req("queryId", "ds_totals", "chartType", "bar", "xField", "agency_code", "yFields", List.of("total")))));
    }

    static List<Integer> ids(JsonNode result, String query) {
        List<Integer> out = new ArrayList<>();
        result.get("dataset").get(query).forEach(r -> out.add(r.get("id").asInt()));
        return out.stream().sorted().toList();
    }

    // ---------------------------------------------------------------- storing

    @ParameterizedTest(name = "{0}: Curf's own definition is stored as sent, with every save kept and restorable")
    @MethodSource(SRC)
    void savingKeepsTheDefinitionVerbatimWithVersionsAndRestore(Target t) throws Exception {
        String view = publishedView(t);
        Map<String, Object> v1 = agencyReport("รายงาน " + unique("หน่วยงาน"), view);
        String id = createReport(saved(v1, "runRoles", List.of("analyst"), "note", "first"));

        JsonNode got = body(call(get("/engine/v1/reports/" + id), admin(), null));
        assertThat(got.get("definition")).isEqualTo(json.valueToTree(v1));
        assertThat(got.get("version").asInt()).isEqualTo(1);
        assertThat(got.get("name").asString()).isEqualTo(v1.get("name"));

        Map<String, Object> v2 = agencyReport((String) v1.get("name"), view);
        v2.put("description", "second");
        MvcResult updated = call(put("/engine/v1/reports/" + id), admin(), saved(v2, "version", 1, "runRoles", List.of("analyst"), "note", "added a description"));
        assertThat(updated.getResponse().getStatus()).as(updated.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        assertThat(body(updated).get("version").asInt()).isEqualTo(2);

        JsonNode versions = body(call(get("/engine/v1/reports/" + id + "/versions"), admin(), null));
        assertThat(versions.valueStream().map(x -> x.get("version").asInt()).toList()).containsExactly(2, 1);
        assertThat(versions.get(0).get("note").asString()).isEqualTo("added a description");
        assertThat(body(call(get("/engine/v1/reports/" + id + "/versions/1"), admin(), null))).isEqualTo(json.valueToTree(v1));

        MvcResult restored = call(post("/engine/v1/reports/" + id + "/restore/1"), admin(), null);
        assertThat(restored.getResponse().getStatus()).isEqualTo(200);
        assertThat(body(restored).get("version").asInt()).as("restoring adds a version, history is not rewritten").isEqualTo(3);
        assertThat(body(restored).get("definition")).isEqualTo(json.valueToTree(v1));
        assertThat(body(call(get("/engine/v1/reports/" + id + "/versions"), admin(), null)).get(0).get("note").asString()).isEqualTo("Restored from version 1");

        MvcResult stale = call(put("/engine/v1/reports/" + id), admin(), saved(v2, "version", 1));
        assertThat(stale.getResponse().getStatus()).isEqualTo(409);
        assertThat(body(stale).get("code").asString()).isEqualTo("CURF_STALE_VERSION");
        assertThat(call(put("/engine/v1/reports/" + id), admin(), saved(v2)).getResponse().getStatus()).as("version required").isEqualTo(422);
        assertThat(call(post("/engine/v1/reports/" + id + "/restore/99"), admin(), null).getResponse().getStatus()).isEqualTo(404);

        assertThat(call(post("/engine/v1/reports"), admin(), saved(v1)).getResponse().getStatus()).as("a name is unique").isEqualTo(422);
        assertThat(call(delete("/engine/v1/reports/" + id), admin(), null).getResponse().getStatus()).isEqualTo(204);
        assertThat(call(get("/engine/v1/reports/" + id), admin(), null).getResponse().getStatus()).isEqualTo(404);
    }

    @ParameterizedTest(name = "{0}: what is saved is audited without the definition")
    @MethodSource(SRC)
    void theAuditTrailNamesTheReportButNeverItsContents(Target t) throws Exception {
        String conn = connection(t);
        String secret = "SELECT secret_marker_" + UUID.randomUUID().toString().replace("-", "") + " FROM agency_data";
        Map<String, Object> d = definition(unique("audit"), List.of(), List.of(rawQuery("q", conn, secret)), List.of(block("b", "table", req("queryId", "q"))));
        String id = createReport(saved(d));

        String audit = call(get("/engine/v1/audit-events?entityId=" + id), admin(), null).getResponse().getContentAsString();
        assertThat(audit).contains("report.create").doesNotContain("secret_marker");
    }

    @ParameterizedTest(name = "{0}: definitions the engine cannot run are refused with a reason")
    @MethodSource(SRC)
    void invalidDefinitionsAreRefused(Target t) throws Exception {
        String view = publishedView(t);
        String conn = connection(t);
        Map<String, Object> ok = agencyReport(unique("ok"), view);

        List<Map<String, Object>> bad = new ArrayList<>();
        bad.add(with(copy(ok), "version", 2));
        bad.add(with(copy(ok), "pages", List.of()));
        bad.add(with(copy(ok), "dataSources", List.of(rawQuery("q", conn, "DELETE FROM agency_data"))));
        bad.add(with(copy(ok), "dataSources", List.of(viewQuery("ds_rows", UUID.randomUUID().toString(), req()))));
        bad.add(with(copy(ok), "dataSources", List.of(req("id", "q", "name", "Q", "dataSourceId", conn, "sql", "select 1", "joins",
                List.of(req("type", "left", "queryId", "q", "on", req("left", "a", "right", "b"), "alias", "x"))))));
        bad.add(with(copy(ok), "dataSources", List.of(req("id", "q", "name", "Q", "dataSourceId", conn, "method", "GET", "path", "/x", "sql", "select 1"))));
        for (Map<String, Object> d : bad) {
            MvcResult r = call(post("/engine/v1/reports"), admin(), saved(d));
            assertThat(r.getResponse().getStatus()).as(d.toString()).isEqualTo(422);
            assertThat(body(r).get("code").asString()).isEqualTo("CURF_INVALID_INPUT");
        }
        assertThat(call(post("/engine/v1/reports"), admin(), req("definition", "not an object")).getResponse().getStatus()).isEqualTo(422);
    }

    // ---------------------------------------------------------------- running

    @ParameterizedTest(name = "{0}: a run has Curf's shape and every viewer gets their own rows and masks")
    @MethodSource(SRC)
    void runReturnsCurfsShapeUnderEachViewersPolicy(Target t) throws Exception {
        String view = publishedView(t);
        String id = createReport(saved(agencyReport(unique("agency"), view), "runRoles", List.of("analyst", "hr", "auditor")));

        JsonNode mine = ok(run(analyst("A001"), id, Map.of()));
        for (String field : List.of("dataset", "provenance", "params", "reportVersion", "asOf")) {
            assertThat(mine.has(field)).as(field).isTrue();
        }
        assertThat(ids(mine, "ds_rows")).containsExactly(1, 2, 3);
        assertThat(mine.get("dataset").get("ds_rows").get(0).get("email").asString()).isEqualTo("***");
        assertThat(mine.get("dataset").get("ds_totals")).hasSize(1);
        assertThat(mine.get("dataset").get("ds_totals").get(0).get("agency_code").asString()).isEqualTo("A001");
        assertThat(mine.get("params").get("from").asString()).isEqualTo("2026-01-01");
        assertThat(mine.get("params").get("min").asInt()).isEqualTo(0);
        assertThat(mine.get("params").get("agency").asString()).isEmpty();

        JsonNode p = mine.get("provenance").get("ds_rows");
        assertThat(p.get("queryId").asString()).isEqualTo("ds_rows");
        assertThat(p.get("queryName").asString()).isEqualTo("Query ds_rows");
        assertThat(p.get("dataSourceKind").asString()).isIn("postgres", "mysql", "oracle", "mssql", "trino");
        assertThat(p.get("dataSourceName").asString()).startsWith("agency-");
        assertThat(p.get("rowCount").asInt()).isEqualTo(3);
        assertThat(p.get("dataHash").asString()).matches("sha256:[0-9a-f]{24}");
        assertThat(p.get("queryHash").asString()).matches("sha256:[0-9a-f]{24}");
        assertThat(p.get("runAt").asString()).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z");
        assertThat(p.has("executionError")).isFalse();
        assertThat(p.has("accessDeniedNote")).isFalse();

        assertThat(ids(ok(run(analyst("A002"), id, Map.of())), "ds_rows")).containsExactly(4, 5);
        assertThat(ids(ok(run(person("auditor-1", null, "auditor"), id, Map.of())), "ds_rows")).containsExactly(1, 2, 3, 4, 5, 6, 7);
        JsonNode hr = ok(run(person("hr-1", "A001", "hr"), id, Map.of()));
        assertThat(hr.get("dataset").get("ds_rows").get(0).get("email").asString()).isEqualTo("somchai@a001.go.th");

        String a = mine.get("provenance").get("ds_rows").get("dataHash").asString();
        assertThat(ok(run(analyst("A001"), id, Map.of())).get("provenance").get("ds_rows").get("dataHash").asString()).isEqualTo(a);
        assertThat(ok(run(analyst("A002"), id, Map.of())).get("provenance").get("ds_rows").get("dataHash").asString()).isNotEqualTo(a);
    }

    @ParameterizedTest(name = "{0}: the data hash is Curf's own, computed over the rows as returned")
    @MethodSource(SRC)
    void dataHashesFollowCurfsAlgorithm(Target t) throws Exception {
        String view = publishedView(t);
        Map<String, Object> d = definition(unique("hash"), List.of(),
                List.of(viewQuery("ds", view, req("columns", List.of("id", "agency_code"), "orderBy", List.of(req("column", "id", "descending", false))))),
                List.of(block("b", "table", req("queryId", "ds"))));
        String id = createReport(saved(d, "runRoles", List.of("analyst")));

        JsonNode result = ok(run(analyst("A001"), id, Map.of()));
        List<Map<String, Object>> rows = new ArrayList<>();
        result.get("dataset").get("ds").forEach(r -> rows.add(json.convertValue(r, new tools.jackson.core.type.TypeReference<Map<String, Object>>() {})));
        assertThat(result.get("provenance").get("ds").get("dataHash").asString()).isEqualTo(CurfHashes.rows(rows));
    }

    @ParameterizedTest(name = "{0}: parameters are bound the way Curf binds them, and checked")
    @MethodSource(SRC)
    void parametersAreAppliedAndValidated(Target t) throws Exception {
        String view = publishedView(t);
        String id = createReport(saved(agencyReport(unique("params"), view), "runRoles", List.of("analyst")));
        String me = analyst("A001");

        assertThat(ids(ok(run(me, id, Map.of("from", "2026-02-15"))), "ds_rows")).containsExactly(3);
        assertThat(ids(ok(run(me, id, Map.of("min", 100))), "ds_rows")).containsExactly(1, 2);
        assertThat(ids(ok(run(me, id, Map.of("min", "100", "from", "2026-02-01"))), "ds_rows")).containsExactly(2);
        assertThat(ids(ok(run(me, id, Map.of("agency", ""))), "ds_rows")).as("blank means no filter").containsExactly(1, 2, 3);
        assertThat(ids(ok(run(me, id, Map.of("agency", "A001"))), "ds_rows")).containsExactly(1, 2, 3);
        assertThat(ids(ok(run(me, id, Map.of("agency", "A002"))), "ds_rows")).as("a filter cannot widen the row rule").isEmpty();

        for (Map<String, Object> bad : List.<Map<String, Object>>of(
                Map.of("from", "31/01/2026"), Map.of("min", "abc"), Map.of("typo", "x"), Map.of("from", List.of("x")))) {
            MvcResult r = run(me, id, bad);
            assertThat(r.getResponse().getStatus()).as(bad.toString()).isEqualTo(422);
            assertThat(body(r).get("errors").toString()).contains("params.");
        }
    }

    @ParameterizedTest(name = "{0}: administrators can run Curf-style raw SQL with :params and ::casts")
    @MethodSource(SRC)
    void rawQueriesRunForAdministrators(Target t) throws Exception {
        String conn = connection(t);
        // connection() creates a connection with raw SQL off; switch it on.
        JsonNode current = body(call(get("/engine/v1/connections/" + conn), admin(), null));
        Map<String, Object> edit = req("name", current.get("name").asString(), "kind", t.kind(), "host", t.host(), "port", t.port(),
                "database", current.get("database").asString(), "username", "curf_reader", "tlsMode", "DISABLE", "allowRawSql", true,
                "version", current.get("version").asInt());
        assertThat(call(put("/engine/v1/connections/" + conn), admin(), edit).getResponse().getStatus()).isEqualTo(200);

        // Oracle reads a text date by the session's settings, so its author names the format; Trino will not compare a date with
        // text at all, so its author casts.
        String sql = t.oracle()
                ? t.sql("SELECT agency_code, count(*) AS \"n\" FROM agency_data WHERE created >= TO_DATE(:from, 'YYYY-MM-DD') AND amount >= :min GROUP BY agency_code ORDER BY agency_code")
                : t.trino()
                ? "SELECT agency_code, count(*) AS n FROM agency_data WHERE created >= CAST(:from AS DATE) AND amount >= :min GROUP BY agency_code ORDER BY agency_code"
                : "SELECT agency_code, count(*) AS n FROM agency_data WHERE created >= :from AND amount >= :min GROUP BY agency_code ORDER BY agency_code";
        Map<String, Object> d = definition(unique("raw"), List.of(param("from", "date", "2026-01-01", false), param("min", "number", 0, false)),
                List.of(rawQuery("ds_raw", conn, sql)), List.of(block("b", "table", req("queryId", "ds_raw"))));
        String id = createReport(saved(d, "runRoles", List.of("analyst")));

        JsonNode result = ok(run(admin(), id, Map.of("from", "2026-02-01", "min", 50)));
        JsonNode rows = result.get("dataset").get("ds_raw");
        // created >= 2026-02-01 and amount >= 50: ids 2 and 3 (A001) and 6 (B001).
        assertThat(rows).hasSize(2);
        assertThat(rows.get(0).get("agency_code").asString()).isEqualTo("A001");
        assertThat(rows.get(0).get("n").asInt()).isEqualTo(2);
        assertThat(rows.get(1).get("agency_code").asString()).isEqualTo("B001");
        assertThat(rows.get(1).get("n").asInt()).isEqualTo(1);
        assertThat(result.get("provenance").get("ds_raw").get("queryHash").asString())
                .isEqualTo(CurfHashes.queryDefinition(sql, Map.of("from", "2026-02-01", "min", 50L)));

        JsonNode asAnalyst = ok(run(analyst("A001"), id, Map.of()));
        assertThat(asAnalyst.get("dataset").get("ds_raw")).as("raw SQL is not for viewers").isEmpty();
        assertThat(asAnalyst.get("provenance").get("ds_raw").get("accessDeniedNote").asString()).isNotBlank();
    }

    @ParameterizedTest(name = "{0}: one failing query leaves an empty dataset and an error, not a failed report")
    @MethodSource(SRC)
    void aFailingQueryDoesNotSinkTheReport(Target t) throws Exception {
        String view = publishedView(t);
        String conn = connection(t);
        JsonNode current = body(call(get("/engine/v1/connections/" + conn), admin(), null));
        call(put("/engine/v1/connections/" + conn), admin(), req("name", current.get("name").asString(), "kind", t.kind(), "host", t.host(),
                "port", t.port(), "database", current.get("database").asString(), "username", "curf_reader", "tlsMode", "DISABLE",
                "allowRawSql", true, "version", current.get("version").asInt()));

        Map<String, Object> d = definition(unique("failing"), List.of(),
                List.of(rawQuery("ds_bad", conn, "SELECT * FROM no_such_table_here"),
                        viewQuery("ds_good", view, req("columns", List.of("id")))),
                List.of(block("b1", "table", req("queryId", "ds_bad")), block("b2", "table", req("queryId", "ds_good"))));
        String id = createReport(saved(d));

        MvcResult r = run(admin(), id, Map.of());
        assertThat(r.getResponse().getStatus()).as("failures stay in the provenance").isEqualTo(200);
        JsonNode result = body(r);
        assertThat(result.get("dataset").get("ds_bad")).isEmpty();
        assertThat(result.get("provenance").get("ds_bad").get("executionError").asString()).isNotBlank().hasSizeLessThanOrEqualTo(500);
        assertThat(result.get("provenance").get("ds_bad").get("rowCount").asInt()).isZero();
        assertThat(result.get("provenance").get("ds_good").has("executionError")).isFalse();
    }

    @ParameterizedTest(name = "{0}: queries only a drill-down uses are not run with the report")
    @MethodSource(SRC)
    void drillOnlyQueriesAreSkipped(Target t) throws Exception {
        String view = publishedView(t);
        Map<String, Object> chart = block("b", "chart", req("queryId", "ds_main", "chartType", "bar",
                "drilldown", req("queryId", "ds_detail", "filterParam", "agency")));
        Map<String, Object> d = definition(unique("drill"), List.of(param("agency", "string", null, false)),
                List.of(viewQuery("ds_main", view, req("columns", List.of("id"))), viewQuery("ds_detail", view, req("columns", List.of("id", "name")))),
                List.of(chart));
        String id = createReport(saved(d, "runRoles", List.of("analyst")));

        JsonNode result = ok(run(analyst("A001"), id, Map.of()));
        assertThat(result.get("dataset").has("ds_main")).isTrue();
        assertThat(result.get("dataset").has("ds_detail")).isFalse();
        assertThat(result.get("provenance").has("ds_detail")).isFalse();
    }

    @ParameterizedTest(name = "{0}: a data source the viewer may not use is noted, not thrown")
    @MethodSource(SRC)
    void accessDeniedIsRecordedInProvenance(Target t) throws Exception {
        String conn = connection(t);
        Map<String, Object> restricted = viewBody(conn);
        restricted.put("allowedRoles", List.of("staff-only"));
        String closedView = createView(restricted, true);
        String draftView = createView(viewBody(conn), false);
        String openView = publishedView(t);

        Map<String, Object> d = definition(unique("denied"), List.of(),
                List.of(viewQuery("ds_closed", closedView, req("columns", List.of("id"))),
                        viewQuery("ds_draft", draftView, req("columns", List.of("id"))),
                        viewQuery("ds_open", openView, req("columns", List.of("id")))),
                List.of(block("b1", "table", req("queryId", "ds_closed")), block("b2", "table", req("queryId", "ds_draft")),
                        block("b3", "table", req("queryId", "ds_open"))));
        String id = createReport(saved(d, "runRoles", List.of("analyst")));

        MvcResult r = run(analyst("A001"), id, Map.of());
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        JsonNode result = body(r);
        for (String denied : List.of("ds_closed", "ds_draft")) {
            assertThat(result.get("dataset").get(denied)).as(denied).isEmpty();
            assertThat(result.get("provenance").get(denied).get("accessDeniedNote").asString()).isNotBlank();
            assertThat(result.get("provenance").get(denied).has("executionError")).isFalse();
        }
        assertThat(result.get("dataset").get("ds_open")).isNotEmpty();
    }

    // ---------------------------------------------------------------- who may do what

    @ParameterizedTest(name = "{0}: who may run, see and change a report")
    @MethodSource(SRC)
    void authorizationAndWhatRunnersSee(Target t) throws Exception {
        String view = publishedView(t);
        String id = createReport(saved(agencyReport(unique("access"), view), "runRoles", List.of("analyst")));
        String conn = connection(t);
        String withSql = createReport(saved(definition(unique("sql"), List.of(), List.of(rawQuery("q", conn, "SELECT 1 AS one")),
                List.of(block("b", "table", req("queryId", "q"))))));

        assertThat(run(person("s", "A001", "stranger"), id, Map.of()).getResponse().getStatus()).isEqualTo(404);
        assertThat(run(analyst("A001"), withSql, Map.of()).getResponse().getStatus()).as("no run roles: editors only").isEqualTo(404);
        String otherTenant = TestIdp.bearerWith(OTHER_TENANT, "admin", Map.of(), "curf-admin");
        assertThat(run(otherTenant, id, Map.of()).getResponse().getStatus()).isEqualTo(404);
        assertThat(call(get("/engine/v1/reports/" + id), otherTenant, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(call(delete("/engine/v1/reports/" + id), otherTenant, null).getResponse().getStatus()).isEqualTo(404);

        String me = analyst("A001");
        assertThat(call(post("/engine/v1/reports"), me, saved(agencyReport(unique("x"), view))).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(put("/engine/v1/reports/" + id), me, saved(agencyReport(unique("x"), view), "version", 1)).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(delete("/engine/v1/reports/" + id), me, null).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(get("/engine/v1/reports/" + id + "/versions"), me, null).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(post("/engine/v1/reports/" + id + "/restore/1"), me, null).getResponse().getStatus()).isEqualTo(403);

        JsonNode asRunner = body(call(get("/engine/v1/reports/" + id), me, null));
        String text = asRunner.toString();
        assertThat(text).contains("ds_rows").contains("b_table").contains("\"parameters\"");
        assertThat(text).as("runners get no SQL, bindings or data source ids").doesNotContain("engine").doesNotContain("dataSourceId")
                .doesNotContain(view).doesNotContain("filters");

        String listing = call(get("/engine/v1/reports"), me, null).getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(listing).contains(id).doesNotContain(withSql);
        String full = call(get("/engine/v1/reports?size=200"), admin(), null).getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(full).contains(id).contains(withSql);
    }

    @ParameterizedTest(name = "{0}: Thai report names, parameters and data go through intact")
    @MethodSource(SRC)
    void thaiTextSurvives(Target t) throws Exception {
        String view = publishedView(t);
        Map<String, Object> d = definition("รายงานผลการดำเนินงาน " + UUID.randomUUID(), List.of(param("ที่อยู่", "string", null, false)),
                List.of(viewQuery("ds", view, req("columns", List.of("id", "ที่อยู่"),
                        "filters", List.of(req("column", "ที่อยู่", "op", "EQ", "value", req("$param", "ที่อยู่"), "skipIfEmpty", true))))),
                List.of(block("b", "table", req("queryId", "ds", "title", "ตาราง"))));
        // Parameter names are plain identifiers, so a Thai parameter name is refused...
        assertThat(call(post("/engine/v1/reports"), admin(), saved(d)).getResponse().getStatus()).isEqualTo(422);

        // ...while Thai names, values and column names are fine everywhere else.
        d = definition("รายงานผลการดำเนินงาน " + UUID.randomUUID(), List.of(param("addr", "string", null, false)),
                List.of(viewQuery("ds", view, req("columns", List.of("id", "ที่อยู่"),
                        "filters", List.of(req("column", "ที่อยู่", "op", "EQ", "value", req("$param", "addr"), "skipIfEmpty", true))))),
                List.of(block("b", "table", req("queryId", "ds", "title", "ตาราง"))));
        String id = createReport(saved(d, "runRoles", List.of("hr")));
        assertThat(body(call(get("/engine/v1/reports/" + id), admin(), null)).get("name").asString()).startsWith("รายงานผลการดำเนินงาน");

        JsonNode result = ok(run(person("hr-1", "A001", "hr"), id, Map.of("addr", "กรุงเทพ")));
        assertThat(ids(result, "ds")).containsExactly(1);
        assertThat(result.get("dataset").get("ds").get(0).get("ที่อยู่").asString()).isEqualTo("กรุงเทพ");
        assertThat(result.get("params").get("addr").asString()).isEqualTo("กรุงเทพ");
    }

    // ---------------------------------------------------------------- helpers

    private static Map<String, Object> copy(Map<String, Object> m) {
        return new LinkedHashMap<>(m);
    }

    private static Map<String, Object> with(Map<String, Object> map, String key, Object value) {
        map.put(key, value);
        return map;
    }
}
