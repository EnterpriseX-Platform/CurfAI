package com.enterprisex.curf.engine.application.report;

import java.util.List;
import java.util.Map;

/**
 * What running a report returns, in the shape of Curf's own run response: one dataset (a list of rows
 * keyed by column name) and one provenance record per query, plus the parameters as applied.
 */
public record RunResult(
        Map<String, List<Map<String, Object>>> dataset,
        Map<String, ProvenanceRecord> provenance,
        Map<String, Object> params,
        int reportVersion,
        String asOf) {}
