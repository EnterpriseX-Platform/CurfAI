package com.enterprisex.curf.engine;

import static com.enterprisex.curf.engine.ReportIT.block;
import static com.enterprisex.curf.engine.ReportIT.definition;
import static com.enterprisex.curf.engine.ReportIT.param;
import static com.enterprisex.curf.engine.ReportIT.saved;
import static com.enterprisex.curf.engine.ReportIT.unique;
import static com.enterprisex.curf.engine.ReportIT.viewQuery;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.enterprisex.curf.engine.DbTargets.Target;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

/**
 * Sharing, maker and checker publishing, and public links, end to end over HTTP on every database: who sees a report,
 * that people who only run it get the published version, that the person who asked cannot approve, and that a public
 * link can reach only views built for the public and stops the moment it is revoked or the report withdrawn.
 */
@EngineIT
class SharingIT extends ApiSupport {

    static final String SRC = "com.enterprisex.curf.engine.DbTargets#targets";

    private static final String RUNNER = "analyst";

    // ---------------------------------------------------------------- helpers

    private String create(Map<String, Object> definition, List<String> runRoles) throws Exception {
        MvcResult r = call(post("/engine/v1/reports"), admin(), saved(definition, "runRoles", runRoles));
        assertThat(r.getResponse().getStatus()).as(text(r)).isEqualTo(201);
        return body(r).get("id").asString();
    }

    private String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private int status(MvcResult r) {
        return r.getResponse().getStatus();
    }

    private String code(MvcResult r) throws Exception {
        return body(r).get("code").asString();
    }

    private String runner() {
        return person("runner-" + java.util.UUID.randomUUID(), "A001", RUNNER);
    }

    private MvcResult run(String token, String report) throws Exception {
        return call(post("/engine/v1/reports/" + report + "/run"), token, req("params", Map.of()));
    }

    private String requestPublish(String report) throws Exception {
        MvcResult r = call(post("/engine/v1/reports/" + report + "/publish-requests"), admin(), Map.of("note", "please"));
        assertThat(status(r)).as(text(r)).isEqualTo(201);
        return body(r).get("id").asString();
    }

    private Map<String, Object> simple(Target t, String name) throws Exception {
        String view = createView(viewBody(connection(t)), true);
        return definition(name, List.of(), List.of(viewQuery("ds_rows", view, req("columns", List.of("id", "agency_code"),
                "orderBy", List.of(req("column", "id", "descending", false))))), List.of(block("b_table", "table", req("queryId", "ds_rows"))));
    }

    /** A view built for the public: aggregate-friendly columns only, no row rules, listing the reserved role. */
    private String publicView(Target t) throws Exception {
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("name", "public-" + java.util.UUID.randomUUID());
        v.put("connectionId", connection(t));
        v.put("sql", t.sql("SELECT agency_code, amount FROM agency_data"));
        v.put("allowedRoles", List.of("public", RUNNER));
        return createView(v, true);
    }

    private Map<String, Object> publicDefinition(String view, String name) {
        return definition(name, List.of(param("agency", "string", null, false)),
                List.of(viewQuery("ds_totals", view, req(
                        "filters", List.of(req("column", "agency_code", "op", "EQ", "value", req("$param", "agency"), "skipIfEmpty", true)),
                        "groupBy", List.of("agency_code"),
                        "aggregates", List.of(req("fn", "SUM", "column", "amount", "as", "total")),
                        "orderBy", List.of(req("column", "agency_code", "descending", false))))),
                List.of(block("b_chart", "chart", req("queryId", "ds_totals", "chartType", "bar", "xField", "agency_code", "yFields", List.of("total")))));
    }

    private MvcResult publicCall(String path, Object payload) throws Exception {
        var builder = payload == null ? get(path) : post(path).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(payload));
        return mvc.perform(builder).andReturn();
    }

    private JsonNode createLink(String report, String kind, Map<String, Object> payload) throws Exception {
        String path = "/engine/v1/reports/" + report + (kind.equals("EMBED") ? "/embed-tokens" : "/public-links");
        MvcResult r = call(post(path), kind.equals("EMBED") ? admin() : approver(), payload);
        assertThat(status(r)).as(text(r)).isEqualTo(201);
        return body(r);
    }

    // ---------------------------------------------------------------- the published version

    @ParameterizedTest(name = "{0}: people who only run a report get the published version, never the working copy")
    @MethodSource(SRC)
    void runnersSeeOnlyThePublishedVersion(Target t) throws Exception {
        Map<String, Object> d = simple(t, unique("published"));
        String id = create(d, List.of(RUNNER));
        String me = runner();

        assertThat(status(run(me, id))).as("never published").isEqualTo(404);
        assertThat(status(call(get("/engine/v1/reports/" + id), me, null))).isEqualTo(404);
        assertThat(text(call(get("/engine/v1/reports"), me, null))).doesNotContain(id);

        publishReport(id);
        MvcResult first = run(me, id);
        assertThat(status(first)).as(text(first)).isEqualTo(200);
        assertThat(body(first).get("reportVersion").asInt()).isEqualTo(1);
        assertThat(text(call(get("/engine/v1/reports"), me, null))).contains(id);

        // The editor saves version 2; the runner still gets version 1, the editor gets the working copy.
        Map<String, Object> d2 = new LinkedHashMap<>(d);
        d2.put("description", "changed after publishing");
        assertThat(status(call(put("/engine/v1/reports/" + id), admin(), saved(d2, "version", 1, "runRoles", List.of(RUNNER))))).isEqualTo(200);
        assertThat(body(run(me, id)).get("reportVersion").asInt()).isEqualTo(1);
        assertThat(body(run(admin(), id)).get("reportVersion").asInt()).isEqualTo(2);
        assertThat(body(call(get("/engine/v1/reports/" + id), me, null)).get("version").asInt()).isEqualTo(1);
        assertThat(body(call(get("/engine/v1/reports/" + id), admin(), null)).get("publishedVersion").asInt()).isEqualTo(1);

        // Withdrawing takes it away again, and says why in the audit trail.
        assertThat(status(call(post("/engine/v1/reports/" + id + "/unpublish"), admin(), Map.of()))).as("reason is required").isEqualTo(422);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/unpublish"), admin(), Map.of("reason", "wrong figures")))).isEqualTo(204);
        assertThat(status(run(me, id))).isEqualTo(404);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/unpublish"), admin(), Map.of("reason", "again")))).isEqualTo(409);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/unpublish"), me, Map.of("reason", "x")))).isEqualTo(403);
    }

    // ---------------------------------------------------------------- shares

    @ParameterizedTest(name = "{0}: shares give a person, a group or an office view or edit access, until they expire")
    @MethodSource(SRC)
    void sharesGrantAccess(Target t) throws Exception {
        String id = create(simple(t, unique("shared")), List.of());
        publishReport(id);
        String alice = person("alice-" + java.util.UUID.randomUUID(), "A001", "nobody");
        String aliceSubject = body(call(get("/engine/v1/me"), alice, null)).get("subject").asString();
        String bob = TestIdp.bearerWith(TENANT, "bob-" + java.util.UUID.randomUUID(), Map.of("agency_code", "A002", "groups", List.of("finance")), "nobody");

        assertThat(status(run(alice, id))).as("no access yet").isEqualTo(404);
        assertThat(status(call(get("/engine/v1/reports/" + id + "/shares"), alice, null))).as("only editors list shares").isEqualTo(403);

        List<Map<String, Object>> shares = List.of(
                req("subjectType", "USER", "subjectId", aliceSubject, "permission", "VIEW"),
                req("subjectType", "ATTRIBUTE", "subjectId", "agency_code=A002", "permission", "VIEW"));
        MvcResult set = call(put("/engine/v1/reports/" + id + "/shares"), admin(), req("shares", shares));
        assertThat(status(set)).as(text(set)).isEqualTo(200);
        assertThat(body(set).get("shares")).hasSize(2);

        assertThat(status(run(alice, id))).isEqualTo(200);
        assertThat(status(run(bob, id))).as("shared by attribute").isEqualTo(200);
        assertThat(status(call(get("/engine/v1/reports/" + id + "/versions"), alice, null))).as("view is not edit").isEqualTo(403);
        JsonNode asViewer = body(call(get("/engine/v1/reports/" + id), alice, null));
        assertThat(asViewer.has("runRoles")).as("a viewer gets the reduced definition, not the editable one").isFalse();
        assertThat(asViewer.get("definition").get("dataSources").get(0).has("sql")).isFalse();
        assertThat(asViewer.get("definition").get("dataSources").get(0).has("engine")).isFalse();

        // An edit share lets someone without the edit permission change this report, and only this one.
        List<Map<String, Object>> withEdit = List.of(req("subjectType", "USER", "subjectId", aliceSubject, "permission", "EDIT"));
        assertThat(status(call(put("/engine/v1/reports/" + id + "/shares"), admin(), req("shares", withEdit)))).isEqualTo(200);
        assertThat(status(call(get("/engine/v1/reports/" + id + "/versions"), alice, null))).isEqualTo(200);
        assertThat(status(call(get("/engine/v1/reports/" + id), alice, null))).isEqualTo(200);
        assertThat(body(call(get("/engine/v1/reports/" + id), alice, null)).has("runRoles")).isTrue();
        assertThat(status(run(bob, id))).as("the earlier share was replaced").isEqualTo(404);
        assertThat(status(call(post("/engine/v1/reports"), alice, saved(simple(t, unique("new")))))).as("creating still needs the permission").isEqualTo(403);
        assertThat(status(call(delete("/engine/v1/reports/" + id), alice, null))).as("deleting still needs the permission").isEqualTo(403);
    }

    @ParameterizedTest(name = "{0}: share requests are validated")
    @MethodSource(SRC)
    void sharesAreValidated(Target t) throws Exception {
        String id = create(simple(t, unique("badshares")), List.of());
        String path = "/engine/v1/reports/" + id + "/shares";

        assertThat(status(call(put(path), admin(), req("shares", List.of(req("subjectType", "ATTRIBUTE", "subjectId", "no-equals", "permission", "VIEW")))))).isEqualTo(422);
        assertThat(status(call(put(path), admin(), req("shares", List.of(req("subjectType", "USER", "subjectId", "x", "permission", "VIEW", "expiresAt", "2020-01-01T00:00:00Z")))))).as("already expired").isEqualTo(422);
        assertThat(status(call(put(path), admin(), req("shares", List.of(
                req("subjectType", "USER", "subjectId", "x", "permission", "VIEW"), req("subjectType", "USER", "subjectId", "x", "permission", "EDIT")))))).as("duplicate").isEqualTo(422);
        assertThat(status(call(put(path), admin(), req("shares", List.of(req("subjectType", "USER", "subjectId", "x")))))).as("no permission").isEqualTo(422);
        assertThat(status(call(put("/engine/v1/reports/" + java.util.UUID.randomUUID() + "/shares"), admin(), req("shares", List.of())))).isEqualTo(404);
        assertThat(status(call(put(path), runner(), req("shares", List.of())))).isEqualTo(403);
    }

    // ---------------------------------------------------------------- maker and checker

    @ParameterizedTest(name = "{0}: the person who asked to publish cannot approve; a changed report goes stale")
    @MethodSource(SRC)
    void makerAndChecker(Target t) throws Exception {
        Map<String, Object> d = simple(t, unique("sod"));
        String id = create(d, List.of(RUNNER));
        String request = requestPublish(id);

        assertThat(status(call(post("/engine/v1/reports/" + id + "/publish-requests"), admin(), Map.of()))).as("one pending request at a time").isEqualTo(409);
        MvcResult self = call(post("/engine/v1/publish-requests/" + request + "/approve"), admin(), null);
        assertThat(status(self)).isEqualTo(403);
        assertThat(code(self)).isEqualTo("CURF_SEGREGATION_OF_DUTIES");
        assertThat(status(call(post("/engine/v1/publish-requests/" + request + "/approve"), runner(), null))).as("approving needs the permission").isEqualTo(403);
        assertThat(status(run(runner(), id))).as("nothing published yet").isEqualTo(404);

        // Saving again after the request makes the request stale: what was asked for is no longer the newest version.
        Map<String, Object> d2 = new LinkedHashMap<>(d);
        d2.put("description", "edited after asking");
        assertThat(status(call(put("/engine/v1/reports/" + id), admin(), saved(d2, "version", 1, "runRoles", List.of(RUNNER))))).isEqualTo(200);
        MvcResult stale = call(post("/engine/v1/publish-requests/" + request + "/approve"), approver(), null);
        assertThat(status(stale)).isEqualTo(409);
        assertThat(code(stale)).isEqualTo("CURF_STALE_VERSION");

        MvcResult noNote = call(post("/engine/v1/publish-requests/" + request + "/reject"), approver(), Map.of());
        assertThat(status(noNote)).as("a rejection must say why").isEqualTo(422);
        MvcResult rejected = call(post("/engine/v1/publish-requests/" + request + "/reject"), approver(), Map.of("note", "edited since"));
        assertThat(status(rejected)).as(text(rejected)).isEqualTo(200);
        assertThat(body(rejected).get("state").asString()).isEqualTo("REJECTED");
        assertThat(body(rejected).get("decidedBy").asString()).isEqualTo("approver");
        assertThat(status(call(post("/engine/v1/publish-requests/" + request + "/approve"), approver(), null))).as("already decided").isEqualTo(409);

        // Ask again: now the approver publishes exactly version 2.
        String again = requestPublish(id);
        MvcResult approved = call(post("/engine/v1/publish-requests/" + again + "/approve"), approver(), Map.of("note", "ok"));
        assertThat(status(approved)).as(text(approved)).isEqualTo(200);
        assertThat(body(approved).get("state").asString()).isEqualTo("APPROVED");
        assertThat(body(run(runner(), id)).get("reportVersion").asInt()).isEqualTo(2);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/publish-requests"), admin(), Map.of()))).as("latest is already published").isEqualTo(409);
    }

    @ParameterizedTest(name = "{0}: a request can be withdrawn only by whoever asked, and listed by checkers")
    @MethodSource(SRC)
    void cancellingAndListing(Target t) throws Exception {
        String id = create(simple(t, unique("cancel")), List.of(RUNNER));
        String request = requestPublish(id);

        assertThat(status(call(post("/engine/v1/publish-requests/" + request + "/cancel"), approver(), null))).isEqualTo(403);
        assertThat(text(call(get("/engine/v1/publish-requests"), approver(), null))).contains(request);
        assertThat(status(call(get("/engine/v1/publish-requests"), runner(), null))).as("listing is for checkers").isEqualTo(403);
        assertThat(status(call(get("/engine/v1/publish-requests/" + request), runner(), null))).as("not theirs, not a checker").isEqualTo(404);
        assertThat(status(call(get("/engine/v1/publish-requests/" + request), admin(), null))).isEqualTo(200);
        assertThat(text(call(get("/engine/v1/reports/" + id + "/publish-requests"), admin(), null))).contains(request);

        MvcResult cancelled = call(post("/engine/v1/publish-requests/" + request + "/cancel"), admin(), null);
        assertThat(status(cancelled)).as(text(cancelled)).isEqualTo(200);
        assertThat(body(cancelled).get("state").asString()).isEqualTo("CANCELLED");
        assertThat(text(call(get("/engine/v1/publish-requests"), approver(), null))).doesNotContain(request);
        assertThat(status(call(post("/engine/v1/publish-requests/" + request + "/cancel"), admin(), null))).isEqualTo(409);
    }

    // ---------------------------------------------------------------- public links

    @ParameterizedTest(name = "{0}: a public link runs a published report on public views, nothing more, and revoking stops it")
    @MethodSource(SRC)
    void publicLinkLifecycle(Target t) throws Exception {
        String view = publicView(t);
        String id = create(publicDefinition(view, unique("public")), List.of());

        MvcResult early = call(post("/engine/v1/reports/" + id + "/public-links"), approver(), Map.of());
        assertThat(status(early)).as("not published yet").isEqualTo(404);
        publishReport(id);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/public-links"), runner(), Map.of()))).as("making it public needs approval rights").isEqualTo(403);

        JsonNode created = createLink(id, "PUBLIC", req("params", Map.of("agency", "A001")));
        String token = created.get("token").asString();
        assertThat(token).startsWith("cpl_");
        assertThat(created.get("url").asString()).isEqualTo("/engine/v1/public/" + token);
        assertThat(text(call(get("/engine/v1/reports/" + id + "/public-links"), admin(), null))).as("the secret is never listed").doesNotContain(token);

        MvcResult open = publicCall("/engine/v1/public/" + token, null);
        assertThat(status(open)).as(text(open)).isEqualTo(200);
        assertThat(open.getResponse().getHeader("Cache-Control")).contains("no-store");
        assertThat(text(open)).as("queries are reduced to id and name").doesNotContain("agency_data").doesNotContain("viewId");

        // The link's own parameters win over anything the caller sends.
        MvcResult ran = publicCall("/engine/v1/public/" + token + "/run", req("params", Map.of("agency", "A002")));
        assertThat(status(ran)).as(text(ran)).isEqualTo(200);
        JsonNode rows = body(ran).get("dataset").get("ds_totals");
        assertThat(rows).isNotEmpty();
        rows.forEach(r -> assertThat(r.get("agency_code").asString()).isEqualTo("A001"));
        assertThat(body(ran).get("provenance").get("ds_totals").get("denied")).isNull();

        // Revoking is immediate and looks the same as a link that never existed.
        String linkId = created.get("link").get("id").asString();
        assertThat(status(call(delete("/engine/v1/public-links/" + linkId), approver(), null))).isEqualTo(204);
        MvcResult revoked = publicCall("/engine/v1/public/" + token + "/run", req("params", Map.of()));
        MvcResult never = publicCall("/engine/v1/public/cpl_" + "x".repeat(43) + "/run", req("params", Map.of()));
        assertThat(status(revoked)).isEqualTo(404);
        assertThat(status(never)).isEqualTo(404);
        assertThat(body(revoked).get("code").asString()).isEqualTo(body(never).get("code").asString());
        assertThat(body(revoked).get("detail").asString()).isEqualTo(body(never).get("detail").asString());
        assertThat(status(call(delete("/engine/v1/public-links/" + linkId), approver(), null))).as("already revoked").isEqualTo(409);
    }

    @ParameterizedTest(name = "{0}: withdrawing the report or changing its view stops the public link at once")
    @MethodSource(SRC)
    void unpublishingStopsPublicLinks(Target t) throws Exception {
        String view = publicView(t);
        String id = create(publicDefinition(view, unique("withdrawn")), List.of());
        publishReport(id);
        String token = createLink(id, "PUBLIC", Map.of()).get("token").asString();
        assertThat(status(publicCall("/engine/v1/public/" + token + "/run", Map.of()))).isEqualTo(200);

        assertThat(status(call(post("/engine/v1/reports/" + id + "/unpublish"), admin(), Map.of("reason", "wrong figures")))).isEqualTo(204);
        assertThat(status(publicCall("/engine/v1/public/" + token + "/run", Map.of()))).isEqualTo(404);
        assertThat(status(publicCall("/engine/v1/public/" + token, null))).isEqualTo(404);

        // Re-publishing revives the link until it expires or is revoked.
        publishReport(id);
        assertThat(status(publicCall("/engine/v1/public/" + token + "/run", Map.of()))).isEqualTo(200);

        // The view stops being offered to the public: the report can no longer be reached through the link.
        Map<String, Object> notPublic = new LinkedHashMap<>();
        notPublic.put("name", "public-removed-" + java.util.UUID.randomUUID());
        notPublic.put("connectionId", connection(t));
        notPublic.put("sql", t.sql("SELECT agency_code, amount FROM agency_data"));
        notPublic.put("allowedRoles", List.of("public"));
        String second = createView(notPublic, true);
        String id2 = create(publicDefinition(second, unique("removed")), List.of());
        publishReport(id2);
        String token2 = createLink(id2, "PUBLIC", Map.of()).get("token").asString();
        Map<String, Object> changed = new LinkedHashMap<>(notPublic);
        changed.put("allowedRoles", List.of(RUNNER));
        MvcResult updated = call(put("/engine/v1/views/" + second), admin(), withVersion(changed, 1));
        assertThat(status(updated)).as(text(updated)).isEqualTo(200);
        publish(second);
        assertThat(status(publicCall("/engine/v1/public/" + token2 + "/run", Map.of()))).as("the view is no longer public").isEqualTo(404);
    }

    private static Map<String, Object> withVersion(Map<String, Object> view, int version) {
        Map<String, Object> m = new LinkedHashMap<>(view);
        m.put("version", version);
        return m;
    }

    @ParameterizedTest(name = "{0}: a report cannot go public if it holds raw SQL or touches a view not built for the public")
    @MethodSource(SRC)
    void publicExposureIsChecked(Target t) throws Exception {
        // Raw SQL, even on a connection an administrator may use, can never be public.
        String conn = connection(t, true);
        String raw = create(definition(unique("raw"), List.of(), List.of(ReportIT.rawQuery("q", conn, "SELECT 1 AS one")),
                List.of(block("b", "table", req("queryId", "q")))), List.of());
        publishReport(raw);
        MvcResult rawLink = call(post("/engine/v1/reports/" + raw + "/public-links"), approver(), Map.of());
        assertThat(status(rawLink)).isEqualTo(422);
        assertThat(text(rawLink)).contains("raw SQL");

        // A view with row rules is not offered to the public, nor can it be.
        String internal = create(simple(t, unique("internal")), List.of());
        publishReport(internal);
        MvcResult notOffered = call(post("/engine/v1/reports/" + internal + "/public-links"), approver(), Map.of());
        assertThat(status(notOffered)).isEqualTo(422);
        assertThat(text(notOffered)).contains("not offered to the public");

        Map<String, Object> risky = viewBody(connection(t));
        risky.put("allowedRoles", List.of("public"));
        MvcResult refused = call(post("/engine/v1/views"), admin(), risky);
        String riskyId = body(refused).get("id").asString();
        MvcResult publishRisky = call(post("/engine/v1/views/" + riskyId + "/publish"), admin(), null);
        assertThat(status(publishRisky)).as("row rules cannot be public").isEqualTo(422);
        assertThat(text(publishRisky)).contains("row rules");

        Map<String, Object> leaky = new LinkedHashMap<>();
        leaky.put("name", "leaky-" + java.util.UUID.randomUUID());
        leaky.put("connectionId", connection(t));
        leaky.put("sql", t.sql("SELECT id, email FROM agency_data"));
        leaky.put("allowedRoles", List.of("public"));
        leaky.put("columns", List.of(Map.of("name", "email", "pii", "NONE")));
        String leakyId = body(call(post("/engine/v1/views"), admin(), leaky)).get("id").asString();
        MvcResult publishLeaky = call(post("/engine/v1/views/" + leakyId + "/publish"), admin(), null);
        assertThat(status(publishLeaky)).as("an unmasked personal column cannot be public").isEqualTo(422);
        assertThat(text(publishLeaky)).contains("email");
    }

    @ParameterizedTest(name = "{0}: embed tokens are short lived, bounded, and need edit access")
    @MethodSource(SRC)
    void embedTokens(Target t) throws Exception {
        String id = create(publicDefinition(publicView(t), unique("embed")), List.of());
        publishReport(id);

        assertThat(status(call(post("/engine/v1/reports/" + id + "/embed-tokens"), runner(), Map.of()))).as("needs edit access").isEqualTo(404);
        JsonNode created = createLink(id, "EMBED", Map.of());
        long ttl = java.time.Duration.between(java.time.Instant.parse(created.get("link").get("createdAt").asString()),
                java.time.Instant.parse(created.get("link").get("expiresAt").asString())).toSeconds();
        assertThat(ttl).as("one hour by default").isEqualTo(3600);
        assertThat(created.get("link").get("kind").asString()).isEqualTo("EMBED");
        assertThat(status(publicCall("/engine/v1/public/" + created.get("token").asString() + "/run", Map.of()))).isEqualTo(200);

        assertThat(status(call(post("/engine/v1/reports/" + id + "/embed-tokens"), admin(), Map.of("expiresInSeconds", 7 * 24 * 3600)))).as("above the embed ceiling").isEqualTo(422);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/embed-tokens"), admin(), Map.of("expiresInSeconds", 0)))).isEqualTo(422);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/embed-tokens"), admin(), Map.of("params", Map.of("nope", "x"))))).as("unknown locked parameter").isEqualTo(422);
    }

    @ParameterizedTest(name = "{0}: one public link cannot be hammered")
    @MethodSource(SRC)
    void publicLinksAreRateLimited(Target t) throws Exception {
        String id = create(publicDefinition(publicView(t), unique("rate")), List.of());
        publishReport(id);
        String token = createLink(id, "PUBLIC", Map.of()).get("token").asString();

        int limited = 0;
        for (int i = 0; i < 12; i++) {
            MvcResult r = publicCall("/engine/v1/public/" + token + "/run", Map.of());
            if (status(r) == 429) {
                limited++;
                assertThat(code(r)).isEqualTo("CURF_TOO_MANY_QUERIES");
            }
        }
        assertThat(limited).as("a limit of 6 a minute refuses most of 12 quick calls").isGreaterThanOrEqualTo(5);
    }

    @ParameterizedTest(name = "{0}: public endpoints answer browsers only from listed sites and carry no cookies")
    @MethodSource(SRC)
    void corsIsLimitedToListedOrigins(Target t) throws Exception {
        MvcResult allowed = mvc.perform(options("/engine/v1/public/cpl_x/run").header("Origin", "https://site.test")
                .header("Access-Control-Request-Method", "POST").header("Access-Control-Request-Headers", "content-type")).andReturn();
        assertThat(allowed.getResponse().getHeader("Access-Control-Allow-Origin")).isEqualTo("https://site.test");
        assertThat(allowed.getResponse().getHeader("Access-Control-Allow-Credentials")).isNull();

        MvcResult other = mvc.perform(options("/engine/v1/public/cpl_x/run").header("Origin", "https://evil.test")
                .header("Access-Control-Request-Method", "POST")).andReturn();
        assertThat(other.getResponse().getHeader("Access-Control-Allow-Origin")).isNull();

        MvcResult internal = mvc.perform(options("/engine/v1/reports").header("Origin", "https://site.test")
                .header("Access-Control-Request-Method", "GET")).andReturn();
        assertThat(internal.getResponse().getHeader("Access-Control-Allow-Origin")).as("only the public endpoints allow browsers").isNull();
    }

    @ParameterizedTest(name = "{0}: another workspace cannot see or revoke a link, and exports are not offered to the public")
    @MethodSource(SRC)
    void tenantsAreIsolated(Target t) throws Exception {
        String id = create(publicDefinition(publicView(t), unique("tenant")), List.of());
        publishReport(id);
        JsonNode created = createLink(id, "PUBLIC", Map.of());
        String otherAdmin = TestIdp.bearerWith("other-tenant", "admin", Map.of(), "curf-admin");

        assertThat(status(call(get("/engine/v1/reports/" + id + "/public-links"), otherAdmin, null))).isEqualTo(404);
        assertThat(status(call(delete("/engine/v1/public-links/" + created.get("link").get("id").asString()), otherAdmin, null))).isEqualTo(404);
        assertThat(status(call(put("/engine/v1/reports/" + id + "/shares"), otherAdmin, req("shares", List.of())))).isEqualTo(404);
        assertThat(status(call(post("/engine/v1/reports/" + id + "/publish-requests"), otherAdmin, Map.of()))).isEqualTo(404);
        assertThat(status(publicCall("/engine/v1/public/" + created.get("token").asString() + "/run", Map.of()))).as("the link still works for its own workspace").isEqualTo(200);
        assertThat(status(mvc.perform(post("/engine/v1/reports/" + id + "/exports").contentType(MediaType.APPLICATION_JSON).content("{\"format\":\"CSV\"}")).andReturn()))
                .as("exports need an account").isEqualTo(401);
    }
}
