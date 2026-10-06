package com.enterprisex.curf.engine.domain.query;

import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Aggregate;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Filter;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Order;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewColumn;
import com.enterprisex.curf.engine.domain.view.ViewPolicy;
import com.enterprisex.curf.engine.domain.view.ViewPolicy.Access;
import com.enterprisex.curf.engine.domain.view.ViewPolicy.ColumnAccess;
import com.enterprisex.curf.engine.domain.view.ViewPolicy.Restricted;
import com.enterprisex.curf.engine.domain.view.ViewPolicy.ResolvedRule;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Builds the statement a viewer's request turns into. Two levels, so a viewer's request can only ever
 * reach what the policy lets through:
 *
 * <pre>
 * SELECT &lt;requested&gt; FROM (
 *   SELECT &lt;visible columns, masked ones replaced&gt; FROM (&lt;view sql&gt;) AS v WHERE &lt;row rules&gt;
 * ) AS m WHERE &lt;filters&gt; GROUP BY ... ORDER BY ... LIMIT n
 * </pre>
 *
 * Row rules run against the raw view output (so they can use hidden columns); everything the viewer
 * names (filters, grouping, ordering, aggregates) resolves against {@code m}, where hidden columns do not
 * exist and masked ones already hold the mask. Names are checked against that set and quoted; values are
 * bound as named parameters (prefix {@code __}, which callers may not use).
 */
public final class QueryComposer {

    public static final String RESERVED_PARAM_PREFIX = "__";
    /** Letters in any script (including combining marks, which Thai needs for vowels and tones), digits, _ and $. */
    static final Pattern NAME = Pattern.compile("[\\p{L}_][\\p{L}\\p{M}\\p{N}_$]{0,127}");
    private static final int MAX_LIST = 1000;
    private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final Pattern TIMESTAMP = Pattern.compile("\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,6})?)?");

    /** The statement, its generated parameters, and the names of the columns it returns. */
    public record Composed(String sql, Map<String, Object> params, List<String> outputNames) {}

    private QueryComposer() {}

    public static Composed compose(View view, Access access, StructuredQuery query, ConnectionKind kind, int limit) {
        Map<String, ColumnAccess> visible = new LinkedHashMap<>();
        access.columns().forEach(c -> visible.put(c.column().name(), c));
        if (visible.isEmpty()) {
            throw invalid("columns", "this view offers you no columns");
        }
        Map<String, Object> params = new LinkedHashMap<>();

        StringBuilder sql = new StringBuilder("SELECT ").append(Dialects.limitPrefix(kind, limit));
        List<String> outputs = projection(query, visible, kind, sql);
        sql.append(" FROM (").append(inner(view, access, visible, kind, params)).append(")").append(Dialects.tableAlias(kind, "m"));

        List<String> where = new ArrayList<>();
        for (int i = 0; i < query.filters().size(); i++) {
            where.add(filter(i, query.filters().get(i), visible, kind, params));
        }
        if (!where.isEmpty()) {
            sql.append(" WHERE ").append(String.join(" AND ", where));
        }
        if (!query.groupBy().isEmpty()) {
            sql.append(" GROUP BY ").append(String.join(", ", query.groupBy().stream().map(g -> Dialects.quote(kind, g)).toList()));
        }
        orderBy(query, visible, outputs, kind, sql);
        sql.append(Dialects.limitSuffix(kind, limit));
        return new Composed(sql.toString(), params, outputs);
    }

    // ------------------------------------------------------------------ inner select: policy

    private static String inner(View view, Access access, Map<String, ColumnAccess> visible, ConnectionKind kind, Map<String, Object> params) {
        List<String> select = new ArrayList<>();
        for (ColumnAccess c : visible.values()) {
            String name = c.column().name();
            String expr = c.masked() ? Dialects.mask(kind, c.column()) : "v." + Dialects.quote(kind, name);
            select.add(expr + " AS " + Dialects.quote(kind, name));
        }
        StringBuilder sb = new StringBuilder("SELECT ").append(String.join(", ", select))
                .append(" FROM (").append(view.sql()).append(")").append(Dialects.tableAlias(kind, "v"));

        switch (access.rows()) {
            case ViewPolicy.Unrestricted u -> { }
            case ViewPolicy.Denied d -> sb.append(" WHERE 1 = 0");
            case Restricted r -> {
                List<String> predicates = new ArrayList<>();
                for (int i = 0; i < r.rules().size(); i++) {
                    predicates.add(rule(i, r.rules().get(i), view, kind, params));
                }
                sb.append(" WHERE ").append(String.join(" AND ", predicates));
            }
        }
        return sb.toString();
    }

    private static String rule(int index, ResolvedRule resolved, View view, ConnectionKind kind, Map<String, Object> params) {
        ViewColumn column = view.column(resolved.rule().column());
        TypeCategory category = TypeCategory.of(column.type());
        List<String> placeholders = new ArrayList<>();
        int j = 0;
        for (String raw : new LinkedHashSet<>(resolved.values())) {
            Object value;
            try {
                value = convert(category, raw);
            } catch (IllegalArgumentException e) {
                continue; // a value that cannot match this column's type matches nothing
            }
            String name = RESERVED_PARAM_PREFIX + "r" + index + "_" + j++;
            params.put(name, value);
            placeholders.add(placeholder(kind, category, column.type(), name));
        }
        if (placeholders.isEmpty()) {
            return "1 = 0";
        }
        return "v." + Dialects.quote(kind, column.name()) + " IN (" + String.join(", ", placeholders) + ")";
    }

    // ------------------------------------------------------------------ outer select: what the viewer asked

    private static List<String> projection(StructuredQuery q, Map<String, ColumnAccess> visible, ConnectionKind kind, StringBuilder sql) {
        List<String> outputs = new ArrayList<>();
        List<String> parts = new ArrayList<>();
        if (q.grouped()) {
            for (String g : q.groupBy()) {
                requireVisible(g, visible, "groupBy");
                if (!outputs.contains(g)) {
                    outputs.add(g);
                    parts.add(Dialects.quote(kind, g));
                }
            }
            for (String c : q.columns()) {
                if (!q.groupBy().contains(c)) {
                    throw invalid("columns", "when grouping, columns must be listed in groupBy: " + safe(c));
                }
            }
            for (int i = 0; i < q.aggregates().size(); i++) {
                Aggregate a = q.aggregates().get(i);
                String alias = alias(a, i);
                if (outputs.contains(alias)) {
                    throw invalid("aggregates[" + i + "].as", "duplicate output name " + safe(alias));
                }
                outputs.add(alias);
                parts.add(aggregate(a, i, visible, kind) + " AS " + Dialects.quote(kind, alias));
            }
            if (parts.isEmpty()) {
                throw invalid("groupBy", "nothing to select");
            }
        } else if (q.columns().isEmpty()) {
            for (String name : visible.keySet()) {
                outputs.add(name);
                parts.add(Dialects.quote(kind, name));
            }
        } else {
            for (String c : q.columns()) {
                requireVisible(c, visible, "columns");
                if (!outputs.contains(c)) {
                    outputs.add(c);
                    parts.add(Dialects.quote(kind, c));
                }
            }
        }
        sql.append(String.join(", ", parts));
        return outputs;
    }

    private static String aggregate(Aggregate a, int i, Map<String, ColumnAccess> visible, ConnectionKind kind) {
        if (a.fn() == null) {
            throw invalid("aggregates[" + i + "].fn", "is required");
        }
        if (a.column() == null) {
            if (a.fn() != StructuredQuery.AggregateFn.COUNT) {
                throw invalid("aggregates[" + i + "].column", "is required for " + a.fn());
            }
            return "COUNT(*)";
        }
        requireVisible(a.column(), visible, "aggregates[" + i + "].column");
        if ((a.fn() == StructuredQuery.AggregateFn.SUM || a.fn() == StructuredQuery.AggregateFn.AVG)
                && TypeCategory.of(visible.get(a.column()).column().type()) != TypeCategory.NUMBER) {
            throw invalid("aggregates[" + i + "].column", a.fn() + " needs a numeric column");
        }
        return a.fn().name() + "(" + Dialects.quote(kind, a.column()) + ")";
    }

    private static String alias(Aggregate a, int i) {
        String alias = a.as() != null ? a.as()
                : (a.column() == null ? "count_all" : (a.fn() == null ? "value" : a.fn().name().toLowerCase(Locale.ROOT)) + "_" + a.column());
        if (!NAME.matcher(alias).matches()) {
            throw invalid("aggregates[" + i + "].as", "must be a plain name (letters, digits, _)");
        }
        return alias;
    }

    private static String filter(int i, Filter f, Map<String, ColumnAccess> visible, ConnectionKind kind, Map<String, Object> params) {
        String field = "filters[" + i + "]";
        if (f.column() == null || f.op() == null) {
            throw invalid(field, "column and op are required");
        }
        requireVisible(f.column(), visible, field + ".column");
        ViewColumn column = visible.get(f.column()).column();
        TypeCategory category = TypeCategory.of(column.type());
        String ref = Dialects.quote(kind, f.column());

        return switch (f.op()) {
            case IS_NULL -> ref + " IS NULL";
            case IS_NOT_NULL -> ref + " IS NOT NULL";
            case EQ, NE, GT, GE, LT, LE -> {
                if (f.value() == null) {
                    throw invalid(field + ".value", "is required; use IS_NULL to test for null");
                }
                if (category == TypeCategory.BOOLEAN && f.op() != StructuredQuery.FilterOp.EQ && f.op() != StructuredQuery.FilterOp.NE) {
                    throw invalid(field + ".op", "booleans only support EQ and NE");
                }
                yield ref + " " + symbol(f.op()) + " " + bind(i, 0, category, column, f.value(), field + ".value", kind, params);
            }
            case LIKE -> {
                if (category != TypeCategory.TEXT || !(f.value() instanceof String)) {
                    throw invalid(field, "LIKE needs a text column and a text value");
                }
                yield ref + " LIKE " + bind(i, 0, category, column, f.value(), field + ".value", kind, params);
            }
            case IN, NOT_IN -> {
                List<Object> values = f.values();
                if (values == null || values.isEmpty() || values.size() > MAX_LIST) {
                    throw invalid(field + ".values", "needs between 1 and " + MAX_LIST + " values");
                }
                List<String> marks = new ArrayList<>();
                for (int j = 0; j < values.size(); j++) {
                    marks.add(bind(i, j, category, column, values.get(j), field + ".values[" + j + "]", kind, params));
                }
                yield ref + (f.op() == StructuredQuery.FilterOp.IN ? " IN (" : " NOT IN (") + String.join(", ", marks) + ")";
            }
            case BETWEEN -> {
                if (f.values() == null || f.values().size() != 2) {
                    throw invalid(field + ".values", "BETWEEN needs exactly two values");
                }
                yield ref + " BETWEEN " + bind(i, 0, category, column, f.values().get(0), field + ".values[0]", kind, params)
                        + " AND " + bind(i, 1, category, column, f.values().get(1), field + ".values[1]", kind, params);
            }
        };
    }

    private static String bind(int i, int j, TypeCategory category, ViewColumn column, Object raw, String field,
            ConnectionKind kind, Map<String, Object> params) {
        Object value;
        try {
            value = convert(category, raw);
        } catch (IllegalArgumentException e) {
            throw invalid(field, e.getMessage());
        }
        String name = RESERVED_PARAM_PREFIX + "f" + i + "_" + j;
        params.put(name, value);
        return placeholder(kind, category, column.type(), name);
    }

    private static void orderBy(StructuredQuery q, Map<String, ColumnAccess> visible, List<String> outputs, ConnectionKind kind, StringBuilder sql) {
        if (q.orderBy().isEmpty()) {
            return;
        }
        List<String> parts = new ArrayList<>();
        for (int i = 0; i < q.orderBy().size(); i++) {
            Order o = q.orderBy().get(i);
            boolean allowed = q.grouped() ? outputs.contains(o.column()) : visible.containsKey(o.column());
            if (o.column() == null || !allowed) {
                throw invalid("orderBy[" + i + "].column", "unknown column " + safe(o.column()));
            }
            parts.add(Dialects.quote(kind, o.column()) + (o.descending() ? " DESC" : " ASC"));
        }
        sql.append(" ORDER BY ").append(String.join(", ", parts));
    }

    // ------------------------------------------------------------------ values

    private static String placeholder(ConnectionKind kind, TypeCategory category, String declaredType, String name) {
        return switch (category) {
            case DATE, TIMESTAMP -> Dialects.bindDate(kind, category, declaredType, name);
            default -> ":" + name;
        };
    }

    static Object convert(TypeCategory category, Object raw) {
        if (raw == null) {
            throw new IllegalArgumentException("must not be null");
        }
        switch (category) {
            case NUMBER -> {
                if (raw instanceof Number n) {
                    return new BigDecimal(n.toString());
                }
                if (raw instanceof String s) {
                    try {
                        return new BigDecimal(s.trim());
                    } catch (NumberFormatException e) {
                        throw new IllegalArgumentException("must be a number");
                    }
                }
                throw new IllegalArgumentException("must be a number");
            }
            case BOOLEAN -> {
                if (raw instanceof Boolean b) {
                    return b;
                }
                if (raw instanceof String s && (s.equalsIgnoreCase("true") || s.equalsIgnoreCase("false"))) {
                    return Boolean.parseBoolean(s);
                }
                throw new IllegalArgumentException("must be true or false");
            }
            case DATE -> {
                if (raw instanceof String s && DATE.matcher(s).matches()) {
                    return s;
                }
                throw new IllegalArgumentException("must be a date, yyyy-MM-dd");
            }
            case TIMESTAMP -> {
                if (raw instanceof String s && TIMESTAMP.matcher(s).matches()) {
                    String spaced = s.replace('T', ' ');
                    return spaced.length() == 16 ? spaced + ":00" : spaced;
                }
                throw new IllegalArgumentException("must be a timestamp, yyyy-MM-dd HH:mm[:ss] (database time zone)");
            }
            default -> {
                if (raw instanceof String || raw instanceof Number || raw instanceof Boolean) {
                    return raw.toString();
                }
                throw new IllegalArgumentException("must be text, a number or a boolean");
            }
        }
    }

    private static String symbol(StructuredQuery.FilterOp op) {
        return switch (op) {
            case EQ -> "=";
            case NE -> "<>";
            case GT -> ">";
            case GE -> ">=";
            case LT -> "<";
            case LE -> "<=";
            default -> throw new IllegalStateException();
        };
    }

    private static void requireVisible(String name, Map<String, ColumnAccess> visible, String field) {
        if (name == null || !visible.containsKey(name)) {
            throw invalid(field, "unknown column " + safe(name));
        }
    }

    /** Never echo more than a short, printable name back to the caller. */
    private static String safe(String name) {
        if (name == null) {
            return "(none)";
        }
        String cut = name.length() > 40 ? name.substring(0, 40) : name;
        return "'" + cut.replaceAll("[^\\p{L}\\p{N}_$ .-]", "?") + "'";
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }

    /** Names the view's own definition may use for columns and rules. */
    public static boolean validName(String name) {
        return name != null && NAME.matcher(name).matches();
    }
}
