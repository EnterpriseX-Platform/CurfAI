package com.enterprisex.curf.engine.infrastructure.report;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.report.Report;
import com.enterprisex.curf.engine.application.report.ReportRepository;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Repository
public class JdbcReportRepository implements ReportRepository {

    private static final String COLUMNS = """
            id, tenant_id, name, cast(definition as text) as definition, cast(run_roles as text) as run_roles, version,
            published_version, created_at, created_by, updated_at, updated_by""";

    private final JdbcClient jdbc;
    private final JsonMapper json;

    public JdbcReportRepository(JdbcClient jdbc, JsonMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    @Override
    @Transactional
    public void insert(Report r, String note) {
        try {
            jdbc.sql("""
                    insert into engine_report (id, tenant_id, name, definition, run_roles, version, created_at, created_by, updated_at, updated_by)
                    values (:id, :t, :name, cast(:definition as jsonb), cast(:roles as jsonb), :version, :createdAt, :createdBy, :updatedAt, :updatedBy)
                    """)
                    .param("id", r.id()).param("t", r.tenantId()).param("name", r.name())
                    .param("definition", json.writeValueAsString(r.definition())).param("roles", json.writeValueAsString(r.runRoles()))
                    .param("version", r.version()).param("createdAt", Timestamp.from(r.createdAt())).param("createdBy", r.createdBy())
                    .param("updatedAt", Timestamp.from(r.updatedAt())).param("updatedBy", r.updatedBy())
                    .update();
        } catch (DuplicateKeyException e) {
            throw nameTaken();
        }
        saveVersion(r, note);
    }

    @Override
    public Optional<Report> find(String tenantId, UUID id) {
        return jdbc.sql("select " + COLUMNS + " from engine_report where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).query((rs, n) -> map(rs)).optional();
    }

    @Override
    public PageResult<Report> list(String tenantId, int page, int size) {
        long total = jdbc.sql("select count(*) from engine_report where tenant_id = :t").param("t", tenantId).query(Long.class).single();
        List<Report> content = jdbc.sql("select " + COLUMNS + " from engine_report where tenant_id = :t order by name limit :limit offset :offset")
                .param("t", tenantId).param("limit", size).param("offset", (long) page * size).query((rs, n) -> map(rs)).list();
        return new PageResult<>(content, page, size, total);
    }

    @Override
    public List<Report> listAll(String tenantId) {
        return jdbc.sql("select " + COLUMNS + " from engine_report where tenant_id = :t order by name limit 1000")
                .param("t", tenantId).query((rs, n) -> map(rs)).list();
    }

    @Override
    @Transactional
    public boolean update(Report r, int expectedVersion, String note) {
        int changed;
        try {
            changed = jdbc.sql("""
                    update engine_report set name = :name, definition = cast(:definition as jsonb), run_roles = cast(:roles as jsonb),
                      version = :version, updated_at = :updatedAt, updated_by = :updatedBy
                    where tenant_id = :t and id = :id and version = :expected
                    """)
                    .param("name", r.name()).param("definition", json.writeValueAsString(r.definition()))
                    .param("roles", json.writeValueAsString(r.runRoles())).param("version", r.version())
                    .param("updatedAt", Timestamp.from(r.updatedAt())).param("updatedBy", r.updatedBy())
                    .param("t", r.tenantId()).param("id", r.id()).param("expected", expectedVersion).update();
        } catch (DuplicateKeyException e) {
            throw nameTaken();
        }
        if (changed != 1) {
            return false;
        }
        saveVersion(r, note);
        return true;
    }

    @Override
    public boolean delete(String tenantId, UUID id) {
        return jdbc.sql("delete from engine_report where tenant_id = :t and id = :id").param("t", tenantId).param("id", id).update() == 1;
    }

    @Override
    public void setPublishedVersion(String tenantId, UUID id, Integer version) {
        jdbc.sql("update engine_report set published_version = :v where tenant_id = :t and id = :id")
                .param("v", version, java.sql.Types.INTEGER).param("t", tenantId).param("id", id).update();
    }

    @Override
    public List<VersionInfo> versions(String tenantId, UUID id) {
        return jdbc.sql("""
                select v.version_no, v.saved_at, v.saved_by, v.note from engine_report_version v
                join engine_report r on r.id = v.report_id where r.tenant_id = :t and r.id = :id order by v.version_no desc
                """)
                .param("t", tenantId).param("id", id)
                .query((rs, n) -> new VersionInfo(rs.getInt(1), rs.getTimestamp(2).toInstant(), rs.getString(3), rs.getString(4))).list();
    }

    @Override
    public Optional<JsonNode> versionDefinition(String tenantId, UUID id, int version) {
        return jdbc.sql("""
                select cast(v.definition as text) from engine_report_version v
                join engine_report r on r.id = v.report_id where r.tenant_id = :t and r.id = :id and v.version_no = :n
                """)
                .param("t", tenantId).param("id", id).param("n", version).query(String.class).optional().map(json::readTree);
    }

    @Override
    public boolean nameTaken(String tenantId, String name, UUID exceptIdOrNull) {
        return jdbc.sql("select count(*) from engine_report where tenant_id = :t and lower(name) = lower(:n)"
                        + (exceptIdOrNull == null ? "" : " and id <> :except"))
                .param("t", tenantId).param("n", name)
                .params(exceptIdOrNull == null ? java.util.Map.of() : java.util.Map.of("except", exceptIdOrNull))
                .query(Long.class).single() > 0;
    }

    private void saveVersion(Report r, String note) {
        jdbc.sql("""
                insert into engine_report_version (report_id, version_no, definition, saved_at, saved_by, note)
                values (:id, :version, cast(:definition as jsonb), :at, :by, :note)
                """)
                .param("id", r.id()).param("version", r.version()).param("definition", json.writeValueAsString(r.definition()))
                .param("at", Timestamp.from(r.updatedAt())).param("by", r.updatedBy()).param("note", note).update();
    }

    private Report map(ResultSet rs) throws SQLException {
        Set<String> roles = new LinkedHashSet<>(json.readValue(rs.getString("run_roles"), new TypeReference<List<String>>() {}));
        return new Report(rs.getObject("id", UUID.class), rs.getString("tenant_id"), rs.getString("name"),
                json.readTree(rs.getString("definition")), roles, rs.getInt("version"),
                rs.getObject("published_version", Integer.class),
                rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"),
                rs.getTimestamp("updated_at").toInstant(), rs.getString("updated_by"));
    }

    private static EngineException nameTaken() {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                List.of(new FieldError("definition.name", "A report with this name already exists")));
    }
}
