package com.enterprisex.curf.engine.application.query;

import java.time.Instant;
import java.util.UUID;

/** Port. Records who ran what, by hash. Literal parameter values may be personal data and are never stored. */
public interface QueryLog {

    record Entry(
            String tenantId, Instant occurredAt, String subject, UUID connectionId, UUID viewId, Integer viewVersion,
            String sqlHash, String paramsHash, Integer rowCount, long durationMs, boolean cacheHit, String outcome) {}

    void record(Entry entry);
}
