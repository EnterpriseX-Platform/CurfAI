package com.enterprisex.curf.engine.infrastructure.sharing;

import com.enterprisex.curf.engine.application.sharing.PublicLink;
import com.enterprisex.curf.engine.application.sharing.PublicLink.Kind;
import com.enterprisex.curf.engine.application.sharing.PublicLinkRepository;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

@Repository
public class JdbcPublicLinkRepository implements PublicLinkRepository {

    private static final String COLUMNS = """
            id, tenant_id, report_id, kind, created_at, created_by, expires_at, revoked_at, revoked_by,
            cast(locked_params as text) as locked_params""";

    private final JdbcClient jdbc;
    private final JsonMapper json;

    public JdbcPublicLinkRepository(JdbcClient jdbc, JsonMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    public void insert(PublicLink l, String tokenHash) {
        jdbc.sql("""
                insert into engine_public_link (id, tenant_id, report_id, kind, token_hash, locked_params, created_at, created_by, expires_at)
                values (:id, :t, :report, :kind, :hash, cast(:locked as jsonb), :at, :by, :expires)
                """)
                .param("id", l.id()).param("t", l.tenantId()).param("report", l.reportId()).param("kind", l.kind().name())
                .param("hash", tokenHash).param("locked", json.writeValueAsString(l.lockedParams()))
                .param("at", Timestamp.from(l.createdAt())).param("by", l.createdBy()).param("expires", Timestamp.from(l.expiresAt()))
                .update();
    }

    @Override
    public Optional<PublicLink> findByTokenHash(String tokenHash) {
        return jdbc.sql("select " + COLUMNS + " from engine_public_link where token_hash = :h")
                .param("h", tokenHash).query((rs, n) -> map(rs)).optional();
    }

    @Override
    public Optional<PublicLink> find(String tenantId, UUID id) {
        return jdbc.sql("select " + COLUMNS + " from engine_public_link where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).query((rs, n) -> map(rs)).optional();
    }

    @Override
    public List<PublicLink> forReport(String tenantId, UUID reportId) {
        return jdbc.sql("select " + COLUMNS + " from engine_public_link where tenant_id = :t and report_id = :r order by created_at desc limit 200")
                .param("t", tenantId).param("r", reportId).query((rs, n) -> map(rs)).list();
    }

    @Override
    public boolean revoke(String tenantId, UUID id, String by, Instant at) {
        return jdbc.sql("update engine_public_link set revoked_at = :at, revoked_by = :by where tenant_id = :t and id = :id and revoked_at is null")
                .param("at", Timestamp.from(at)).param("by", by).param("t", tenantId).param("id", id).update() == 1;
    }

    private PublicLink map(ResultSet rs) throws SQLException {
        Timestamp revoked = rs.getTimestamp("revoked_at");
        String locked = rs.getString("locked_params");
        Map<String, Object> params = locked == null ? Map.of() : json.readValue(locked, new TypeReference<Map<String, Object>>() {});
        return new PublicLink(rs.getObject("id", UUID.class), rs.getString("tenant_id"), rs.getObject("report_id", UUID.class),
                Kind.valueOf(rs.getString("kind")), rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"),
                rs.getTimestamp("expires_at").toInstant(), revoked == null ? null : revoked.toInstant(), rs.getString("revoked_by"), params);
    }
}
