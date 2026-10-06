package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.export.Export;
import com.enterprisex.curf.engine.application.export.ExportRepository;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
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
public class JdbcExportRepository implements ExportRepository {

    /** Everything but the file itself, so listing never loads the bytes. */
    private static final String COLUMNS =
            "id, tenant_id, report_id, report_name, format, file_name, size_bytes, sha256, as_of, created_at, created_by, expires_at";

    private final JdbcClient jdbc;

    public JdbcExportRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insert(Export e, byte[] content) {
        jdbc.sql("""
                insert into engine_export (id, tenant_id, report_id, report_name, format, file_name, size_bytes, sha256, as_of,
                                           created_at, created_by, expires_at, content)
                values (:id, :t, :report, :name, :format, :file, :size, :sha, :asOf, :createdAt, :createdBy, :expires, :content)
                """)
                .param("id", e.id()).param("t", e.tenantId()).param("report", e.reportId()).param("name", e.reportName())
                .param("format", e.format().name()).param("file", e.fileName()).param("size", e.sizeBytes()).param("sha", e.sha256())
                .param("asOf", e.asOf()).param("createdAt", Timestamp.from(e.createdAt())).param("createdBy", e.createdBy())
                .param("expires", Timestamp.from(e.expiresAt())).param("content", content)
                .update();
    }

    @Override
    public Optional<Export> find(String tenantId, UUID id) {
        return jdbc.sql("select " + COLUMNS + " from engine_export where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).query((rs, n) -> map(rs)).optional();
    }

    @Override
    public Optional<byte[]> content(String tenantId, UUID id) {
        return jdbc.sql("select content from engine_export where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).query((rs, n) -> rs.getBytes(1)).optional();
    }

    @Override
    public PageResult<Export> listByCreator(String tenantId, String creator, int page, int size) {
        long total = jdbc.sql("select count(*) from engine_export where tenant_id = :t and created_by = :c and expires_at > now()")
                .param("t", tenantId).param("c", creator).query(Long.class).single();
        List<Export> content = jdbc.sql("select " + COLUMNS + " from engine_export where tenant_id = :t and created_by = :c and expires_at > now() "
                        + "order by created_at desc limit :limit offset :offset")
                .param("t", tenantId).param("c", creator).param("limit", size).param("offset", (long) page * size)
                .query((rs, n) -> map(rs)).list();
        return new PageResult<>(content, page, size, total);
    }

    @Override
    public boolean delete(String tenantId, UUID id) {
        return jdbc.sql("delete from engine_export where tenant_id = :t and id = :id").param("t", tenantId).param("id", id).update() == 1;
    }

    @Override
    public int purgeExpired(Instant now) {
        return jdbc.sql("delete from engine_export where expires_at <= :now").param("now", Timestamp.from(now)).update();
    }

    private static Export map(ResultSet rs) throws SQLException {
        return new Export(rs.getObject("id", UUID.class), rs.getString("tenant_id"), rs.getObject("report_id", UUID.class),
                rs.getString("report_name"), ExportFormat.valueOf(rs.getString("format")), rs.getString("file_name"),
                rs.getLong("size_bytes"), rs.getString("sha256"), rs.getString("as_of"), rs.getTimestamp("created_at").toInstant(),
                rs.getString("created_by"), rs.getTimestamp("expires_at").toInstant());
    }
}
