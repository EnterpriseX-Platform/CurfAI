package com.enterprisex.curf.engine;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.TestPropertySource;

/** Full application against a real PostgreSQL (CURF_ENGINE_DB_URL/USER/PASSWORD) and a fake identity provider. */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@EnabledIfEnvironmentVariable(named = "CURF_ENGINE_DB_URL", matches = ".+")
@SpringBootTest
@AutoConfigureMockMvc
@Import({TestIdp.class, TestMailer.class})
@TestPropertySource(properties = {
    "curf.engine.security.issuers[0].issuer=" + TestIdp.ISSUER,
    "curf.engine.security.issuers[0].jwk-set-uri=https://idp.test/unused",
    "curf.engine.security.claims.attributes[0]=agency_code",
    "curf.engine.security.claims.tenant=tenant",
    "curf.engine.secrets.master-key=" + TestIdp.TEST_MASTER_KEY,
    "curf.engine.connections.allow-loopback=true",
    "curf.engine.query.queue-wait=300ms",
    "curf.engine.query.per-user-concurrency=2",
    // Low on purpose: lets a test prove that an export cut short by the row limit is refused, not written.
    "curf.engine.exports.max-rows=6",
    // Low on purpose: lets a test prove that one public link cannot be hammered.
    "curf.engine.public.runs-per-minute=6",
    // Tests call the scheduler themselves with chosen times, so the timer stays off.
    "curf.engine.schedules.enabled=false",
    "curf.engine.schedules.allowed-recipient-domains[0]=example.test",
    "curf.engine.schedules.retry-backoff=PT1M",
    "curf.engine.public.allowed-origins[0]=https://site.test",
})
public @interface EngineIT {}
