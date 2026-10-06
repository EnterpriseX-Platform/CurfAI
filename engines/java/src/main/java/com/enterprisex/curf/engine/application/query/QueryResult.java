package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.application.query.QueryBackend.Column;
import java.time.Instant;
import java.util.List;

/**
 * A dataset plus where it came from. {@code asOf} is when the database answered, even for a cache hit.
 * {@code provenance.sha256} covers the executed SQL, bound values and result rows.
 */
public record QueryResult(
        List<Column> columns,
        List<List<Object>> rows,
        int rowCount,
        boolean truncated,
        long durationMs,
        Instant asOf,
        String cache,
        Provenance provenance) {

    public record Provenance(String sha256, String connectionFingerprint, Integer viewVersion) {}

    QueryResult asCacheHit() {
        return new QueryResult(columns, rows, rowCount, truncated, 0, asOf, "hit", provenance);
    }
}
