package com.enterprisex.curf.engine.application.sharing;

import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Limits for public links and embed tokens. {@code allowedOrigins} are the sites that may call the public endpoints from
 * a browser (CORS); empty means none, so a page on another site cannot embed a report until it is listed.
 */
@ConfigurationProperties(prefix = "curf.engine.public")
public record PublicProperties(
        Integer runsPerMinute,
        Duration linkDefaultTtl,
        Duration linkMaxTtl,
        Duration embedDefaultTtl,
        Duration embedMaxTtl,
        List<String> allowedOrigins) {

    public PublicProperties {
        runsPerMinute = runsPerMinute == null ? 30 : runsPerMinute;
        linkDefaultTtl = linkDefaultTtl == null ? Duration.ofDays(30) : linkDefaultTtl;
        linkMaxTtl = linkMaxTtl == null ? Duration.ofDays(365) : linkMaxTtl;
        embedDefaultTtl = embedDefaultTtl == null ? Duration.ofHours(1) : embedDefaultTtl;
        embedMaxTtl = embedMaxTtl == null ? Duration.ofHours(24) : embedMaxTtl;
        allowedOrigins = allowedOrigins == null ? List.of() : List.copyOf(allowedOrigins);
    }
}
