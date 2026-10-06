package com.enterprisex.curf.engine.infrastructure.security;

import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.Collection;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.stereotype.Component;

/** Turns the claims of a validated access token into a {@link Viewer}. */
@Component
public class JwtViewerMapper {

    private final EngineSecurityProperties props;

    public JwtViewerMapper(EngineSecurityProperties props) {
        this.props = props;
    }

    public Viewer toViewer(Jwt jwt) {
        EngineSecurityProperties.Claims claims = props.claims();

        Set<String> roles = collect(jwt.getClaims(), claims.roles());
        Set<String> groups = collect(jwt.getClaims(), claims.groups());
        Map<String, Set<String>> attributes = new HashMap<>();
        for (String name : claims.attributes()) {
            Set<String> values = collect(jwt.getClaims(), List.of(name));
            if (!values.isEmpty()) {
                attributes.put(name, values);
            }
        }

        String username = firstString(jwt.getClaims(), claims.username());
        String tenant = claims.tenant() == null ? null : firstString(jwt.getClaims(), claims.tenant());

        Set<Permission> permissions = EnumSet.noneOf(Permission.class);
        for (String role : roles) {
            permissions.addAll(props.rolePermissions().getOrDefault(role, Set.of()));
        }

        return new Viewer(
                tenant == null || tenant.isBlank() ? props.defaultTenant() : tenant,
                jwt.getSubject(),
                username == null ? jwt.getSubject() : username,
                roles, groups, attributes, permissions);
    }

    private static Set<String> collect(Map<String, Object> claims, List<String> paths) {
        Set<String> out = new LinkedHashSet<>();
        for (String path : paths) {
            Object value = resolve(claims, path);
            if (value instanceof Collection<?> items) {
                items.forEach(item -> out.add(String.valueOf(item)));
            } else if (value != null) {
                out.add(String.valueOf(value));
            }
        }
        return out;
    }

    private static String firstString(Map<String, Object> claims, String path) {
        Object value = resolve(claims, path);
        return value == null ? null : String.valueOf(value);
    }

    private static Object resolve(Map<String, Object> claims, String path) {
        if (claims.containsKey(path)) {
            return claims.get(path);
        }
        Object current = claims;
        for (String part : path.split("\\.")) {
            if (!(current instanceof Map<?, ?> map)) {
                return null;
            }
            current = map.get(part);
        }
        return current;
    }
}
