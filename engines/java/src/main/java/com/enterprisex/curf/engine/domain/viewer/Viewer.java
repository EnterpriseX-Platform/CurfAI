package com.enterprisex.curf.engine.domain.viewer;

import java.util.Map;
import java.util.Set;

/**
 * The resolved identity a request runs as. Built per request from the access token (and, from
 * the policy milestone on, the entitlement table). Anonymous viewers carry no roles, so every
 * PII column masks for them.
 */
public record Viewer(
        String tenantId,
        String subject,
        String username,
        Set<String> roles,
        Set<String> groups,
        Map<String, Set<String>> attributes,
        Set<Permission> permissions) {

    public static final Viewer ANONYMOUS =
            new Viewer("", "anonymous", "anonymous", Set.of(), Set.of(), Map.of(), Set.of());

    public Viewer {
        roles = Set.copyOf(roles);
        groups = Set.copyOf(groups);
        attributes = Map.copyOf(attributes);
        permissions = Set.copyOf(permissions);
    }

    /** The identity a public link or embed token runs as: nobody in particular, with the reserved role {@code public}. */
    public static Viewer publicLink(String tenantId, String linkId) {
        return new Viewer(tenantId, "public:" + linkId, "public", Set.of("public"), Set.of(), Map.of(), Set.of());
    }

    /** True for the anonymous viewer and for a public link's viewer: never sees personal data, holds no attributes. */
    public boolean isAnonymous() {
        return equals(ANONYMOUS) || subject.startsWith("public:");
    }

    public boolean can(Permission permission) {
        return permissions.contains(permission);
    }

    public Set<String> attribute(String name) {
        return attributes.getOrDefault(name, Set.of());
    }
}
