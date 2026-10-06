package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;

/** The engine must refuse to start rather than run with a missing key or no trusted issuer. */
@EnabledIfEnvironmentVariable(named = "CURF_ENGINE_DB_URL", matches = ".+")
class StartupFailsClosedIT {

    private static final String ISSUER = "--curf.engine.security.issuers[0].issuer=https://idp.test";
    private static final String JWKS = "--curf.engine.security.issuers[0].jwk-set-uri=https://idp.test/jwks";

    /** Command-line arguments outrank application.yml, unlike builder properties, which are only defaults. */
    private static void start(String... args) {
        String[] all = new String[args.length + 1];
        System.arraycopy(args, 0, all, 0, args.length);
        all[args.length] = "--server.port=0";
        new SpringApplicationBuilder(CurfEngineApplication.class)
                .web(WebApplicationType.SERVLET)
                .bannerMode(org.springframework.boot.Banner.Mode.OFF)
                .run(all)
                .close();
    }

    @Test
    void withoutAMasterKey() {
        assertThatThrownBy(() -> start("--curf.engine.secrets.master-key=", ISSUER, JWKS))
                .hasStackTraceContaining("curf.engine.secrets")
                .hasStackTraceContaining("masterKey");
    }

    @Test
    void withoutATrustedIssuer() {
        assertThatThrownBy(() -> start("--curf.engine.secrets.master-key=" + TestIdp.TEST_MASTER_KEY))
                .hasStackTraceContaining("curf.engine.security")
                .hasStackTraceContaining("issuers");
    }

    @Test
    void withAMasterKeyThatIsTooShort() {
        assertThatThrownBy(() -> start("--curf.engine.secrets.master-key=c2hvcnQ=", ISSUER, JWKS))
                .hasStackTraceContaining("32 bytes");
    }

    @Test
    void startsWhenEverythingIsConfigured() {
        start("--curf.engine.secrets.master-key=" + TestIdp.TEST_MASTER_KEY, ISSUER, JWKS);
    }
}
