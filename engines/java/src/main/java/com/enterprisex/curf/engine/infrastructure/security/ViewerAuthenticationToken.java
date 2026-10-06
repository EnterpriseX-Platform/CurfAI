package com.enterprisex.curf.engine.infrastructure.security;

import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.List;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;

/** A validated token plus the {@link Viewer} resolved from it. */
public class ViewerAuthenticationToken extends AbstractAuthenticationToken {

    private final Jwt jwt;
    private final Viewer viewer;

    public ViewerAuthenticationToken(Jwt jwt, Viewer viewer) {
        super(viewer.permissions().stream()
                .map(permission -> new SimpleGrantedAuthority("PERM_" + permission.name()))
                .toList());
        this.jwt = jwt;
        this.viewer = viewer;
        setAuthenticated(true);
    }

    public Viewer viewer() {
        return viewer;
    }

    @Override
    public Object getCredentials() {
        return jwt.getTokenValue();
    }

    @Override
    public Object getPrincipal() {
        return viewer.subject();
    }

    @Override
    public String getName() {
        return viewer.subject();
    }

    List<String> authorityNames() {
        return getAuthorities().stream().map(a -> a.getAuthority()).toList();
    }
}
