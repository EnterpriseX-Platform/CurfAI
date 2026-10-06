package com.enterprisex.curf.engine.infrastructure.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;

class JwtViewerMapperTest {

    private static EngineSecurityProperties props(EngineSecurityProperties.Claims claims) {
        return new EngineSecurityProperties(
                List.of(new EngineSecurityProperties.Issuer("https://idp", "https://idp/jwks")),
                null, claims, null, null);
    }

    private static Jwt jwt(Map<String, Object> claims) {
        Jwt.Builder builder = Jwt.withTokenValue("t").header("alg", "none").issuedAt(Instant.now())
                .expiresAt(Instant.now().plusSeconds(60)).subject("user-1");
        claims.forEach(builder::claim);
        return builder.build();
    }

    @Test
    void mapsRolesGroupsAttributesAndPermissions() {
        var mapper = new JwtViewerMapper(props(new EngineSecurityProperties.Claims(
                null, null, null, List.of("agency_code"), null)));

        Viewer viewer = mapper.toViewer(jwt(Map.of(
                "preferred_username", "somchai",
                "realm_access", Map.of("roles", List.of("curf-developer", "unknown-role")),
                "groups", List.of("/finance"),
                "agency_code", "A001")));

        assertThat(viewer.subject()).isEqualTo("user-1");
        assertThat(viewer.username()).isEqualTo("somchai");
        assertThat(viewer.tenantId()).isEqualTo("default");
        assertThat(viewer.roles()).containsExactlyInAnyOrder("curf-developer", "unknown-role");
        assertThat(viewer.groups()).containsExactly("/finance");
        assertThat(viewer.attribute("agency_code")).containsExactly("A001");
        assertThat(viewer.can(Permission.VIEW_MANAGE)).isTrue();
        assertThat(viewer.can(Permission.AUDIT_READ)).isFalse();
        assertThat(viewer.isAnonymous()).isFalse();
    }

    @Test
    void literalClaimKeysWithDotsAndMultiValuedAttributesWork() {
        var mapper = new JwtViewerMapper(props(new EngineSecurityProperties.Claims(
                null, List.of("https://idp.example/roles"), null, List.of("org_unit"), "tenant")));

        Viewer viewer = mapper.toViewer(jwt(Map.of(
                "https://idp.example/roles", List.of("curf-admin"),
                "org_unit", List.of("U1", "U2"),
                "tenant", "t-9")));

        assertThat(viewer.tenantId()).isEqualTo("t-9");
        assertThat(viewer.attribute("org_unit")).containsExactlyInAnyOrder("U1", "U2");
        assertThat(viewer.permissions()).containsExactlyInAnyOrder(Permission.values());
    }

    @Test
    void missingClaimsGiveAnEmptyViewerNotAnError() {
        var mapper = new JwtViewerMapper(props(null));

        Viewer viewer = mapper.toViewer(jwt(Map.of()));

        assertThat(viewer.username()).isEqualTo("user-1");
        assertThat(viewer.roles()).isEmpty();
        assertThat(viewer.permissions()).isEmpty();
        assertThat(viewer.attribute("agency_code")).isEmpty();
    }

    @Test
    void anonymousViewerHasNothing() {
        assertThat(Viewer.ANONYMOUS.isAnonymous()).isTrue();
        assertThat(Viewer.ANONYMOUS.permissions()).isEmpty();
        assertThat(Viewer.ANONYMOUS.roles()).isEmpty();
    }
}
