package com.enterprisex.curf.engine;

import com.enterprisex.curf.engine.infrastructure.security.JwtDecoderFactory;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;

/** A fake identity provider: signs tokens with a throwaway key and teaches the engine to trust it. */
@TestConfiguration
public class TestIdp {

    public static final String ISSUER = "https://idp.test/realms/main";
    public static final String TEST_MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
    static final RSAKey KEY = generate();
    static final RSAKey OTHER_KEY = generate();

    @Bean
    @Primary
    JwtDecoderFactory testDecoders() {
        return issuer -> {
            try {
                NimbusJwtDecoder decoder = NimbusJwtDecoder.withPublicKey(KEY.toRSAPublicKey()).build();
                decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer(issuer.issuer()));
                return decoder;
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        };
    }

    static RSAKey generate() {
        try {
            return new RSAKeyGenerator(2048).keyID("k").generate();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    static String token(RSAKey signer, String issuer, Map<String, Object> claims) {
        var encoder = new NimbusJwtEncoder(new ImmutableJWKSet<>(new JWKSet(signer)));
        JwtClaimsSet.Builder set = JwtClaimsSet.builder()
                .issuer(issuer).subject("u-1")
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(300));
        claims.forEach(set::claim);
        return encoder.encode(JwtEncoderParameters.from(
                JwsHeader.with(SignatureAlgorithm.RS256).keyId("k").build(), set.build())).getTokenValue();
    }

    /** Like {@link #bearer} but with exactly the extra claims given (for example none, or several agency codes). */
    static String bearerWith(String tenant, String subject, Map<String, Object> extraClaims, String... roles) {
        Map<String, Object> claims = new java.util.HashMap<>(extraClaims);
        claims.put("sub", subject);
        claims.put("preferred_username", subject);
        claims.put("tenant", tenant);
        claims.put("realm_access", Map.of("roles", List.of(roles)));
        return "Bearer " + token(KEY, ISSUER, claims);
    }

    /** Authorization header for a user holding the given Curf roles in the given tenant. */
    static String bearer(String tenant, String subject, String... roles) {
        return "Bearer " + token(KEY, ISSUER, Map.of(
                "sub", subject,
                "preferred_username", subject,
                "tenant", tenant,
                "realm_access", Map.of("roles", List.of(roles)),
                "agency_code", "A001"));
    }
}
