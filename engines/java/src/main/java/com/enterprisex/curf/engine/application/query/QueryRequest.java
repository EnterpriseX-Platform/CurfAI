package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.domain.query.StructuredQuery;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Aggregate;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Filter;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Order;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Either a view ({@code viewId} plus the structured parts: columns, filters, grouping, aggregates,
 * ordering) or, for administrators, raw SQL on one connection ({@code connectionId} plus {@code sql}).
 * Named parameters (:name) are bound, never interpolated. Limits ask for less than the engine's
 * ceilings; {@code maxAgeSeconds} allows an answer up to that old from the cache.
 */
public record QueryRequest(
        UUID viewId,
        UUID connectionId,
        String sql,
        Map<String, Object> params,
        List<String> columns,
        List<Filter> filters,
        List<String> groupBy,
        List<Aggregate> aggregates,
        List<Order> orderBy,
        Integer limit,
        Integer timeoutMs,
        Integer maxAgeSeconds) {

    public QueryRequest {
        params = params == null ? Map.of() : Map.copyOf(params);
    }

    public StructuredQuery structured() {
        return new StructuredQuery(columns, filters, groupBy, aggregates, orderBy);
    }

    public static QueryRequest raw(UUID connectionId, String sql, Map<String, Object> params) {
        return new QueryRequest(null, connectionId, sql, params, null, null, null, null, null, null, null, null);
    }
}
