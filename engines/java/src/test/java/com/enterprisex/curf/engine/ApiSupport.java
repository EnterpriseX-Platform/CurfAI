package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.enterprisex.curf.engine.DbTargets.Target;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeAll;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * What the HTTP-level integration tests share: the people (an administrator, ordinary analysts with an agency),
 * connections to the test databases, views over the agency_data fixture, and small helpers for calls and answers.
 */
abstract class ApiSupport {

    static final String TENANT = "t-views-" + UUID.randomUUID();
    static final String OTHER_TENANT = "t-views-other-" + UUID.randomUUID();

    @Autowired MockMvc mvc;
    @Autowired JsonMapper json;
    @Autowired JdbcClient jdbc;

    @BeforeAll
    static void prepare() {
        DbTargets.prepareAll();
    }

    // ---------------------------------------------------------------- people

    static String admin() {
        return TestIdp.bearerWith(TENANT, "admin", Map.of(), "curf-admin");
    }

    /** An ordinary viewer. {@code agency} may be a single code, a list of codes, or null for none. */
    static String person(String subject, Object agency, String... roles) {
        Map<String, Object> claims = new LinkedHashMap<>();
        if (agency != null) {
            claims.put("agency_code", agency);
        }
        return TestIdp.bearerWith(TENANT, subject, claims, roles);
    }

    /** A checker: may approve publish requests, nothing else. */
    static String approver() {
        return TestIdp.bearerWith(TENANT, "approver", Map.of(), "curf-approver");
    }

    static String analyst(Object agency) {
        return person("analyst-" + UUID.randomUUID(), agency, "analyst");
    }

    // ---------------------------------------------------------------- http

    MvcResult call(MockHttpServletRequestBuilder request, String token, Object payload) throws Exception {
        var builder = request.header("Authorization", token);
        if (payload != null) {
            builder = builder.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload));
        }
        return mvc.perform(builder).andReturn();
    }

    JsonNode body(MvcResult r) throws Exception {
        String text = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        return text.isEmpty() ? null : json.readTree(text);
    }

    /** Asks to publish the report's newest version (as the admin) and approves it (as a different person). */
    void publishReport(String reportId) throws Exception {
        MvcResult asked = call(post("/engine/v1/reports/" + reportId + "/publish-requests"), admin(), Map.of("note", "test"));
        assertThat(asked.getResponse().getStatus()).as(asked.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        MvcResult done = call(post("/engine/v1/publish-requests/" + body(asked).get("id").asString() + "/approve"), approver(), null);
        assertThat(done.getResponse().getStatus()).as(done.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
    }

    String connection(Target t) throws Exception {
        return connection(t, false);
    }

    /** A connection to the test database; with {@code rawSql} administrators may run raw SQL on it. */
    String connection(Target t, boolean rawSql) throws Exception {
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("name", t.kind() + "-views-" + UUID.randomUUID());
        req.put("kind", t.kind());
        req.put("host", t.host());
        req.put("port", t.port());
        req.put("database", t.connectionDatabase());
        req.put("username", "curf_reader");
        req.put("password", DbTargets.PASSWORD);
        req.put("tlsMode", "DISABLE");
        req.put("allowRawSql", rawSql);
        MvcResult r = call(post("/engine/v1/connections"), admin(), req);
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(201);
        return body(r).get("id").asString();
    }

    /** The standard view: agency rows by the viewer's agency code, personal data masked or hidden. */
    Map<String, Object> viewBody(String conn) {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("name", "agency-" + UUID.randomUUID());
        v.put("connectionId", conn);
        v.put("sql", "SELECT * FROM agency_data");
        v.put("allowedRoles", List.of("analyst", "analyst2", "hr", "auditor"));
        v.put("piiRoles", List.of("hr"));
        v.put("bypassRoles", List.of("auditor"));
        v.put("rlsRules", List.of(Map.of("column", "agency_code", "operator", "EQ", "attribute", "agency_code")));
        v.put("columns", List.of(Map.of("name", "national_id", "pii", "HIDE")));
        return v;
    }

    String createView(Map<String, Object> body, boolean publish) throws Exception {
        MvcResult r = call(post("/engine/v1/views"), admin(), body);
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        String id = body(r).get("id").asString();
        if (publish) {
            publish(id);
        }
        return id;
    }

    String publishedView(Target t) throws Exception {
        return createView(viewBody(connection(t)), true);
    }

    void publish(String id) throws Exception {
        MvcResult p = call(post("/engine/v1/views/" + id + "/publish"), admin(), null);
        assertThat(p.getResponse().getStatus()).as(p.getResponse().getContentAsString()).isEqualTo(200);
    }

    MvcResult query(String token, String view, Map<String, Object> extra) throws Exception {
        Map<String, Object> req = new LinkedHashMap<>(extra);
        req.put("viewId", view);
        return call(post("/engine/v1/queries/execute"), token, req);
    }

    JsonNode ok(MvcResult r) throws Exception {
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(200);
        return body(r);
    }

    static List<Map<String, JsonNode>> table(JsonNode result) {
        List<String> names = new ArrayList<>();
        result.get("columns").forEach(c -> names.add(c.get("name").asString()));
        List<Map<String, JsonNode>> rows = new ArrayList<>();
        result.get("rows").forEach(r -> {
            Map<String, JsonNode> row = new LinkedHashMap<>();
            for (int i = 0; i < names.size(); i++) {
                row.put(names.get(i), r.get(i));
            }
            rows.add(row);
        });
        return rows;
    }

    static List<Integer> ids(JsonNode result) {
        return table(result).stream().map(r -> r.get("id").asInt()).sorted().toList();
    }

    static Map<String, Object> req(Object... keyValues) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            m.put((String) keyValues[i], keyValues[i + 1]);
        }
        return m;
    }

    static Map<String, Object> filter(String column, String op, Object value) {
        return req("column", column, "op", op, "value", value);
    }

    static Map<String, Object> filterIn(String column, Object... values) {
        return req("column", column, "op", "IN", "values", List.of(values));
    }

    void assertRefused(MvcResult r, int status, String code) throws Exception {
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(status);
        assertThat(body(r).get("code").asString()).isEqualTo(code);
    }

}
