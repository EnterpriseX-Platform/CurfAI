package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.MockMvc;

@EngineIT
class EngineApiIT {

    @Autowired MockMvc mvc;
    @Autowired AuditService audit;
    @Autowired JdbcClient jdbc;

    private static String bearer(String... roles) {
        return TestIdp.bearer("default", "u-1", roles);
    }

    @Test
    void healthIsOpenAndEverythingElseNeedsAToken() throws Exception {
        mvc.perform(get("/engine/v1/actuator/health")).andExpect(status().isOk());
        mvc.perform(get("/engine/v1/me"))
                .andExpect(status().isUnauthorized())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.code").value("CURF_UNAUTHENTICATED"));
    }

    @Test
    void meReturnsTheViewerResolvedFromTheToken() throws Exception {
        mvc.perform(get("/engine/v1/me").header("Authorization", bearer("curf-developer")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.username").value("u-1"))
                .andExpect(jsonPath("$.subject").value("u-1"))
                .andExpect(jsonPath("$.attributes.agency_code[0]").value("A001"))
                .andExpect(jsonPath("$.permissions[?(@=='view:manage')]").exists());
    }

    @Test
    void rejectsTokensFromUnknownIssuersAndWrongKeys() throws Exception {
        String unknownIssuer = "Bearer " + TestIdp.token(TestIdp.KEY, "https://evil.test", Map.of());
        String wrongKey = "Bearer " + TestIdp.token(TestIdp.OTHER_KEY, TestIdp.ISSUER, Map.of());
        mvc.perform(get("/engine/v1/me").header("Authorization", unknownIssuer)).andExpect(status().isUnauthorized());
        mvc.perform(get("/engine/v1/me").header("Authorization", wrongKey)).andExpect(status().isUnauthorized());
        mvc.perform(get("/engine/v1/me").header("Authorization", "Bearer garbage")).andExpect(status().isUnauthorized());
    }

    @Test
    void auditNeedsPermissionAndIsTenantScoped() throws Exception {
        Viewer actor = new Viewer("default", "u-9", "u-9", Set.of(), Set.of(), Map.of(), Set.of());
        Viewer other = new Viewer("other-tenant", "u-7", "u-7", Set.of(), Set.of(), Map.of(), Set.of());
        String mine = "c-" + UUID.randomUUID();
        String theirs = "c-" + UUID.randomUUID();
        audit.record(actor, "connection.create", "connection", mine, "{\"name\":\"x\"}");
        audit.record(other, "connection.create", "connection", theirs, "{}");

        mvc.perform(get("/engine/v1/audit-events").header("Authorization", bearer("curf-viewer")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CURF_FORBIDDEN"));

        mvc.perform(get("/engine/v1/audit-events?entityId=" + mine).header("Authorization", bearer("curf-admin")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.totalElements").value(1))
                .andExpect(jsonPath("$.content[0].action").value("connection.create"));
        mvc.perform(get("/engine/v1/audit-events?entityId=" + theirs).header("Authorization", bearer("curf-admin")))
                .andExpect(jsonPath("$.totalElements").value(0));
    }

    @Test
    void badInputIsAProblemNotAServerError() throws Exception {
        mvc.perform(get("/engine/v1/audit-events?size=0").header("Authorization", bearer("curf-admin")))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("CURF_INVALID_INPUT"));
        mvc.perform(get("/engine/v1/audit-events?page=abc").header("Authorization", bearer("curf-admin")))
                .andExpect(status().isUnprocessableEntity());
        mvc.perform(get("/engine/v1/nope").header("Authorization", bearer("curf-admin")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("CURF_NOT_FOUND"));
    }

    @Test
    void auditRowsCannotBeChangedOrDeleted() {
        Viewer actor = new Viewer("default", "u-3", "u-3", Set.of(), Set.of(), Map.of(), Set.of(Permission.AUDIT_READ));
        String id = "r-" + UUID.randomUUID();
        audit.record(actor, "report.update", "report", id, "{}");

        assertThatThrownBy(() -> jdbc.sql("update engine_audit_event set actor = 'x' where entity_id = :id").param("id", id).update())
                .hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.sql("delete from engine_audit_event where entity_id = :id").param("id", id).update())
                .hasMessageContaining("append-only");
        assertThat(jdbc.sql("select count(*) from engine_audit_event where entity_id = :id").param("id", id)
                        .query(Long.class).single())
                .isEqualTo(1L);
    }
}
