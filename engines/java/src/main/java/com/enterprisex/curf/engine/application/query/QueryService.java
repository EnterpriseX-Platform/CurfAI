package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.application.connection.ConnectionRepository;
import com.enterprisex.curf.engine.application.connection.ConnectionRepository.Stored;
import com.enterprisex.curf.engine.application.view.ViewRepository;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.QueryLimits;
import com.enterprisex.curf.engine.domain.query.SqlGuard;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewPolicy;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Duration;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * Entry point for running a request. A view request is open to anyone the view allows and always sees
 * the published snapshot through the policy. Raw SQL is the restricted lane for administrators.
 */
@Service
public class QueryService {

    private final ConnectionRepository connections;
    private final ViewRepository views;
    private final ViewQueryService viewQueries;
    private final QueryExecutor executor;
    private final QueryProperties props;

    public QueryService(
            ConnectionRepository connections, ViewRepository views, ViewQueryService viewQueries, QueryExecutor executor,
            QueryProperties props) {
        this.connections = connections;
        this.views = views;
        this.viewQueries = viewQueries;
        this.executor = executor;
        this.props = props;
    }

    public QueryResult execute(Viewer viewer, QueryRequest request) {
        return execute(viewer, request, props.maxRows());
    }

    /** @param rowCeiling most rows to return: the interactive ceiling, or the larger one exports use */
    public QueryResult execute(Viewer viewer, QueryRequest request, int rowCeiling) {
        if (request.viewId() != null) {
            if (request.connectionId() != null || request.sql() != null) {
                throw invalid("viewId", "cannot be combined with connectionId or sql");
            }
            // Unknown, unpublished and not-allowed all look the same, so views cannot be discovered.
            View view = views.findPublished(viewer.tenantId(), request.viewId())
                    .filter(v -> ViewPolicy.mayQuery(v, viewer))
                    .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such view"));
            return viewQueries.run(viewer, view, request, rowCeiling);
        }
        return raw(viewer, request, rowCeiling);
    }

    private QueryResult raw(Viewer viewer, QueryRequest request, int rowCeiling) {
        if (!viewer.can(Permission.VIEW_MANAGE)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Running raw SQL requires the view:manage permission");
        }
        if (request.connectionId() == null) {
            throw invalid("connectionId", "is required (or give a viewId)");
        }
        Stored stored = connections.find(viewer.tenantId(), request.connectionId())
                .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such connection"));
        Connection connection = stored.connection();
        if (!connection.allowRawSql()) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Raw SQL is disabled on this connection");
        }

        var verdict = SqlGuard.check(request.sql());
        if (!verdict.accepted()) {
            executor.logRefused(viewer, connection, null, null, request.sql(), request.params());
            throw new EngineException(ErrorCode.CURF_SQL_REJECTED, "The statement was rejected",
                    List.of(new FieldError("sql", verdict.rejection())));
        }

        NamedSql.checkCallerParams(request.params());
        NamedSql.Bound bound = NamedSql.bind(verdict.sql(), request.params());
        QueryLimits limits = executor.limits(request.limit(), request.timeoutMs(), rowCeiling);
        String cacheKey = Fingerprints.sha256(String.join("|",
                viewer.tenantId(), connection.id().toString(), String.valueOf(connection.version()), verdict.sql(),
                Fingerprints.canonical(request.params()), String.valueOf(limits.maxRows()), Fingerprints.viewerScope(viewer)));
        Duration maxAge = executor.maxAge(request.maxAgeSeconds(), null);

        return executor.run(viewer, new QueryExecutor.Plan(
                stored, verdict.sql(), bound.sql(), bound.values(), request.params(), limits, cacheKey, maxAge, null, null));
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }
}
