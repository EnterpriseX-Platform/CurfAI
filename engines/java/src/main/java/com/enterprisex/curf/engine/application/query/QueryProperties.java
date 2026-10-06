package com.enterprisex.curf.engine.application.query;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/** Ceilings for every statement. A caller may ask for less, never for more. */
@ConfigurationProperties(prefix = "curf.engine.query")
public record QueryProperties(
        Integer maxRows,
        Duration defaultTimeout,
        Duration maxTimeout,
        Long maxBytes,
        Integer perUserConcurrency,
        Duration queueWait,
        Integer cacheMaxEntries,
        Integer maxCacheAgeSeconds) {

    public QueryProperties {
        maxRows = maxRows == null ? 10_000 : maxRows;
        defaultTimeout = defaultTimeout == null ? Duration.ofSeconds(30) : defaultTimeout;
        maxTimeout = maxTimeout == null ? Duration.ofSeconds(120) : maxTimeout;
        maxBytes = maxBytes == null ? 64L * 1024 * 1024 : maxBytes;
        perUserConcurrency = perUserConcurrency == null ? 4 : perUserConcurrency;
        queueWait = queueWait == null ? Duration.ofSeconds(2) : queueWait;
        cacheMaxEntries = cacheMaxEntries == null ? 256 : cacheMaxEntries;
        maxCacheAgeSeconds = maxCacheAgeSeconds == null ? 300 : maxCacheAgeSeconds;
    }
}
