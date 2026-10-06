package com.enterprisex.curf.engine.infrastructure.sharing;

import com.enterprisex.curf.engine.application.sharing.ShareRepository;
import com.enterprisex.curf.engine.domain.report.ReportShare;
import com.enterprisex.curf.engine.domain.report.ReportShare.Permission;
import com.enterprisex.curf.engine.domain.report.ReportShare.SubjectType;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class JdbcShareRepository implements ShareRepository {

    private final JdbcClient jdbc;

    public JdbcShareRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public List<ReportShare> list(String tenantId, UUID reportId) {
        return jdbc.sql("""
                select s.subject_type, s.subject_id, s.permission, s.expires_at from engine_report_share s
                join engine_report r on r.id = s.report_id where r.tenant_id = :t and r.id = :id
                order by s.subject_type, s.subject_id
                """)
                .param("t", tenantId).param("id", reportId).query((rs, n) -> map(rs)).list();
    }

    @Override
    public Map<UUID, List<ReportShare>> listAll(String tenantId) {
        Map<UUID, List<ReportShare>> out = new LinkedHashMap<>();
        jdbc.sql("""
                select s.report_id, s.subject_type, s.subject_id, s.permission, s.expires_at from engine_report_share s
                join engine_report r on r.id = s.report_id where r.tenant_id = :t
                """)
                .param("t", tenantId)
                .query((rs, n) -> Map.entry(rs.getObject("report_id", UUID.class), mapFrom(rs)))
                .list()
                .forEach(e -> out.computeIfAbsent(e.getKey(), k -> new ArrayList<>()).add(e.getValue()));
        return out;
    }

    @Override
    @Transactional
    public void replace(String tenantId, UUID reportId, List<ReportShare> shares, String by, Instant at) {
        jdbc.sql("""
                delete from engine_report_share where report_id = :id
                  and exists (select 1 from engine_report r where r.id = :id and r.tenant_id = :t)
                """).param("id", reportId).param("t", tenantId).update();
        for (ReportShare s : shares) {
            jdbc.sql("""
                    insert into engine_report_share (id, report_id, subject_type, subject_id, permission, expires_at, created_at, created_by)
                    select :sid, r.id, :type, :subject, :permission, :expires, :at, :by from engine_report r where r.id = :id and r.tenant_id = :t
                    """)
                    .param("sid", UUID.randomUUID()).param("id", reportId).param("t", tenantId).param("type", s.subjectType().name())
                    .param("subject", s.subjectId()).param("permission", s.permission().name())
                    .param("expires", s.expiresAt() == null ? null : Timestamp.from(s.expiresAt()), java.sql.Types.TIMESTAMP)
                    .param("at", Timestamp.from(at)).param("by", by).update();
        }
    }

    private static ReportShare map(ResultSet rs) throws SQLException {
        return mapFrom(rs);
    }

    private static ReportShare mapFrom(ResultSet rs) throws SQLException {
        Timestamp expires = rs.getTimestamp("expires_at");
        return new ReportShare(SubjectType.valueOf(rs.getString("subject_type")), rs.getString("subject_id"),
                Permission.valueOf(rs.getString("permission")), expires == null ? null : expires.toInstant());
    }
}
