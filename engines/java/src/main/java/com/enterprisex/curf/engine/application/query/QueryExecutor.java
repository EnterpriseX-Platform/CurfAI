package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.application.connection.ConnectionRepository.Stored;
import com.enterprisex.curf.engine.application.query.QueryBackend.RawResult;
import com.enterprisex.curf.engine.application.query.QueryResult.Provenance;
import com.enterprisex.curf.engine.application.secret.SecretCipher;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.query.QueryLimits;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * The common tail of every statement, raw or through a view: cache, concurrency limit, database,
 * provenance, log. Callers decide what to run; this decides how it runs.
 */
@Component
public class QueryExecutor {

    /**
     * @param sql the guard-approved statement with named parameters, for provenance
     * @param positional the same statement with positional parameters, for JDBC
     * @param params every bound value by name (including engine-generated ones), for provenance only
     * @param cacheKey full cache key; the caller makes sure it covers everything that shapes the result
     */
    record Plan(
            Stored stored, String sql, String positional, List<Object> bound, Map<String, Object> params,
            QueryLimits limits, String cacheKey, Duration maxAge, UUID viewId, Integer viewVersion) {}

    private final SecretCipher cipher;
    private final QueryBackend backend;
    private final ConcurrencyLimiter limiter;
    private final QueryCache cache;
    private final QueryLog log;
    private final QueryProperties props;
    private final Clock clock;

    public QueryExecutor(
            SecretCipher cipher, QueryBackend backend, ConcurrencyLimiter limiter, QueryCache cache, QueryLog log,
            QueryProperties props, Clock clock) {
        this.cipher = cipher;
        this.backend = backend;
        this.limiter = limiter;
        this.cache = cache;
        this.log = log;
        this.props = props;
        this.clock = clock;
    }

    /** @param rowCeiling the most rows this caller may get: the interactive ceiling, or the larger one exports use */
    QueryLimits limits(Integer limit, Integer timeoutMs, int rowCeiling) {
        int rows = limit == null ? rowCeiling : Math.min(Math.max(1, limit), rowCeiling);
        Duration timeout = timeoutMs == null
                ? props.defaultTimeout()
                : Duration.ofMillis(Math.min(Math.max(100, timeoutMs), props.maxTimeout().toMillis()));
        return new QueryLimits(rows, timeout, props.maxBytes());
    }

    Duration maxAge(Integer requested, Integer fallbackSeconds) {
        int seconds = requested != null ? requested : (fallbackSeconds == null ? 0 : fallbackSeconds);
        return Duration.ofSeconds(Math.min(Math.max(0, seconds), props.maxCacheAgeSeconds()));
    }

    QueryResult run(Viewer viewer, Plan plan) {
        Connection connection = plan.stored().connection();
        String sqlHash = Fingerprints.sha256(plan.sql());

        if (!plan.maxAge().isZero()) {
            Optional<QueryResult> hit = cache.get(plan.cacheKey(), plan.maxAge());
            if (hit.isPresent()) {
                QueryResult result = hit.get().asCacheHit();
                record(viewer, plan, sqlHash, result.rowCount(), 0, true, "ok");
                return result;
            }
        }

        long started = System.nanoTime();
        try (var permit = limiter.acquire(viewer.tenantId() + ":" + viewer.subject())) {
            RawResult raw = backend.execute(
                    connection, cipher.decrypt(plan.stored().secret()), plan.positional(), plan.bound(), plan.limits());
            long ms = (System.nanoTime() - started) / 1_000_000;
            QueryResult result = new QueryResult(
                    raw.columns(), raw.rows(), raw.rows().size(), raw.truncated(), ms, Instant.now(clock), "miss",
                    new Provenance(
                            Fingerprints.provenance(plan.sql(), plan.params(), raw),
                            Fingerprints.sha256(connection.fingerprintSource()), plan.viewVersion()));
            if (!plan.maxAge().isZero()) {
                cache.put(plan.cacheKey(), result);
            }
            record(viewer, plan, sqlHash, result.rowCount(), ms, false, "ok");
            return result;
        } catch (EngineException e) {
            record(viewer, plan, sqlHash, null, (System.nanoTime() - started) / 1_000_000, false, e.code().name());
            throw e;
        }
    }

    /** For statements refused before they could run. */
    void logRefused(Viewer viewer, Connection connection, UUID viewId, Integer viewVersion, String sql, Map<String, Object> params) {
        log.record(new QueryLog.Entry(viewer.tenantId(), clock.instant(), viewer.subject(), connection.id(), viewId, viewVersion,
                Fingerprints.sha256(sql == null ? "" : sql), Fingerprints.sha256(Fingerprints.canonical(params)), null, 0, false, "rejected"));
    }

    private void record(Viewer viewer, Plan plan, String sqlHash, Integer rows, long ms, boolean hit, String outcome) {
        log.record(new QueryLog.Entry(viewer.tenantId(), clock.instant(), viewer.subject(), plan.stored().connection().id(),
                plan.viewId(), plan.viewVersion(), sqlHash, Fingerprints.sha256(Fingerprints.canonical(plan.params())),
                rows, ms, hit, outcome));
    }
}
