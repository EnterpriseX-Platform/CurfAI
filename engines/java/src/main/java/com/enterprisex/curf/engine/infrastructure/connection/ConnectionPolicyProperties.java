package com.enterprisex.curf.engine.infrastructure.connection;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Link-local and cloud-metadata addresses are always refused. Loopback is refused unless a
 * deployment that really keeps its database on the same host switches it on.
 */
@ConfigurationProperties(prefix = "curf.engine.connections")
public record ConnectionPolicyProperties(Boolean allowLoopback) {

    public ConnectionPolicyProperties {
        allowLoopback = allowLoopback != null && allowLoopback;
    }
}
