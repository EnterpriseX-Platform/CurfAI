package com.enterprisex.curf.engine.application.view;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.connection.ConnectionRepository;
import com.enterprisex.curf.engine.application.connection.ConnectionRepository.Stored;
import com.enterprisex.curf.engine.application.query.QueryBackend;
import com.enterprisex.curf.engine.application.query.NamedSql;
import com.enterprisex.curf.engine.application.query.QueryBackend.Column;
import com.enterprisex.curf.engine.application.query.QueryRequest;
import com.enterprisex.curf.engine.application.query.QueryResult;
import com.enterprisex.curf.engine.application.query.ViewQueryService;
import com.enterprisex.curf.engine.application.secret.SecretCipher;
import com.enterprisex.curf.engine.application.view.ViewRepository.VersionInfo;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.Dialects;
import com.enterprisex.curf.engine.domain.query.PiiHeuristics;
import com.enterprisex.curf.engine.domain.query.QueryComposer;
import com.enterprisex.curf.engine.domain.query.QueryLimits;
import com.enterprisex.curf.engine.domain.query.SqlGuard;
import com.enterprisex.curf.engine.domain.view.PiiMode;
import com.enterprisex.curf.engine.domain.view.PublicExposure;
import com.enterprisex.curf.engine.domain.view.RlsRule;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewColumn;
import com.enterprisex.curf.engine.domain.view.ViewPolicy;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Defines and publishes views. Creating or changing a view reads its columns from the database (so what
 * is declared is what exists), then checks every rule against those columns. Viewers only ever query the
 * published snapshot; edits do not reach them until the view is published again.
 */
@Service
public class ViewService {

    private static final Pattern ROLE = Pattern.compile("[A-Za-z0-9_.:-]{1,100}");
    private static final Pattern ATTRIBUTE = Pattern.compile("[A-Za-z][A-Za-z0-9_]{0,63}");
    private static final int PREVIEW_ROWS = 1000;

    private final ViewRepository views;
    private final ConnectionRepository connections;
    private final SecretCipher cipher;
    private final QueryBackend backend;
    private final ViewQueryService viewQueries;
    private final AuditService audit;
    private final Clock clock;

    public ViewService(
            ViewRepository views, ConnectionRepository connections, SecretCipher cipher, QueryBackend backend,
            ViewQueryService viewQueries, AuditService audit, Clock clock) {
        this.views = views;
        this.connections = connections;
        this.cipher = cipher;
        this.backend = backend;
        this.viewQueries = viewQueries;
        this.audit = audit;
        this.clock = clock;
    }

    public View create(Viewer viewer, ViewDraft draft) {
        requireManage(viewer);
        Stored stored = connection(viewer, draft.connectionId());
        if (views.nameTaken(viewer.tenantId(), safe(draft.name()), null)) {
            throw invalid("name", "A view with this name already exists");
        }
        Instant now = clock.instant();
        View view = build(viewer, draft, stored, UUID.randomUUID(), 1, null, now, viewer.subject(), now, viewer.subject());
        views.insert(view);
        audit.record(viewer, "view.create", "view", view.id().toString(), details(view));
        return view;
    }

    public View update(Viewer viewer, UUID id, ViewDraft draft, int expectedVersion) {
        requireManage(viewer);
        View old = views.find(viewer.tenantId(), id).orElseThrow(ViewService::notFound);
        Stored stored = connection(viewer, draft.connectionId());
        if (views.nameTaken(viewer.tenantId(), safe(draft.name()), id)) {
            throw invalid("name", "A view with this name already exists");
        }
        View changed = build(viewer, draft, stored, id, old.version() + 1, old.publishedVersion(), old.createdAt(),
                old.createdBy(), clock.instant(), viewer.subject());
        if (!views.update(changed, expectedVersion)) {
            throw new EngineException(ErrorCode.CURF_STALE_VERSION, "The view was changed by someone else; reload it and try again");
        }
        audit.record(viewer, "view.update", "view", id.toString(), details(changed));
        return changed;
    }

    public void delete(Viewer viewer, UUID id) {
        requireManage(viewer);
        if (!views.delete(viewer.tenantId(), id)) {
            throw notFound();
        }
        audit.record(viewer, "view.delete", "view", id.toString(), Map.of());
    }

    public View get(Viewer viewer, UUID id) {
        requireManage(viewer);
        return views.find(viewer.tenantId(), id).orElseThrow(ViewService::notFound);
    }

    public PageResult<View> list(Viewer viewer, int page, int size) {
        requireManage(viewer);
        if (page < 0 || size < 1 || size > 200) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "page must be >= 0 and size between 1 and 200");
        }
        return views.list(viewer.tenantId(), page, size);
    }

    /** The published views this viewer may query, described as they would see them. */
    public List<ViewSummary> catalogue(Viewer viewer) {
        return views.listPublished(viewer.tenantId()).stream()
                .filter(v -> ViewPolicy.mayQuery(v, viewer))
                .map(v -> summary(v, viewer))
                .toList();
    }

    public ViewSummary summaryOf(Viewer viewer, UUID id) {
        return views.findPublished(viewer.tenantId(), id)
                .filter(v -> ViewPolicy.mayQuery(v, viewer))
                .map(v -> summary(v, viewer))
                .orElseThrow(ViewService::notFound);
    }

    public View publish(Viewer viewer, UUID id) {
        requireManage(viewer);
        View working = views.find(viewer.tenantId(), id).orElseThrow(ViewService::notFound);
        if (PublicExposure.offeredToPublic(working)) {
            List<FieldError> exposure = PublicExposure.problems(working).stream().map(p -> new FieldError("allowedRoles", "public: " + p)).toList();
            if (!exposure.isEmpty()) {
                throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "The view cannot be offered to the public", exposure);
            }
        }
        View snapshot = new View(working.id(), working.tenantId(), working.name(), working.description(), working.connectionId(),
                working.sql(), working.columns(), working.allowedRoles(), working.piiRoles(), working.bypassRoles(),
                working.rlsRules(), working.refreshSeconds(), working.version(), working.version(), working.createdAt(),
                working.createdBy(), working.updatedAt(), working.updatedBy());
        views.publish(viewer.tenantId(), id, snapshot, viewer.subject(), clock.instant());
        audit.record(viewer, "view.publish", "view", id.toString(), Map.of("version", working.version()));
        return snapshot;
    }

    public void unpublish(Viewer viewer, UUID id) {
        requireManage(viewer);
        if (!views.unpublish(viewer.tenantId(), id)) {
            throw notFound();
        }
        audit.record(viewer, "view.unpublish", "view", id.toString(), Map.of());
    }

    public List<VersionInfo> versions(Viewer viewer, UUID id) {
        requireManage(viewer);
        views.find(viewer.tenantId(), id).orElseThrow(ViewService::notFound);
        return views.versions(viewer.tenantId(), id);
    }

    /** Runs the working copy as the caller, so an author sees what their own policy lets through. */
    public QueryResult preview(Viewer viewer, UUID id, QueryRequest request) {
        requireManage(viewer);
        View working = views.find(viewer.tenantId(), id).orElseThrow(ViewService::notFound);
        return viewQueries.run(viewer, working, request, PREVIEW_ROWS);
    }

    // ------------------------------------------------------------------ building a view

    private View build(Viewer viewer, ViewDraft d, Stored stored, UUID id, int version, Integer publishedVersion,
            Instant createdAt, String createdBy, Instant updatedAt, String updatedBy) {
        List<FieldError> problems = new ArrayList<>();
        String name = safe(d.name());
        if (name.isBlank() || name.length() > 100) {
            problems.add(new FieldError("name", "must be 1 to 100 characters"));
        }
        fail(problems);

        var verdict = SqlGuard.check(d.sql());
        if (!verdict.accepted()) {
            throw new EngineException(ErrorCode.CURF_SQL_REJECTED, "The statement was rejected",
                    List.of(new FieldError("sql", verdict.rejection())));
        }

        List<Column> actual = readColumns(stored, verdict.sql(), d.sampleParams());
        List<ViewColumn> columns = columns(d, actual, problems);

        Set<String> allowed = roles("allowedRoles", d.allowedRoles(), problems);
        Set<String> pii = roles("piiRoles", d.piiRoles(), problems);
        Set<String> bypass = roles("bypassRoles", d.bypassRoles(), problems);
        List<RlsRule> rules = d.rlsRules() == null ? List.of() : d.rlsRules();
        for (int i = 0; i < rules.size(); i++) {
            RlsRule r = rules.get(i);
            if (r == null || r.column() == null || columns.stream().noneMatch(c -> c.name().equals(r.column()))) {
                problems.add(new FieldError("rlsRules[" + i + "].column", "must be one of the view's columns"));
            }
            if (r == null || r.attribute() == null || !ATTRIBUTE.matcher(r.attribute()).matches()) {
                problems.add(new FieldError("rlsRules[" + i + "].attribute", "must be a plain attribute name"));
            }
            if (r == null || r.operator() == null) {
                problems.add(new FieldError("rlsRules[" + i + "].operator", "is required (EQ or IN)"));
            }
        }
        if (d.refreshSeconds() != null && (d.refreshSeconds() < 0 || d.refreshSeconds() > 86_400)) {
            problems.add(new FieldError("refreshSeconds", "must be between 0 and 86400"));
        }
        fail(problems);

        return new View(id, viewer.tenantId(), name, d.description(), stored.connection().id(), verdict.sql(), columns,
                allowed, pii, bypass, rules, d.refreshSeconds(), version, publishedVersion, createdAt, createdBy,
                updatedAt, updatedBy);
    }

    /** Runs the statement for zero rows to learn its real columns and types. */
    private List<Column> readColumns(Stored stored, String sql, Map<String, Object> sampleParams) {
        Map<String, Object> params = sampleParams == null ? Map.of() : sampleParams;
        String probe = "SELECT * FROM (" + sql + ")" + Dialects.tableAlias(stored.connection().kind(), "v") + " WHERE 1 = 0";
        var wrapped = SqlGuard.check(probe);
        if (!wrapped.accepted()) {
            throw new EngineException(ErrorCode.CURF_SQL_REJECTED, "The statement cannot be used as a view",
                    List.of(new FieldError("sql", wrapped.rejection())));
        }
        NamedSql.checkCallerParams(params);
        NamedSql.Bound bound;
        try {
            bound = NamedSql.bind(wrapped.sql(), params);
        } catch (EngineException e) {
            // Named parameters need sample values for their columns to be checked at all.
            throw invalid("sampleParams", "this statement uses :name parameters; give a sample value for each so its columns can be checked");
        }
        var raw = backend.execute(stored.connection(), cipher.decrypt(stored.secret()), bound.sql(), bound.values(),
                new QueryLimits(1, Duration.ofSeconds(15), 1_000_000));
        return raw.columns();
    }

    private static List<ViewColumn> columns(ViewDraft d, List<Column> actual, List<FieldError> problems) {
        Map<String, ViewDraft.ColumnDraft> overrides = new LinkedHashMap<>();
        if (d.columns() != null) {
            for (ViewDraft.ColumnDraft c : d.columns()) {
                if (c == null || c.name() == null) {
                    problems.add(new FieldError("columns", "every entry needs a name"));
                } else if (overrides.put(c.name(), c) != null) {
                    problems.add(new FieldError("columns", "duplicate column " + c.name()));
                }
            }
        }
        List<ViewColumn> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Column column : actual) {
            if (!QueryComposer.validName(column.name())) {
                problems.add(new FieldError("sql", "column '" + column.name() + "' needs a plain alias (letters, digits, _)"));
                continue;
            }
            if (!seen.add(column.name())) {
                problems.add(new FieldError("sql", "column '" + column.name() + "' appears twice"));
                continue;
            }
            ViewDraft.ColumnDraft o = overrides.remove(column.name());
            PiiMode pii = o != null && o.pii() != null ? o.pii() : defaultPii(column.name());
            out.add(new ViewColumn(column.name(), column.type(), o == null ? null : o.label(), o == null ? null : o.description(), pii));
        }
        overrides.keySet().forEach(n -> problems.add(new FieldError("columns", "the statement has no column named " + n)));
        return out;
    }

    /** Secure by default: what looks like personal data starts out masked or hidden until someone decides otherwise. */
    private static PiiMode defaultPii(String column) {
        return switch (PiiHeuristics.suggest(column)) {
            case HIDE -> PiiMode.HIDE;
            case MASK -> PiiMode.MASK;
            case NONE -> PiiMode.NONE;
        };
    }

    private static Set<String> roles(String field, Set<String> roles, List<FieldError> problems) {
        Set<String> out = new HashSet<>();
        if (roles != null) {
            for (String role : roles) {
                if (role == null || !ROLE.matcher(role).matches()) {
                    problems.add(new FieldError(field, "role names may use letters, digits and _ . : -"));
                } else {
                    out.add(role);
                }
            }
        }
        return out;
    }

    private ViewSummary summary(View view, Viewer viewer) {
        var access = ViewPolicy.resolve(view, viewer, attribute -> Set.of());
        return new ViewSummary(view.id(), view.name(), view.description(), view.version(), view.refreshSeconds(),
                access.columns().stream()
                        .map(c -> new ViewSummary.Column(c.column().name(), c.column().label(), c.column().description(),
                                c.column().type(), c.masked()))
                        .toList());
    }

    private Stored connection(Viewer viewer, UUID id) {
        if (id == null) {
            throw invalid("connectionId", "is required");
        }
        return connections.find(viewer.tenantId(), id)
                .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such connection"));
    }

    private static Map<String, Object> details(View v) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", v.name());
        m.put("connectionId", v.connectionId().toString());
        m.put("version", v.version());
        m.put("columns", v.columns().size());
        m.put("rlsRules", v.rlsRules().size());
        m.put("piiColumns", v.columns().stream().filter(c -> c.pii() != PiiMode.NONE).count());
        return m;
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static void requireManage(Viewer viewer) {
        if (!viewer.can(Permission.VIEW_MANAGE)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Managing views requires the view:manage permission");
        }
    }

    private static EngineException notFound() {
        return new EngineException(ErrorCode.CURF_NOT_FOUND, "No such view");
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }

    private static void fail(List<FieldError> problems) {
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", problems);
        }
    }
}
