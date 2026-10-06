package com.enterprisex.curf.engine.infrastructure.audit;

import com.enterprisex.curf.engine.application.audit.AuditEvent;
import com.enterprisex.curf.engine.application.audit.AuditFilter;
import com.enterprisex.curf.engine.application.audit.AuditLog;
import com.enterprisex.curf.engine.application.common.PageResult;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class JdbcAuditLog implements AuditLog {

    private final JdbcClient jdbc;

    public JdbcAuditLog(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void append(AuditEvent e) {
        jdbc.sql("""
                insert into engine_audit_event
                  (id, tenant_id, occurred_at, actor, action, entity_type, entity_id, details)
                values (:id, :tenant, :at, :actor, :action, :entityType, :entityId, cast(:details as jsonb))
                """)
                .param("id", e.id())
                .param("tenant", e.tenantId())
                .param("at", Timestamp.from(e.occurredAt()))
                .param("actor", e.actor())
                .param("action", e.action())
                .param("entityType", e.entityType())
                .param("entityId", e.entityId())
                .param("details", e.details())
                .update();
    }

    @Override
    public PageResult<AuditEvent> find(String tenantId, AuditFilter f, int page, int size) {
        StringBuilder where = new StringBuilder(" where tenant_id = :tenant");
        List<Object[]> params = new ArrayList<>();
        add(where, params, "actor", f.actor(), "actor = :actor");
        add(where, params, "action", f.action(), "action = :action");
        add(where, params, "entityType", f.entityType(), "entity_type = :entityType");
        add(where, params, "entityId", f.entityId(), "entity_id = :entityId");
        add(where, params, "from", f.from() == null ? null : Timestamp.from(f.from()), "occurred_at >= :from");
        add(where, params, "to", f.to() == null ? null : Timestamp.from(f.to()), "occurred_at < :to");

        var count = jdbc.sql("select count(*) from engine_audit_event" + where).param("tenant", tenantId);
        var rows = jdbc.sql("""
                select id, tenant_id, occurred_at, actor, action, entity_type, entity_id, cast(details as text) as details
                from engine_audit_event
                """ + where + " order by occurred_at desc, id limit :limit offset :offset")
                .param("tenant", tenantId)
                .param("limit", size)
                .param("offset", (long) page * size);
        for (Object[] p : params) {
            count = count.param((String) p[0], p[1]);
            rows = rows.param((String) p[0], p[1]);
        }

        long total = count.query(Long.class).single();
        List<AuditEvent> content = rows.query((rs, n) -> new AuditEvent(
                        rs.getObject("id", UUID.class),
                        rs.getString("tenant_id"),
                        rs.getTimestamp("occurred_at").toInstant(),
                        rs.getString("actor"),
                        rs.getString("action"),
                        rs.getString("entity_type"),
                        rs.getString("entity_id"),
                        rs.getString("details")))
                .list();
        return new PageResult<>(content, page, size, total);
    }

    private static void add(StringBuilder where, List<Object[]> params, String name, Object value, String clause) {
        if (value != null) {
            where.append(" and ").append(clause);
            params.add(new Object[] {name, value});
        }
    }
}
