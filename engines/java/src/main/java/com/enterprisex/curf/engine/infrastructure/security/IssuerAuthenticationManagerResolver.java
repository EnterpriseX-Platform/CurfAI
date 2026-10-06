package com.enterprisex.curf.engine.infrastructure.security;

import jakarta.servlet.http.HttpServletRequest;
import java.util.HashMap;
import java.util.Map;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.AuthenticationManagerResolver;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationProvider;
import org.springframework.security.oauth2.server.resource.authentication.JwtIssuerAuthenticationManagerResolver;

/**
 * Accepts tokens only from configured issuers. Keys come from the configured JWKS URI (no
 * discovery call), so it works in air-gapped networks. An unknown issuer is rejected.
 */
public final class IssuerAuthenticationManagerResolver {

    private IssuerAuthenticationManagerResolver() {}

    public static AuthenticationManagerResolver<HttpServletRequest> create(
            EngineSecurityProperties props, JwtDecoderFactory factory, JwtViewerMapper mapper) {
        Map<String, AuthenticationManager> managers = new HashMap<>();
        for (EngineSecurityProperties.Issuer issuer : props.issuers()) {
            JwtAuthenticationProvider provider = new JwtAuthenticationProvider(factory.create(issuer));
            provider.setJwtAuthenticationConverter(jwt -> new ViewerAuthenticationToken(jwt, mapper.toViewer(jwt)));
            managers.put(issuer.issuer(), provider::authenticate);
        }
        return new JwtIssuerAuthenticationManagerResolver(managers::get);
    }

    /** Default production factory: signature from the JWKS, issuer and optional audience checked. */
    public static JwtDecoderFactory jwksFactory(EngineSecurityProperties props) {
        return issuer -> {
            NimbusJwtDecoder decoder = NimbusJwtDecoder.withJwkSetUri(issuer.jwkSetUri()).build();
            OAuth2TokenValidator<Jwt> validator = JwtValidators.createDefaultWithIssuer(issuer.issuer());
            if (props.audience() != null && !props.audience().isBlank()) {
                OAuth2TokenValidator<Jwt> audience = token -> token.getAudience().contains(props.audience())
                        ? org.springframework.security.oauth2.core.OAuth2TokenValidatorResult.success()
                        : org.springframework.security.oauth2.core.OAuth2TokenValidatorResult.failure(
                                new org.springframework.security.oauth2.core.OAuth2Error(
                                        "invalid_token", "The required audience is missing", null));
                validator = new org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator<>(validator, audience);
            }
            decoder.setJwtValidator(validator);
            return (JwtDecoder) decoder;
        };
    }
}
