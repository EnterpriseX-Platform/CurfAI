package com.enterprisex.curf.engine.infrastructure.security;

import org.springframework.security.oauth2.jwt.JwtDecoder;

/** Seam so tests can supply decoders without a live identity provider. */
@FunctionalInterface
public interface JwtDecoderFactory {

    JwtDecoder create(EngineSecurityProperties.Issuer issuer);
}
