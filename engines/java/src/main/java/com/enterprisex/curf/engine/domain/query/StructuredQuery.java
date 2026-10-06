package com.enterprisex.curf.engine.domain.query;

import java.util.List;

/**
 * What a viewer may ask of a view: which columns, which filters, grouping, aggregates and ordering.
 * Every name must be one of the view's visible columns, and every value is bound, never concatenated.
 */
public record StructuredQuery(
        List<String> columns,
        List<Filter> filters,
        List<String> groupBy,
        List<Aggregate> aggregates,
        List<Order> orderBy) {

    public enum FilterOp {
        EQ,
        NE,
        GT,
        GE,
        LT,
        LE,
        IN,
        NOT_IN,
        LIKE,
        BETWEEN,
        IS_NULL,
        IS_NOT_NULL
    }

    public enum AggregateFn {
        COUNT,
        SUM,
        AVG,
        MIN,
        MAX
    }

    /** {@code value} for single-value operators, {@code values} for IN, NOT_IN and BETWEEN. */
    public record Filter(String column, FilterOp op, Object value, List<Object> values) {}

    /** {@code column} may be null for COUNT, meaning COUNT(*). */
    public record Aggregate(AggregateFn fn, String column, String as) {}

    public record Order(String column, boolean descending) {}

    public StructuredQuery {
        columns = columns == null ? List.of() : List.copyOf(columns);
        filters = filters == null ? List.of() : List.copyOf(filters);
        groupBy = groupBy == null ? List.of() : List.copyOf(groupBy);
        aggregates = aggregates == null ? List.of() : List.copyOf(aggregates);
        orderBy = orderBy == null ? List.of() : List.copyOf(orderBy);
    }

    public static StructuredQuery all() {
        return new StructuredQuery(null, null, null, null, null);
    }

    public boolean grouped() {
        return !aggregates.isEmpty() || !groupBy.isEmpty();
    }
}
