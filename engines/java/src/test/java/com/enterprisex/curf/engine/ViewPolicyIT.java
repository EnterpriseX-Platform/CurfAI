package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.enterprisex.curf.engine.DbTargets.Target;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Views, row-level security and PII masking end to end over HTTP on every database. The fixture is
 * agency_data: three rows for A001, two for A002, one for B001 and one with no agency at all.
 */
@EngineIT
class ViewPolicyIT extends ApiSupport {

    static final String SRC = "com.enterprisex.curf.engine.DbTargets#targets";
    // ---------------------------------------------------------------- row-level security

    @ParameterizedTest(name = "{0}: each agency sees only its own rows")
    @MethodSource(SRC)
    void rowLevelSecurityGivesEachAgencyItsOwnRows(Target t) throws Exception {
        String view = publishedView(t);

        assertThat(ids(ok(query(analyst("A001"), view, Map.of())))).containsExactly(1, 2, 3);
        assertThat(ids(ok(query(analyst("A002"), view, Map.of())))).containsExactly(4, 5);
        assertThat(ids(ok(query(analyst("B001"), view, Map.of())))).containsExactly(6);
        assertThat(ids(ok(query(analyst("Z999"), view, Map.of())))).isEmpty();
    }

    @ParameterizedTest(name = "{0}: several values mean several agencies")
    @MethodSource(SRC)
    void aViewerHoldingSeveralValuesSeesAllOfThem(Target t) throws Exception {
        String view = publishedView(t);
        assertThat(ids(ok(query(analyst(List.of("A001", "A002")), view, Map.of())))).containsExactly(1, 2, 3, 4, 5);
    }

    @ParameterizedTest(name = "{0}: no attribute means no rows, not all rows")
    @MethodSource(SRC)
    void aViewerWithoutTheAttributeSeesNothing(Target t) throws Exception {
        String view = publishedView(t);
        JsonNode result = ok(query(analyst(null), view, Map.of()));

        assertThat(result.get("rows")).isEmpty();
        assertThat(result.get("columns")).isNotEmpty();
    }

    @ParameterizedTest(name = "{0}: roles on the bypass list are exempt from row rules")
    @MethodSource(SRC)
    void bypassRolesSeeEveryRowIncludingThoseWithNoAgency(Target t) throws Exception {
        String view = publishedView(t);
        assertThat(ids(ok(query(person("auditor-1", null, "auditor"), view, Map.of())))).containsExactly(1, 2, 3, 4, 5, 6, 7);
    }

    @ParameterizedTest(name = "{0}: the entitlement table supplies what the token lacks")
    @MethodSource(SRC)
    void entitlementsFillInForMissingClaimsButTheTokenWins(Target t) throws Exception {
        String view = publishedView(t);
        String subject = "ent-" + UUID.randomUUID();
        String viaTable = person(subject, null, "analyst");

        assertThat(ids(ok(query(viaTable, view, Map.of())))).isEmpty();

        MvcResult put = call(put("/engine/v1/policies/entitlements"), admin(),
                req("entries", List.of(req("subject", subject, "attribute", "agency_code", "values", List.of("A002")))));
        assertThat(put.getResponse().getStatus()).isEqualTo(200);
        assertThat(ids(ok(query(viaTable, view, Map.of())))).containsExactly(4, 5);

        assertThat(ids(ok(query(person(subject, "A001", "analyst"), view, Map.of())))).as("the token's claim outranks the table").containsExactly(1, 2, 3);

        JsonNode listed = body(call(get("/engine/v1/policies/entitlements?subject=" + subject), admin(), null));
        assertThat(listed.get("totalElements").asInt()).isEqualTo(1);

        call(put("/engine/v1/policies/entitlements"), admin(),
                req("entries", List.of(req("subject", subject, "attribute", "agency_code", "values", List.of()))));
        assertThat(ids(ok(query(viaTable, view, Map.of())))).as("revoked").isEmpty();
    }

    @ParameterizedTest(name = "{0}: entitlements are admin-only, tenant-scoped and their values stay out of the audit trail")
    @MethodSource(SRC)
    void entitlementManagementIsGuarded(Target t) throws Exception {
        String view = publishedView(t);
        String subject = "ent-" + UUID.randomUUID();
        Map<String, Object> change = req("entries", List.of(req("subject", subject, "attribute", "agency_code", "values", List.of("A001"))));

        String developer = TestIdp.bearerWith(TENANT, "dev", Map.of(), "curf-developer");
        assertThat(call(put("/engine/v1/policies/entitlements"), developer, change).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(get("/engine/v1/policies/entitlements"), person("v", null, "analyst"), null).getResponse().getStatus()).isEqualTo(403);

        String otherAdmin = TestIdp.bearerWith(OTHER_TENANT, "admin", Map.of(), "curf-admin");
        assertThat(call(put("/engine/v1/policies/entitlements"), otherAdmin, change).getResponse().getStatus()).isEqualTo(200);
        assertThat(ids(ok(query(person(subject, null, "analyst"), view, Map.of())))).as("another tenant's entitlement does not apply here").isEmpty();

        List<Map<String, Object>> invalid = List.of(
                req("entries", List.of()),
                req("entries", List.of(req("subject", "", "attribute", "agency_code", "values", List.of("A")))),
                req("entries", List.of(req("subject", "s", "attribute", "bad name", "values", List.of("A")))));
        for (Map<String, Object> bad : invalid) {
            assertThat(call(put("/engine/v1/policies/entitlements"), admin(), bad).getResponse().getStatus()).as(bad.toString()).isEqualTo(422);
        }

        call(put("/engine/v1/policies/entitlements"), admin(), change);
        String audit = call(get("/engine/v1/audit-events?action=policy.entitlements.replace&size=200"), admin(), null).getResponse().getContentAsString();
        assertThat(audit).contains("policy.entitlements.replace").doesNotContain(subject);
    }

    // ---------------------------------------------------------------- personal data

    @ParameterizedTest(name = "{0}: personal data is masked, hidden or shown by role")
    @MethodSource(SRC)
    void piiIsMaskedHiddenOrShownByRole(Target t) throws Exception {
        String view = publishedView(t);

        JsonNode masked = ok(query(analyst("A001"), view, req("orderBy", List.of(req("column", "id", "descending", false)))));
        Map<String, JsonNode> first = table(masked).get(0);
        assertThat(first.get("email").asString()).isEqualTo("***");
        assertThat(first.get("salary").isNull()).isTrue();
        assertThat(first.get("ที่อยู่").asString()).isEqualTo("***");
        assertThat(first.get("name").asString()).isEqualTo("Somchai");
        assertThat(first.get("agency_code").asString()).isEqualTo("A001");
        assertThat(first).doesNotContainKey("national_id");

        Map<String, JsonNode> real = table(ok(query(person("hr-1", "A001", "hr"), view,
                req("orderBy", List.of(req("column", "id", "descending", false)))))).get(0);
        assertThat(real.get("email").asString()).isEqualTo("somchai@a001.go.th");
        assertThat(real.get("salary").asInt()).isEqualTo(30000);
        assertThat(real.get("national_id").asString()).isEqualTo("1100100000011");
        assertThat(real.get("ที่อยู่").asString()).isEqualTo("กรุงเทพ");

        JsonNode summary = ok(call(get("/engine/v1/views/" + view), analyst("A001"), null));
        assertThat(summary.toString()).doesNotContain("SELECT").doesNotContain("rlsRules").doesNotContain("national_id");
        assertThat(summary.get("columns").valueStream().filter(c -> c.get("name").asString().equals("email")).findFirst().orElseThrow()
                .get("masked").asBoolean()).isTrue();
    }

    @ParameterizedTest(name = "{0}: Thai text survives the whole path, and filters see the mask")
    @MethodSource(SRC)
    void thaiColumnNamesAndValuesWork(Target t) throws Exception {
        String view = publishedView(t);
        Map<String, Object> byAddress = req("columns", List.of("id", "ที่อยู่"), "filters", List.of(filter("ที่อยู่", "EQ", "กรุงเทพ")));

        JsonNode withPii = ok(query(person("hr-1", "A001", "hr"), view, byAddress));
        assertThat(withPii.get("columns").get(1).get("name").asString()).isEqualTo("ที่อยู่");
        assertThat(ids(withPii)).containsExactly(1);

        assertThat(ids(ok(query(analyst("A001"), view, byAddress)))).as("the mask is not the value").isEmpty();
    }

    // ---------------------------------------------------------------- attempts to get around it

    @ParameterizedTest(name = "{0}: nothing a viewer can send reaches hidden data or other agencies")
    @MethodSource(SRC)
    void bypassAttemptsAreRefusedOrHarmless(Target t) throws Exception {
        String view = publishedView(t);
        String me = analyst("A001");

        for (Map<String, Object> hostile : List.of(
                req("filters", List.of(filter("national_id", "EQ", "1100100000011"))),
                req("columns", List.of("national_id")),
                req("groupBy", List.of("national_id"), "aggregates", List.of(req("fn", "COUNT"))),
                req("aggregates", List.of(req("fn", "MAX", "column", "national_id", "as", "m"))),
                req("orderBy", List.of(req("column", "national_id", "descending", false))),
                req("orderBy", List.of(req("column", "id; DROP TABLE agency_data", "descending", false))),
                req("filters", List.of(filter("agency_code\" OR 1=1 --", "EQ", "x"))),
                req("filters", List.of(filter("1", "EQ", "x"))),
                req("aggregates", List.of(req("fn", "COUNT", "as", "x; DROP TABLE agency_data"))))) {
            assertRefused(query(me, view, hostile), 422, "CURF_INVALID_INPUT");
        }

        assertRefused(query(me, view, req("params", req("__r0_0", "A002"))), 422, "CURF_INVALID_INPUT");
        assertRefused(query(me, view, req("params", req("__f0_0", "A002"), "filters", List.of(filter("id", "EQ", 1)))), 422, "CURF_INVALID_INPUT");

        // Allowed requests that try to widen the rows still only see the viewer's own.
        assertThat(ids(ok(query(me, view, req("filters", List.of(filter("agency_code", "EQ", "A002"))))))).isEmpty();
        assertThat(ids(ok(query(me, view, req("filters", List.of(filterIn("agency_code", "A001", "A002", "B001"))))))).containsExactly(1, 2, 3);
        assertThat(ids(ok(query(me, view, req("filters", List.of(filterIn("id", 4, 5, 6))))))).isEmpty();
        assertThat(ids(ok(query(me, view, req("filters", List.of(filter("name", "EQ", "Somchai' OR '1'='1"))))))).isEmpty();
        assertThat(ids(ok(query(me, view, req("filters", List.of(filter("email", "EQ", "somchai@a001.go.th"))))))).as("filters see the mask").isEmpty();
        assertThat(ids(ok(query(me, view, req("orderBy", List.of(req("column", "id", "descending", true))))))).containsExactly(1, 2, 3);

        // Raw SQL is not available to viewers, and a view cannot be mixed with it.
        String conn = jdbc.sql("select connection_id from engine_view where id = :id").param("id", UUID.fromString(view)).query(String.class).single();
        assertThat(call(post("/engine/v1/queries/execute"), me, req("connectionId", conn, "sql", "SELECT * FROM agency_data")).getResponse().getStatus()).isEqualTo(403);
        assertRefused(call(post("/engine/v1/queries/execute"), me, req("viewId", view, "sql", "SELECT 1")), 422, "CURF_INVALID_INPUT");
    }

    @ParameterizedTest(name = "{0}: aggregates only ever cover the rows a viewer may see")
    @MethodSource(SRC)
    void aggregatesStayInsideTheRowRules(Target t) throws Exception {
        String view = publishedView(t);
        Map<String, Object> grouped = req(
                "groupBy", List.of("agency_code"),
                "aggregates", List.of(req("fn", "SUM", "column", "amount", "as", "total"), req("fn", "COUNT")),
                "orderBy", List.of(req("column", "agency_code", "descending", false)));

        List<Map<String, JsonNode>> mine = table(ok(query(analyst("A001"), view, grouped)));
        assertThat(mine).hasSize(1);
        assertThat(mine.get(0).get("agency_code").asString()).isEqualTo("A001");
        assertThat(new java.math.BigDecimal(mine.get(0).get("total").asString())).isEqualByComparingTo("350.75");
        assertThat(mine.get(0).get("count_all").asInt()).isEqualTo(3);

        List<Map<String, JsonNode>> all = table(ok(query(person("auditor-1", null, "auditor"), view, grouped)));
        assertThat(all).hasSize(4);
        assertThat(all.stream().filter(r -> !r.get("agency_code").isNull() && r.get("agency_code").asString().equals("A002"))
                .map(r -> new java.math.BigDecimal(r.get("total").asString())).findFirst().orElseThrow()).isEqualByComparingTo("310.75");

        JsonNode maskedSum = ok(query(analyst("A001"), view, req("aggregates", List.of(req("fn", "SUM", "column", "salary", "as", "s")))));
        assertThat(table(maskedSum).get(0).get("s").isNull()).as("a sum over a masked column is over nothing").isTrue();
    }

    // ---------------------------------------------------------------- caching

    @ParameterizedTest(name = "{0}: viewers share a cached answer only when their policy outcome is identical")
    @MethodSource(SRC)
    void cacheFollowsThePolicyOutcome(Target t) throws Exception {
        String view = publishedView(t);
        Map<String, Object> cached = req("maxAgeSeconds", 60, "filters", List.of(filter("id", "GT", UUID.randomUUID().hashCode() % 1000 - 2000)));

        String first = analyst("A001");
        assertThat(ok(query(first, view, cached)).get("cache").asString()).isEqualTo("miss");
        assertThat(ok(query(first, view, cached)).get("cache").asString()).isEqualTo("hit");
        assertThat(ok(query(person("someone-else", "A001", "analyst2"), view, cached)).get("cache").asString())
                .as("different person and role, same rows and masks").isEqualTo("hit");
        assertThat(ok(query(analyst("A002"), view, cached)).get("cache").asString()).as("different agency").isEqualTo("miss");
        assertThat(ok(query(person("hr-1", "A001", "hr"), view, cached)).get("cache").asString()).as("sees personal data").isEqualTo("miss");
        assertThat(ok(query(first, view, req("filters", cached.get("filters")))).get("cache").asString()).as("not asked for cache").isEqualTo("miss");
    }

    // ---------------------------------------------------------------- publishing

    @ParameterizedTest(name = "{0}: viewers see the published snapshot, never the draft")
    @MethodSource(SRC)
    void publishingFreezesWhatViewersSee(Target t) throws Exception {
        String conn = connection(t);
        String view = createView(viewBody(conn), false);
        String me = analyst("A001");

        assertRefused(query(me, view, Map.of()), 404, "CURF_NOT_FOUND");
        assertThat(call(get("/engine/v1/views/" + view), me, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(body(call(get("/engine/v1/views/" + view), admin(), null)).get("publishedVersion").isNull()).isTrue();

        publish(view);
        assertThat(ids(ok(query(me, view, Map.of())))).containsExactly(1, 2, 3);

        JsonNode working = body(call(get("/engine/v1/views/" + view), admin(), null));
        Map<String, Object> edit = viewBody(conn);
        edit.put("name", working.get("name").asString());
        edit.put("rlsRules", List.of());
        edit.put("version", working.get("version").asInt());
        MvcResult updated = call(put("/engine/v1/views/" + view), admin(), edit);
        assertThat(updated.getResponse().getStatus()).as(updated.getResponse().getContentAsString()).isEqualTo(200);
        assertThat(body(updated).get("version").asInt()).isEqualTo(2);
        assertThat(body(updated).get("publishedVersion").asInt()).isEqualTo(1);

        assertThat(ids(ok(query(me, view, Map.of())))).as("the edit has not been published").containsExactly(1, 2, 3);
        publish(view);
        assertThat(ids(ok(query(me, view, Map.of())))).as("published, the rule is gone").containsExactly(1, 2, 3, 4, 5, 6, 7);

        JsonNode versions = body(call(get("/engine/v1/views/" + view + "/versions"), admin(), null));
        assertThat(versions.valueStream().map(v -> v.get("version").asInt()).toList()).containsExactly(2, 1);

        assertThat(call(post("/engine/v1/views/" + view + "/unpublish"), admin(), null).getResponse().getStatus()).isEqualTo(204);
        assertRefused(query(me, view, Map.of()), 404, "CURF_NOT_FOUND");
    }

    @ParameterizedTest(name = "{0}: the catalogue lists only what a viewer may query")
    @MethodSource(SRC)
    void catalogueIsPerViewer(Target t) throws Exception {
        String conn = connection(t);
        String published = createView(viewBody(conn), true);
        String draft = createView(viewBody(conn), false);
        Map<String, Object> staff = viewBody(conn);
        staff.put("allowedRoles", List.of("staff-only"));
        String restricted = createView(staff, true);

        String listing = call(get("/engine/v1/views"), analyst("A001"), null).getResponse().getContentAsString();
        assertThat(listing).contains(published).doesNotContain(draft).doesNotContain(restricted).doesNotContain("SELECT");

        String full = call(get("/engine/v1/views?size=200"), admin(), null).getResponse().getContentAsString();
        assertThat(full).contains(published).contains(draft).contains(restricted);
    }

    // ---------------------------------------------------------------- who may do what

    @ParameterizedTest(name = "{0}: roles, other tenants and view management")
    @MethodSource(SRC)
    void authorizationAndTenantIsolation(Target t) throws Exception {
        String conn = connection(t);
        String view = createView(viewBody(conn), true);

        assertRefused(query(person("s", "A001", "stranger"), view, Map.of()), 404, "CURF_NOT_FOUND");
        String otherTenant = TestIdp.bearerWith(OTHER_TENANT, "admin", Map.of("agency_code", "A001"), "curf-admin");
        assertRefused(query(otherTenant, view, Map.of()), 404, "CURF_NOT_FOUND");
        assertThat(call(get("/engine/v1/views/" + view), otherTenant, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(call(post("/engine/v1/views/" + view + "/publish"), otherTenant, null).getResponse().getStatus()).isEqualTo(404);

        assertThat(call(post("/engine/v1/views"), analyst("A001"), viewBody(conn)).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(post("/engine/v1/views/" + view + "/publish"), analyst("A001"), null).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(delete("/engine/v1/views/" + view), analyst("A001"), null).getResponse().getStatus()).isEqualTo(403);
        assertThat(call(post("/engine/v1/views/" + view + "/preview"), analyst("A001"), null).getResponse().getStatus()).isEqualTo(403);

        String developer = TestIdp.bearerWith(TENANT, "dev", Map.of(), "curf-developer");
        assertThat(call(post("/engine/v1/views"), developer, viewBody(conn)).getResponse().getStatus()).as("view managers need not manage connections").isEqualTo(201);
    }

    @ParameterizedTest(name = "{0}: columns come from the database and personal data is protected by default")
    @MethodSource(SRC)
    void columnsAreReadFromTheDatabaseAndSecureByDefault(Target t) throws Exception {
        String conn = connection(t);
        Map<String, Object> body = viewBody(conn);
        body.remove("columns");
        JsonNode view = body(call(post("/engine/v1/views"), admin(), body));

        Map<String, String> pii = new LinkedHashMap<>();
        Map<String, String> types = new LinkedHashMap<>();
        view.get("columns").forEach(c -> {
            pii.put(c.get("name").asString(), c.get("pii").asString());
            types.put(c.get("name").asString(), c.get("type").asString());
        });
        assertThat(pii).containsEntry("id", "NONE").containsEntry("name", "NONE").containsEntry("agency_code", "NONE")
                .containsEntry("email", "MASK").containsEntry("salary", "MASK").containsEntry("national_id", "MASK")
                .containsEntry("ที่อยู่", "MASK");
        assertThat(types.values()).noneMatch(String::isBlank);

        for (Map<String, Object> bad : List.of(
                with(viewBody(conn), "columns", List.of(Map.of("name", "no_such_column", "pii", "HIDE"))),
                with(viewBody(conn), "rlsRules", List.of(Map.of("column", "no_such_column", "operator", "EQ", "attribute", "agency_code"))),
                with(viewBody(conn), "rlsRules", List.of(Map.of("column", "id", "operator", "EQ", "attribute", "bad attribute"))),
                with(viewBody(conn), "allowedRoles", List.of("bad role!")),
                with(viewBody(conn), "sql", "SELECT id, id FROM agency_data"),
                with(viewBody(conn), "sql", "SELECT * FROM agency_data WHERE agency_code = :code"),
                with(viewBody(conn), "connectionId", UUID.randomUUID().toString()))) {
            int status = call(post("/engine/v1/views"), admin(), bad).getResponse().getStatus();
            assertThat(status).as(bad.toString()).isIn(404, 422);
        }
        assertRefused(call(post("/engine/v1/views"), admin(), with(viewBody(conn), "sql", "DROP TABLE agency_data")), 422, "CURF_SQL_REJECTED");
        MvcResult noSample = call(post("/engine/v1/views"), admin(), with(viewBody(conn), "sql", "SELECT * FROM agency_data WHERE agency_code = :code"));
        assertThat(body(noSample).get("errors").toString()).contains("sampleParams");
    }

    @ParameterizedTest(name = "{0}: a view's own parameters are bound and required")
    @MethodSource(SRC)
    void viewsCanTakeParameters(Target t) throws Exception {
        Map<String, Object> body = viewBody(connection(t));
        body.put("sql", t.sql("SELECT * FROM agency_data WHERE amount >= :min_amount"));
        body.put("sampleParams", Map.of("min_amount", 0));
        String view = createView(body, true);
        String me = analyst("A001");

        assertThat(ids(ok(query(me, view, req("params", req("min_amount", 100)))))).containsExactly(1, 2);
        assertRefused(query(me, view, Map.of()), 422, "CURF_INVALID_INPUT");
    }

    @ParameterizedTest(name = "{0}: edits are version-checked and a connection in use cannot be deleted")
    @MethodSource(SRC)
    void staleEditsAndConnectionsInUse(Target t) throws Exception {
        String conn = connection(t);
        String view = createView(viewBody(conn), false);
        JsonNode current = body(call(get("/engine/v1/views/" + view), admin(), null));

        Map<String, Object> edit = viewBody(conn);
        edit.put("name", current.get("name").asString());
        edit.put("version", current.get("version").asInt());
        assertThat(call(put("/engine/v1/views/" + view), admin(), edit).getResponse().getStatus()).isEqualTo(200);
        assertRefused(call(put("/engine/v1/views/" + view), admin(), edit), 409, "CURF_STALE_VERSION");
        edit.remove("version");
        assertThat(call(put("/engine/v1/views/" + view), admin(), edit).getResponse().getStatus()).isEqualTo(422);

        assertRefused(call(delete("/engine/v1/connections/" + conn), admin(), null), 409, "CURF_CONFLICT");
        assertThat(call(delete("/engine/v1/views/" + view), admin(), null).getResponse().getStatus()).isEqualTo(204);
        assertThat(call(delete("/engine/v1/views/" + view), admin(), null).getResponse().getStatus()).isEqualTo(404);
    }

    @ParameterizedTest(name = "{0}: previews show the author's own policy and are capped")
    @MethodSource(SRC)
    void previewRunsTheDraftAsTheCaller(Target t) throws Exception {
        String view = createView(viewBody(connection(t)), false);

        // An author's preview applies their own policy: row rules too, so this author holds an agency.
        String author = TestIdp.bearerWith(TENANT, "author", Map.of("agency_code", "A001"), "curf-admin");
        JsonNode preview = ok(call(post("/engine/v1/views/" + view + "/preview"), author, req("limit", 2)));
        assertThat(preview.get("rowCount").asInt()).isEqualTo(2);
        assertThat(preview.get("truncated").asBoolean()).isTrue();
        assertThat(table(preview).get(0).get("email").asString()).as("managing views does not unlock personal data").isEqualTo("***");
        assertThat(ok(call(post("/engine/v1/views/" + view + "/preview"), admin(), null)).get("rows")).as("an author with no agency sees no rows").isEmpty();
    }

    @ParameterizedTest(name = "{0}: results and the query log carry the view and its version")
    @MethodSource(SRC)
    void provenanceAndLogCarryTheView(Target t) throws Exception {
        String view = publishedView(t);
        JsonNode result = ok(query(analyst("A001"), view, Map.of()));

        assertThat(result.get("provenance").get("viewVersion").asInt()).isEqualTo(1);
        assertThat(result.get("provenance").get("sha256").asString()).hasSize(64);
        var rows = jdbc.sql("select view_version, outcome from engine_query_log where view_id = :id")
                .param("id", UUID.fromString(view)).query((rs, n) -> rs.getInt(1) + ":" + rs.getString(2)).list();
        assertThat(rows).contains("1:ok");

        String a = ok(query(analyst("A001"), view, Map.of())).get("provenance").get("sha256").asString();
        String b = ok(query(analyst("A002"), view, Map.of())).get("provenance").get("sha256").asString();
        assertThat(a).as("different rows, different hash").isNotEqualTo(b);
    }

    private static Map<String, Object> with(Map<String, Object> map, String key, Object value) {
        map.put(key, value);
        return map;
    }
}
