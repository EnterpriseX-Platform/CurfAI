package com.enterprisex.curf.engine.application.report;

import com.enterprisex.curf.engine.application.connection.ConnectionRepository;
import com.enterprisex.curf.engine.application.connection.ConnectionRepository.Stored;
import com.enterprisex.curf.engine.application.query.QueryProperties;
import com.enterprisex.curf.engine.application.query.QueryRequest;
import com.enterprisex.curf.engine.application.query.QueryResult;
import com.enterprisex.curf.engine.application.query.QueryService;
import com.enterprisex.curf.engine.application.query.ViewQueryService;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.BindingFilter;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.EngineBinding;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.Parsed;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.QueryDef;
import com.enterprisex.curf.engine.application.sharing.ReportAccessService;
import com.enterprisex.curf.engine.application.view.ViewRepository;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Filter;
import com.enterprisex.curf.engine.domain.report.ReportAccess.Level;
import com.enterprisex.curf.engine.domain.report.ReportParams;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewPolicy;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import tools.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Runs a report as the person asking: every query executes under their policy, so row rules and masking
 * apply to them. Follows Curf's runner: all declared parameters are bound (defaults applied), queries only
 * a drill-down uses are skipped, and one query failing leaves an empty dataset and an error in its
 * provenance while the rest of the report still runs.
 */
@Service
public class ReportRunService {

    private static final Logger LOG = LoggerFactory.getLogger(ReportRunService.class);
    private static final DateTimeFormatter ISO_MILLIS = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);
    private static final int MAX_ERROR = 500;
    private static final String PARAM_REF = "$param";

    private final ReportRepository reports;
    private final ReportAccessService access;
    private final ReportDefinitions definitions;
    private final ViewRepository views;
    private final ConnectionRepository connections;
    private final ViewQueryService viewQueries;
    private final QueryService queryService;
    private final QueryProperties props;
    private final Clock clock;

    public ReportRunService(
            ReportRepository reports, ReportAccessService access, ReportDefinitions definitions, ViewRepository views,
            ConnectionRepository connections, ViewQueryService viewQueries, QueryService queryService, QueryProperties props,
            Clock clock) {
        this.reports = reports;
        this.access = access;
        this.definitions = definitions;
        this.views = views;
        this.connections = connections;
        this.viewQueries = viewQueries;
        this.queryService = queryService;
        this.props = props;
        this.clock = clock;
    }

    public RunResult run(Viewer viewer, UUID reportId, Map<String, Object> supplied) {
        return run(viewer, reportId, supplied, props.maxRows());
    }

    /** What a run uses: the report, and the definition and version the person is allowed to see. */
    public record Resolved(Report report, JsonNode definition, int version) {}

    /**
     * Editors run the working copy; everyone else runs the published version, and a report that was never published
     * (or was unpublished) is simply not there for them.
     */
    public Resolved resolve(Viewer viewer, UUID reportId) {
        Report report = reports.find(viewer.tenantId(), reportId)
                .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report"));
        Level level = access.level(viewer, report);
        if (level == Level.NONE) {
            throw new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report");
        }
        if (level == Level.EDIT) {
            return new Resolved(report, report.definition(), report.version());
        }
        return published(report);
    }

    /** The published version of a report, whoever asks. */
    public Resolved published(Report report) {
        Integer v = report.publishedVersion();
        if (v == null) {
            throw new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report");
        }
        JsonNode definition = v == report.version() ? report.definition()
                : reports.versionDefinition(report.tenantId(), report.id(), v)
                        .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report"));
        return new Resolved(report, definition, v);
    }

    /** @param rowCeiling most rows any one query may return: the interactive ceiling, or the larger one exports use */
    public RunResult run(Viewer viewer, UUID reportId, Map<String, Object> supplied, int rowCeiling) {
        return execute(viewer, resolve(viewer, reportId), supplied, rowCeiling);
    }

    public RunResult execute(Viewer viewer, Resolved resolved, Map<String, Object> supplied, int rowCeiling) {
        Parsed parsed = definitions.parse(resolved.definition());
        Map<String, Object> params = ReportParams.resolve(parsed.parameters(), supplied == null ? Map.of() : supplied);

        Map<String, List<Map<String, Object>>> dataset = new LinkedHashMap<>();
        Map<String, ProvenanceRecord> provenance = new LinkedHashMap<>();
        for (QueryDef query : parsed.queries()) {
            if (parsed.drillOnly().contains(query.id())) {
                continue;
            }
            Outcome outcome = runQuery(viewer, query, params, rowCeiling);
            dataset.put(query.id(), outcome.rows());
            provenance.put(query.id(), outcome.provenance());
        }
        return new RunResult(dataset, provenance, params, resolved.version(), ISO_MILLIS.format(clock.instant()));
    }

    // ------------------------------------------------------------------ one query

    private record Outcome(List<Map<String, Object>> rows, ProvenanceRecord provenance) {}

    private record Source(String name, String kind) {}

    private Outcome runQuery(Viewer viewer, QueryDef q, Map<String, Object> params, int rowCeiling) {
        Instant startedAt = clock.instant();
        long started = System.nanoTime();
        Source source = new Source(q.dataSourceId(), "");
        String queryHash = CurfHashes.text(q.id());
        List<Map<String, Object>> rows = List.of();
        boolean truncated = false;
        String denied = null;
        String error = null;

        try {
            if (q.engine() != null) {
                View view = views.findPublished(viewer.tenantId(), q.engine().viewId())
                        .filter(v -> ViewPolicy.mayQuery(v, viewer))
                        .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "You do not have access to this data source"));
                source = describe(viewer, view.name(), view.connectionId());
                QueryRequest request = request(q.engine(), params);
                queryHash = CurfHashes.text(JsJson.stringify(canonical(q.engine(), request)));
                QueryResult result = viewQueries.run(viewer, view, request, rowCeiling);
                rows = rows(result);
                truncated = result.truncated();
            } else {
                UUID connectionId = connectionId(q.dataSourceId());
                source = describe(viewer, null, connectionId);
                queryHash = CurfHashes.queryDefinition(q.sql(), params);
                QueryResult result = queryService.execute(viewer, QueryRequest.raw(connectionId, q.sql(), params), rowCeiling);
                rows = rows(result);
                truncated = result.truncated();
            }
        } catch (EngineException e) {
            if (e.code() == ErrorCode.CURF_FORBIDDEN || e.code() == ErrorCode.CURF_NOT_FOUND || e.code() == ErrorCode.CURF_UNAUTHENTICATED) {
                denied = e.getMessage();
            } else {
                error = clip(message(e));
            }
        } catch (RuntimeException e) {
            LOG.error("Report query {} failed", q.id(), e);
            error = "The query failed unexpectedly";
        }

        ProvenanceRecord record = new ProvenanceRecord(
                q.id(), q.name(), queryHash, ISO_MILLIS.format(startedAt), (System.nanoTime() - started) / 1_000_000, rows.size(),
                CurfHashes.rows(rows), source.name(), source.kind(), denied, error, truncated ? Boolean.TRUE : null);
        return new Outcome(rows, record);
    }

    /** The data source's name and Curf-style kind, when the viewer's tenant has it. */
    private Source describe(Viewer viewer, String viewName, UUID connectionId) {
        Stored stored = connections.find(viewer.tenantId(), connectionId).orElse(null);
        if (stored == null) {
            return new Source(viewName == null ? connectionId.toString() : viewName, "");
        }
        Connection c = stored.connection();
        String kind = switch (c.kind()) {
            case POSTGRESQL -> "postgres";
            case MYSQL, MARIADB -> "mysql";
            case ORACLE -> "oracle";
            case SQLSERVER -> "mssql";
            case TRINO -> "trino";
        };
        return new Source(viewName != null ? viewName : c.name(), kind);
    }

    private static UUID connectionId(String dataSourceId) {
        try {
            return UUID.fromString(dataSourceId);
        } catch (IllegalArgumentException e) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "dataSourceId must be an engine connection id for a raw query");
        }
    }

    // ------------------------------------------------------------------ binding parameters into a view request

    private QueryRequest request(EngineBinding b, Map<String, Object> params) {
        List<Filter> filters = new ArrayList<>();
        for (BindingFilter f : b.filters() == null ? List.<BindingFilter>of() : b.filters()) {
            Object value = resolve(f.value(), params);
            List<Object> values = f.values() == null ? null : f.values().stream().map(v -> resolve(v, params)).toList();
            if (Boolean.TRUE.equals(f.skipIfEmpty())) {
                if (values != null) {
                    values = values.stream().filter(v -> !empty(v)).toList();
                    if (values.isEmpty()) {
                        continue;
                    }
                } else if (empty(value) && f.value() != null) {
                    continue;
                }
            }
            filters.add(new Filter(f.column(), f.op(), value, values));
        }
        Map<String, Object> viewParams = new LinkedHashMap<>();
        if (b.params() != null) {
            b.params().forEach((name, v) -> viewParams.put(name, resolve(v, params)));
        }
        return new QueryRequest(b.viewId(), null, null, viewParams, b.columns(), filters, b.groupBy(), b.aggregates(), b.orderBy(),
                b.limit(), null, null);
    }

    /** {@code {"$param": "name"}} becomes that parameter's value; anything else is a literal. */
    private static Object resolve(Object value, Map<String, Object> params) {
        if (value instanceof Map<?, ?> map && map.size() == 1 && map.containsKey(PARAM_REF)) {
            return params.get(String.valueOf(map.get(PARAM_REF)));
        }
        return value;
    }

    private static boolean empty(Object value) {
        return value == null || "".equals(value);
    }

    private static Map<String, Object> canonical(EngineBinding binding, QueryRequest resolved) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("viewId", binding.viewId().toString());
        m.put("columns", resolved.columns());
        m.put("filters", resolved.filters() == null ? List.of() : resolved.filters().stream().map(f -> {
            Map<String, Object> fm = new LinkedHashMap<>();
            fm.put("column", f.column());
            fm.put("op", f.op().name());
            fm.put("value", f.value());
            fm.put("values", f.values());
            return fm;
        }).toList());
        m.put("groupBy", resolved.groupBy());
        m.put("params", resolved.params());
        m.put("limit", resolved.limit());
        return m;
    }

    // ------------------------------------------------------------------ results

    private static List<Map<String, Object>> rows(QueryResult result) {
        List<String> names = result.columns().stream().map(c -> c.name()).toList();
        List<Map<String, Object>> rows = new ArrayList<>(result.rows().size());
        for (List<Object> values : result.rows()) {
            Map<String, Object> row = new LinkedHashMap<>();
            for (int i = 0; i < names.size(); i++) {
                row.put(names.get(i), values.get(i));
            }
            rows.add(row);
        }
        return rows;
    }

    private static String message(EngineException e) {
        if (e.errors().isEmpty()) {
            return e.getMessage();
        }
        StringBuilder sb = new StringBuilder(e.getMessage());
        e.errors().forEach(f -> sb.append(": ").append(f.field()).append(" ").append(f.message()));
        return sb.toString();
    }

    private static String clip(String text) {
        return text.length() > MAX_ERROR ? text.substring(0, MAX_ERROR) : text;
    }
}
