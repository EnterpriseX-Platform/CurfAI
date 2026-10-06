package com.enterprisex.curf.engine.infrastructure.view;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.view.ViewRepository;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.view.PiiMode;
import com.enterprisex.curf.engine.domain.view.RlsRule;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewColumn;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

@Repository
public class JdbcViewRepository implements ViewRepository {

    private static final String COLUMNS = """
            id, tenant_id, name, description, connection_id, sql, cast(definition as text) as definition, version,
            published_version, created_at, created_by, updated_at, updated_by""";

    /** The parts of a view that live in one JSON column. */
    record Definition(
            List<ViewColumn> columns, Set<String> allowedRoles, Set<String> piiRoles, Set<String> bypassRoles,
            List<RlsRule> rlsRules, Integer refreshSeconds) {}

    private final JdbcClient jdbc;
    private final JsonMapper json;

    public JdbcViewRepository(JdbcClient jdbc, JsonMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    public void insert(View v) {
        try {
            jdbc.sql("""
                    insert into engine_view
                      (id, tenant_id, name, description, connection_id, sql, definition, version, published_version,
                       created_at, created_by, updated_at, updated_by)
                    values (:id, :t, :name, :description, :conn, :sql, cast(:definition as jsonb), :version, :published,
                       :createdAt, :createdBy, :updatedAt, :updatedBy)
                    """)
                    .param("id", v.id()).param("t", v.tenantId()).param("name", v.name()).param("description", v.description())
                    .param("conn", v.connectionId()).param("sql", v.sql()).param("definition", definition(v))
                    .param("version", v.version()).param("published", v.publishedVersion())
                    .param("createdAt", Timestamp.from(v.createdAt())).param("createdBy", v.createdBy())
                    .param("updatedAt", Timestamp.from(v.updatedAt())).param("updatedBy", v.updatedBy())
                    .update();
        } catch (DuplicateKeyException e) {
            throw nameTaken();
        }
    }

    @Override
    public Optional<View> find(String tenantId, UUID id) {
        return jdbc.sql("select " + COLUMNS + " from engine_view where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).query((rs, n) -> map(rs)).optional();
    }

    @Override
    public Optional<View> findPublished(String tenantId, UUID id) {
        return jdbc.sql("""
                select cast(s.snapshot as text) from engine_view v
                join engine_view_version s on s.view_id = v.id and s.version_no = v.published_version
                where v.tenant_id = :t and v.id = :id
                """)
                .param("t", tenantId).param("id", id).query(String.class).optional().map(this::snapshot);
    }

    @Override
    public PageResult<View> list(String tenantId, int page, int size) {
        long total = jdbc.sql("select count(*) from engine_view where tenant_id = :t").param("t", tenantId).query(Long.class).single();
        List<View> content = jdbc.sql("select " + COLUMNS + " from engine_view where tenant_id = :t order by name limit :limit offset :offset")
                .param("t", tenantId).param("limit", size).param("offset", (long) page * size)
                .query((rs, n) -> map(rs)).list();
        return new PageResult<>(content, page, size, total);
    }

    @Override
    public List<View> listPublished(String tenantId) {
        return jdbc.sql("""
                select cast(s.snapshot as text) from engine_view v
                join engine_view_version s on s.view_id = v.id and s.version_no = v.published_version
                where v.tenant_id = :t order by v.name limit 1000
                """)
                .param("t", tenantId).query(String.class).list().stream().map(this::snapshot).toList();
    }

    @Override
    public boolean update(View v, int expectedVersion) {
        try {
            return jdbc.sql("""
                    update engine_view set name = :name, description = :description, connection_id = :conn, sql = :sql,
                      definition = cast(:definition as jsonb), version = :version, updated_at = :updatedAt, updated_by = :updatedBy
                    where tenant_id = :t and id = :id and version = :expected
                    """)
                    .param("name", v.name()).param("description", v.description()).param("conn", v.connectionId())
                    .param("sql", v.sql()).param("definition", definition(v)).param("version", v.version())
                    .param("updatedAt", Timestamp.from(v.updatedAt())).param("updatedBy", v.updatedBy())
                    .param("t", v.tenantId()).param("id", v.id()).param("expected", expectedVersion)
                    .update() == 1;
        } catch (DuplicateKeyException e) {
            throw nameTaken();
        }
    }

    @Override
    public boolean delete(String tenantId, UUID id) {
        return jdbc.sql("delete from engine_view where tenant_id = :t and id = :id").param("t", tenantId).param("id", id).update() == 1;
    }

    @Override
    @Transactional
    public void publish(String tenantId, UUID id, View snapshot, String by, Instant at) {
        jdbc.sql("""
                insert into engine_view_version (view_id, version_no, snapshot, published_at, published_by)
                values (:id, :version, cast(:snapshot as jsonb), :at, :by)
                on conflict (view_id, version_no)
                do update set snapshot = excluded.snapshot, published_at = excluded.published_at, published_by = excluded.published_by
                """)
                .param("id", id).param("version", snapshot.version()).param("snapshot", json.writeValueAsString(snapshot))
                .param("at", Timestamp.from(at)).param("by", by).update();
        jdbc.sql("update engine_view set published_version = :version where tenant_id = :t and id = :id")
                .param("version", snapshot.version()).param("t", tenantId).param("id", id).update();
    }

    @Override
    public boolean unpublish(String tenantId, UUID id) {
        return jdbc.sql("update engine_view set published_version = null where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).update() == 1;
    }

    @Override
    public List<VersionInfo> versions(String tenantId, UUID id) {
        return jdbc.sql("""
                select s.version_no, s.published_at, s.published_by from engine_view_version s
                join engine_view v on v.id = s.view_id where v.tenant_id = :t and v.id = :id order by s.version_no desc
                """)
                .param("t", tenantId).param("id", id)
                .query((rs, n) -> new VersionInfo(rs.getInt(1), rs.getTimestamp(2).toInstant(), rs.getString(3))).list();
    }

    @Override
    public boolean nameTaken(String tenantId, String name, UUID exceptIdOrNull) {
        return jdbc.sql("select count(*) from engine_view where tenant_id = :t and lower(name) = lower(:n)"
                        + (exceptIdOrNull == null ? "" : " and id <> :except"))
                .param("t", tenantId).param("n", name)
                .params(exceptIdOrNull == null ? java.util.Map.of() : java.util.Map.of("except", exceptIdOrNull))
                .query(Long.class).single() > 0;
    }

    // ------------------------------------------------------------------

    private String definition(View v) {
        return json.writeValueAsString(new Definition(
                v.columns(), v.allowedRoles(), v.piiRoles(), v.bypassRoles(), v.rlsRules(), v.refreshSeconds()));
    }

    private View snapshot(String text) {
        return json.readValue(text, View.class);
    }

    private View map(ResultSet rs) throws SQLException {
        Definition d = json.readValue(rs.getString("definition"), Definition.class);
        Integer published = rs.getObject("published_version") == null ? null : rs.getInt("published_version");
        return new View(
                rs.getObject("id", UUID.class), rs.getString("tenant_id"), rs.getString("name"), rs.getString("description"),
                rs.getObject("connection_id", UUID.class), rs.getString("sql"),
                d.columns().stream().map(c -> new ViewColumn(c.name(), c.type(), c.label(), c.description(), c.pii() == null ? PiiMode.NONE : c.pii())).toList(),
                d.allowedRoles(), d.piiRoles(), d.bypassRoles(), d.rlsRules(), d.refreshSeconds(), rs.getInt("version"), published,
                rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"),
                rs.getTimestamp("updated_at").toInstant(), rs.getString("updated_by"));
    }

    private static EngineException nameTaken() {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                List.of(new FieldError("name", "A view with this name already exists")));
    }
}
