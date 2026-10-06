package com.enterprisex.curf.engine.application.report;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.SqlGuard;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Aggregate;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.FilterOp;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Order;
import com.enterprisex.curf.engine.domain.report.ReportParameter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Reads the parts of a Curf report definition the engine has to understand (parameters and queries, and
 * which queries blocks use) and checks them. Everything else (pages, blocks, themes) is presentation and
 * is stored and returned untouched, so the definition stays Curf's own format.
 *
 * <p>A query is bound to the engine one of two ways:
 * <ul>
 *   <li>{@code engine}: a published view plus structured parts, run as the person running the report, so
 *       their row rules and masking apply. Values may be {@code {"$param": "name"}} to use a report parameter.
 *   <li>{@code sql}: raw SQL on an engine connection ({@code dataSourceId}), for administrators only.
 * </ul>
 */
@Component
public class ReportDefinitions {

    public record EngineBinding(
            UUID viewId,
            List<String> columns,
            List<BindingFilter> filters,
            List<String> groupBy,
            List<Aggregate> aggregates,
            List<Order> orderBy,
            Integer limit,
            Map<String, Object> params) {}

    /** {@code skipIfEmpty}: leave the filter out when its parameter is empty (Curf's "blank means no filter"). */
    public record BindingFilter(String column, FilterOp op, Object value, List<Object> values, Boolean skipIfEmpty) {}

    public record QueryDef(String id, String name, String dataSourceId, String sql, Integer previewLimit, EngineBinding engine) {}

    public record Parsed(String name, List<ReportParameter> parameters, List<QueryDef> queries, Set<String> drillOnly) {}

    private static final Pattern PARAM_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]{0,63}");
    private static final Set<String> UNSUPPORTED = Set.of("method", "path", "body", "jsonPath", "headers");
    private static final int MAX_QUERIES = 100;
    private static final int MAX_PARAMETERS = 100;
    private static final String PARAM_REF = "$param";

    private final JsonMapper json;

    public ReportDefinitions(JsonMapper json) {
        this.json = json;
    }

    public Parsed parse(JsonNode def) {
        List<FieldError> problems = new ArrayList<>();
        if (def == null || !def.isObject()) {
            throw invalid(List.of(new FieldError("definition", "must be a report definition object")));
        }
        if (!def.path("version").isNumber() || def.path("version").asInt() != 1) {
            problems.add(new FieldError("definition.version", "must be 1"));
        }
        String name = def.path("name").isString() ? def.path("name").asString().trim() : "";
        if (name.isEmpty() || name.length() > 200) {
            problems.add(new FieldError("definition.name", "must be 1 to 200 characters"));
        }

        List<ReportParameter> parameters = parameters(def.path("parameters"), problems);
        Set<String> declared = new LinkedHashSet<>();
        parameters.forEach(p -> declared.add(p.name()));

        List<QueryDef> queries = queries(def.path("dataSources"), declared, problems);
        Set<String> queryIds = new LinkedHashSet<>();
        queries.forEach(q -> queryIds.add(q.id()));

        JsonNode pages = def.path("pages");
        if (!pages.isArray() || pages.isEmpty()) {
            problems.add(new FieldError("definition.pages", "must be a list with at least one page"));
        } else {
            for (String ref : refs(pages)) {
                if (!queryIds.contains(ref)) {
                    problems.add(new FieldError("definition.pages", "refers to the unknown query '" + clip(ref) + "'"));
                }
            }
        }
        if (!problems.isEmpty()) {
            throw invalid(problems);
        }
        return new Parsed(name, parameters, queries, drillOnly(pages));
    }

    // ------------------------------------------------------------------ parameters

    private List<ReportParameter> parameters(JsonNode node, List<FieldError> problems) {
        List<ReportParameter> out = new ArrayList<>();
        if (node.isMissingNode() || node.isNull()) {
            return out;
        }
        if (!node.isArray() || node.size() > MAX_PARAMETERS) {
            problems.add(new FieldError("definition.parameters", "must be a list of at most " + MAX_PARAMETERS));
            return out;
        }
        Set<String> seen = new LinkedHashSet<>();
        for (int i = 0; i < node.size(); i++) {
            JsonNode p = node.get(i);
            String at = "definition.parameters[" + i + "]";
            String name = p.path("name").isString() ? p.path("name").asString() : "";
            if (!PARAM_NAME.matcher(name).matches() || name.startsWith("__")) {
                problems.add(new FieldError(at + ".name", "must be letters, digits and _, not starting with a digit or __"));
                continue;
            }
            if (!seen.add(name)) {
                problems.add(new FieldError(at + ".name", "is declared twice"));
                continue;
            }
            ReportParameter.Type type = type(p.path("type").asString(""));
            if (type == null) {
                problems.add(new FieldError(at + ".type", "must be string, number, date, dateRange, boolean or select"));
                continue;
            }
            Object fallback = null;
            JsonNode d = p.path("default");
            if (!d.isMissingNode() && !d.isNull()) {
                fallback = d.isString() ? d.asString() : d.isNumber() ? d.numberValue() : d.isBoolean() ? d.booleanValue() : null;
                if (fallback == null) {
                    problems.add(new FieldError(at + ".default", "must be text, a number or a boolean"));
                }
            }
            List<String> options = new ArrayList<>();
            for (JsonNode o : p.path("options")) {
                options.add(o.path("value").asString(""));
            }
            out.add(new ReportParameter(name, p.path("label").asString(name), type, p.path("required").asBoolean(false), fallback, options));
        }
        return out;
    }

    private static ReportParameter.Type type(String curf) {
        return switch (curf) {
            case "string" -> ReportParameter.Type.STRING;
            case "number" -> ReportParameter.Type.NUMBER;
            case "date" -> ReportParameter.Type.DATE;
            case "dateRange" -> ReportParameter.Type.DATE_RANGE;
            case "boolean" -> ReportParameter.Type.BOOLEAN;
            case "select" -> ReportParameter.Type.SELECT;
            default -> null;
        };
    }

    // ------------------------------------------------------------------ queries

    private List<QueryDef> queries(JsonNode node, Set<String> declared, List<FieldError> problems) {
        List<QueryDef> out = new ArrayList<>();
        if (node.isMissingNode() || node.isNull()) {
            return out;
        }
        if (!node.isArray() || node.size() > MAX_QUERIES) {
            problems.add(new FieldError("definition.dataSources", "must be a list of at most " + MAX_QUERIES));
            return out;
        }
        Set<String> ids = new LinkedHashSet<>();
        for (int i = 0; i < node.size(); i++) {
            JsonNode q = node.get(i);
            String at = "definition.dataSources[" + i + "]";
            String id = q.path("id").isString() ? q.path("id").asString() : "";
            if (id.isBlank() || id.length() > 100) {
                problems.add(new FieldError(at + ".id", "must be 1 to 100 characters"));
                continue;
            }
            if (!ids.add(id)) {
                problems.add(new FieldError(at + ".id", "is used twice"));
                continue;
            }
            String qname = q.path("name").isString() ? q.path("name").asString() : id;
            String source = q.path("dataSourceId").isString() ? q.path("dataSourceId").asString() : "";
            if (source.isBlank()) {
                problems.add(new FieldError(at + ".dataSourceId", "is required"));
            }
            for (String field : UNSUPPORTED) {
                if (!q.path(field).isMissingNode() && !q.path(field).isNull()) {
                    problems.add(new FieldError(at + "." + field, "REST queries are not supported by the engine"));
                }
            }
            if (q.path("joins").size() > 0 || q.path("attaches").size() > 0) {
                problems.add(new FieldError(at, "cross-source joins and attached sources are not supported by the engine yet"));
            }

            boolean hasSql = q.path("sql").isString();
            boolean hasEngine = q.path("engine").isObject();
            if (hasSql == hasEngine) {
                problems.add(new FieldError(at, "needs exactly one of sql (raw, administrators) or engine (a view)"));
                continue;
            }
            Integer previewLimit = q.path("previewLimit").isInt() ? q.path("previewLimit").asInt() : null;
            if (hasSql) {
                String sql = q.path("sql").asString();
                var verdict = SqlGuard.check(sql);
                if (!verdict.accepted() || sql.length() > 100_000) {
                    problems.add(new FieldError(at + ".sql", verdict.accepted() ? "is too long" : verdict.rejection()));
                    continue;
                }
                out.add(new QueryDef(id, qname, source, sql, previewLimit, null));
            } else {
                EngineBinding binding = binding(q.path("engine"), at + ".engine", declared, problems);
                if (binding != null) {
                    out.add(new QueryDef(id, qname, source, null, previewLimit, binding));
                }
            }
        }
        return out;
    }

    private EngineBinding binding(JsonNode node, String at, Set<String> declared, List<FieldError> problems) {
        EngineBinding binding;
        try {
            binding = json.treeToValue(node, EngineBinding.class);
        } catch (RuntimeException e) {
            problems.add(new FieldError(at, "is not a valid engine binding"));
            return null;
        }
        if (binding.viewId() == null) {
            problems.add(new FieldError(at + ".viewId", "is required"));
            return null;
        }
        // Every {"$param": name} must name a declared report parameter.
        for (String ref : paramRefs(node)) {
            if (!declared.contains(ref)) {
                problems.add(new FieldError(at, "uses the parameter '" + clip(ref) + "', which the report does not declare"));
            }
        }
        return binding;
    }

    private static Set<String> paramRefs(JsonNode node) {
        Set<String> out = new LinkedHashSet<>();
        if (node.isObject()) {
            if (node.size() == 1 && node.has(PARAM_REF) && node.get(PARAM_REF).isString()) {
                out.add(node.get(PARAM_REF).asString());
            } else {
                node.properties().forEach(e -> out.addAll(paramRefs(e.getValue())));
            }
        } else if (node.isArray()) {
            node.forEach(item -> out.addAll(paramRefs(item)));
        }
        return out;
    }

    // ------------------------------------------------------------------ which queries blocks use

    /** Every query a definition refers to: a string under a key named queryId or ending in QueryId, at any depth. */
    static Set<String> refs(JsonNode node) {
        Set<String> out = new LinkedHashSet<>();
        if (node.isObject()) {
            node.properties().forEach(e -> {
                String key = e.getKey();
                JsonNode value = e.getValue();
                if ((key.equals("queryId") || key.endsWith("QueryId")) && value.isString()) {
                    out.add(value.asString());
                }
                if (value.isObject() || value.isArray()) {
                    out.addAll(refs(value));
                }
            });
        } else if (node.isArray()) {
            node.forEach(item -> out.addAll(refs(item)));
        }
        return out;
    }

    /** Queries used only by a drill-down click are not run with the report (Curf runs them on click). */
    static Set<String> drillOnly(JsonNode pages) {
        Set<String> targets = new LinkedHashSet<>();
        JsonNode stripped = pages.deepCopy();
        for (JsonNode page : stripped) {
            for (JsonNode block : page.path("blocks")) {
                JsonNode config = block.path("config");
                if (config.isObject() && config.has("drilldown")) {
                    targets.addAll(refs(config.get("drilldown")));
                    ((ObjectNode) config).remove("drilldown");
                }
            }
        }
        Set<String> needed = refs(stripped);
        targets.removeAll(needed);
        return targets;
    }

    private static String clip(String text) {
        String cut = text.length() > 40 ? text.substring(0, 40) : text;
        return cut.replaceAll("[^\\p{L}\\p{N}_$ .-]", "?");
    }

    private static EngineException invalid(List<FieldError> problems) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "The report definition is not valid", problems);
    }
}
