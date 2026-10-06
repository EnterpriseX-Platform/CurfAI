package com.enterprisex.curf.engine.infrastructure.sharing;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.sharing.PublishRequest;
import com.enterprisex.curf.engine.application.sharing.PublishRequest.State;
import com.enterprisex.curf.engine.application.sharing.PublishRequestRepository;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class JdbcPublishRequestRepository implements PublishRequestRepository {

    private static final String COLUMNS = """
            id, tenant_id, report_id, version, state, requested_by, requested_at, request_note, decided_by, decided_at, decision_note""";

    private final JdbcClient jdbc;

    public JdbcPublishRequestRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insert(PublishRequest r) {
        jdbc.sql("""
                insert into engine_publish_request (id, tenant_id, report_id, version, state, requested_by, requested_at, request_note)
                values (:id, :t, :report, :version, :state, :by, :at, :note)
                """)
                .param("id", r.id()).param("t", r.tenantId()).param("report", r.reportId()).param("version", r.version())
                .param("state", r.state().name()).param("by", r.requestedBy()).param("at", Timestamp.from(r.requestedAt()))
                .param("note", r.requestNote()).update();
    }

    @Override
    public Optional<PublishRequest> find(String tenantId, UUID id) {
        return jdbc.sql("select " + COLUMNS + " from engine_publish_request where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).query((rs, n) -> map(rs)).optional();
    }

    @Override
    public Optional<PublishRequest> pendingFor(String tenantId, UUID reportId) {
        return jdbc.sql("select " + COLUMNS + " from engine_publish_request where tenant_id = :t and report_id = :r and state = 'PENDING'")
                .param("t", tenantId).param("r", reportId).query((rs, n) -> map(rs)).optional();
    }

    @Override
    public List<PublishRequest> forReport(String tenantId, UUID reportId) {
        return jdbc.sql("select " + COLUMNS + " from engine_publish_request where tenant_id = :t and report_id = :r order by requested_at desc limit 200")
                .param("t", tenantId).param("r", reportId).query((rs, n) -> map(rs)).list();
    }

    @Override
    public PageResult<PublishRequest> byState(String tenantId, State state, int page, int size) {
        long total = jdbc.sql("select count(*) from engine_publish_request where tenant_id = :t and state = :s")
                .param("t", tenantId).param("s", state.name()).query(Long.class).single();
        List<PublishRequest> content = jdbc.sql("select " + COLUMNS + " from engine_publish_request where tenant_id = :t and state = :s"
                        + " order by requested_at desc limit :limit offset :offset")
                .param("t", tenantId).param("s", state.name()).param("limit", size).param("offset", (long) page * size)
                .query((rs, n) -> map(rs)).list();
        return new PageResult<>(content, page, size, total);
    }

    @Override
    public boolean decide(String tenantId, UUID id, State state, String by, Instant at, String note) {
        return jdbc.sql("""
                update engine_publish_request set state = :state, decided_by = :by, decided_at = :at, decision_note = :note
                where tenant_id = :t and id = :id and state = 'PENDING'
                """)
                .param("state", state.name()).param("by", by).param("at", Timestamp.from(at)).param("note", note)
                .param("t", tenantId).param("id", id).update() == 1;
    }

    private static PublishRequest map(ResultSet rs) throws SQLException {
        Timestamp decidedAt = rs.getTimestamp("decided_at");
        return new PublishRequest(rs.getObject("id", UUID.class), rs.getString("tenant_id"), rs.getObject("report_id", UUID.class),
                rs.getInt("version"), State.valueOf(rs.getString("state")), rs.getString("requested_by"),
                rs.getTimestamp("requested_at").toInstant(), rs.getString("request_note"), rs.getString("decided_by"),
                decidedAt == null ? null : decidedAt.toInstant(), rs.getString("decision_note"));
    }
}
