package com.enterprisex.curf.engine.application.report;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Where one query's data came from, in the shape Curf records (provenance.ts). Fields that do not apply
 * are left out. {@code accessDeniedNote} means the viewer may not use that data source; {@code executionError}
 * means the query failed; either way the dataset for the query is empty and the rest of the report still runs.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProvenanceRecord(
        String queryId,
        String queryName,
        String queryHash,
        String runAt,
        long durationMs,
        int rowCount,
        String dataHash,
        String dataSourceName,
        String dataSourceKind,
        String accessDeniedNote,
        String executionError,
        Boolean truncated) {}
