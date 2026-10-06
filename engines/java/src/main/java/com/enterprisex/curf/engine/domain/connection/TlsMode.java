package com.enterprisex.curf.engine.domain.connection;

/**
 * VERIFY checks the server certificate and host name and is the default. The other two are explicit,
 * per-connection opt-outs that the connection test reports as warnings.
 */
public enum TlsMode {
    VERIFY,
    REQUIRE,
    DISABLE
}
