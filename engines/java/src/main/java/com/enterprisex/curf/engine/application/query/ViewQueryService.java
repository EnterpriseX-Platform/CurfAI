package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.application.connection.ConnectionRepository;
import com.enterprisex.curf.engine.application.connection.ConnectionRepository.Stored;
import com.enterprisex.curf.engine.application.view.AttributeResolver;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.QueryComposer;
import com.enterprisex.curf.engine.domain.query.QueryComposer.Composed;
import com.enterprisex.curf.engine.domain.query.QueryLimits;
import com.enterprisex.curf.engine.domain.query.SqlGuard;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewPolicy;
import com.enterprisex.curf.engine.domain.view.ViewPolicy.Access;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

/**
 * Runs a request against a view as one viewer: resolve what they may see, compose the two-level
 * statement, check the composed text with the SQL guard again, bind values, run.
 */
@Service
public class ViewQueryService {

    private final ConnectionRepository connections;
    private final AttributeResolver attributes;
    private final QueryExecutor executor;

    public ViewQueryService(ConnectionRepository connections, AttributeResolver attributes, QueryExecutor executor) {
        this.connections = connections;
        this.attributes = attributes;
        this.executor = executor;
    }

    /** @param rowCeiling most rows this call may return, before the engine-wide ceiling applies */
    public QueryResult run(Viewer viewer, View view, QueryRequest request, int rowCeiling) {
        Stored stored = connections.find(view.tenantId(), view.connectionId())
                .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such view"));
        Connection connection = stored.connection();

        NamedSql.checkCallerParams(request.params());
        Access access = ViewPolicy.resolve(view, viewer, attribute -> attributes.values(viewer, attribute));
        QueryLimits limits = executor.limits(request.limit(), request.timeoutMs(), rowCeiling);
        Composed composed = QueryComposer.compose(view, access, request.structured(), connection.kind(), limits.maxRows() + 1);

        var verdict = SqlGuard.check(composed.sql());
        Map<String, Object> all = new LinkedHashMap<>(request.params());
        all.putAll(composed.params());
        if (!verdict.accepted()) {
            executor.logRefused(viewer, connection, view.id(), view.version(), composed.sql(), all);
            throw new EngineException(ErrorCode.CURF_SQL_REJECTED, "The view's statement could not be run as written",
                    List.of(new FieldError("view", verdict.rejection())));
        }

        NamedSql.Bound bound = NamedSql.bind(verdict.sql(), all);
        // Everything that shapes the answer is in the statement and its values, including the row rules and
        // masks, so viewers share a cached answer exactly when their policy outcome is identical.
        String cacheKey = Fingerprints.sha256(String.join("|", view.tenantId(), connection.id().toString(),
                String.valueOf(connection.version()), verdict.sql(), Fingerprints.canonical(all), String.valueOf(limits.maxRows())));
        Duration maxAge = executor.maxAge(request.maxAgeSeconds(), view.refreshSeconds());

        return executor.run(viewer, new QueryExecutor.Plan(
                stored, verdict.sql(), bound.sql(), bound.values(), all, limits, cacheKey, maxAge, view.id(), view.version()));
    }
}
