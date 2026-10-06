package com.enterprisex.curf.engine.infrastructure.security;

import com.enterprisex.curf.engine.domain.viewer.Permission;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * Everything identity-provider specific is configuration: issuers, audience, which claims carry
 * roles, groups and attributes. There is no default issuer, so the engine does not start
 * unconfigured.
 */
@Validated
@ConfigurationProperties(prefix = "curf.engine.security")
public record EngineSecurityProperties(
        @NotEmpty List<@Valid Issuer> issuers,
        String audience,
        Claims claims,
        String defaultTenant,
        Map<String, Set<Permission>> rolePermissions) {

    public record Issuer(@NotBlank String issuer, @NotBlank String jwkSetUri) {}

    /** Claim paths use dots for nesting, e.g. {@code realm_access.roles}. */
    public record Claims(String username, List<String> roles, List<String> groups, List<String> attributes, String tenant) {

        public Claims {
            username = username == null || username.isBlank() ? "preferred_username" : username;
            roles = roles == null ? List.of("realm_access.roles") : List.copyOf(roles);
            groups = groups == null ? List.of("groups") : List.copyOf(groups);
            attributes = attributes == null ? List.of() : List.copyOf(attributes);
        }
    }

    public EngineSecurityProperties {
        claims = claims == null ? new Claims(null, null, null, null, null) : claims;
        defaultTenant = defaultTenant == null || defaultTenant.isBlank() ? "default" : defaultTenant;
        rolePermissions = rolePermissions == null || rolePermissions.isEmpty() ? defaultRolePermissions() : rolePermissions;
    }

    static Map<String, Set<Permission>> defaultRolePermissions() {
        return Map.of(
                "curf-admin", Set.of(Permission.values()),
                "curf-developer", Set.of(
                        Permission.VIEW_MANAGE, Permission.REPORT_EDIT,
                        Permission.REPORT_PUBLISH_REQUEST, Permission.SCHEDULE_MANAGE),
                "curf-approver", Set.of(Permission.REPORT_APPROVE),
                "curf-viewer", Set.of());
    }
}
