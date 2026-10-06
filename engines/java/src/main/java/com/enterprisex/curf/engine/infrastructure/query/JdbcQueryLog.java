package com.enterprisex.curf.engine.infrastructure.query;

import com.enterprisex.curf.engine.application.query.QueryLog;
import java.sql.Timestamp;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class JdbcQueryLog implements QueryLog {

    private final JdbcClient jdbc;

    public JdbcQueryLog(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void record(Entry e) {
        jdbc.sql("""
                insert into engine_query_log
                  (id, tenant_id, occurred_at, subject, connection_id, view_id, view_version, sql_hash, params_hash,
                   row_count, duration_ms, cache_hit, outcome)
                values (:id, :t, :at, :subject, :conn, :view, :viewVersion, :sql, :params, :rows, :ms, :hit, :outcome)
                """)
                .param("id", UUID.randomUUID()).param("t", e.tenantId()).param("at", Timestamp.from(e.occurredAt()))
                .param("subject", e.subject()).param("conn", e.connectionId()).param("view", e.viewId())
                .param("viewVersion", e.viewVersion()).param("sql", e.sqlHash()).param("params", e.paramsHash())
                .param("rows", e.rowCount()).param("ms", e.durationMs()).param("hit", e.cacheHit()).param("outcome", e.outcome())
                .update();
    }
}
