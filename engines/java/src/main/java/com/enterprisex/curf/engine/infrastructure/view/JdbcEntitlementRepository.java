package com.enterprisex.curf.engine.infrastructure.view;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.view.EntitlementRepository;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

@Repository
public class JdbcEntitlementRepository implements EntitlementRepository {

    private final JdbcClient jdbc;

    public JdbcEntitlementRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public Set<String> values(String tenantId, String subject, String attribute) {
        return new LinkedHashSet<>(jdbc.sql("select value from engine_entitlement where tenant_id = :t and subject = :s and attribute = :a order by value")
                .param("t", tenantId).param("s", subject).param("a", attribute).query(String.class).list());
    }

    @Override
    @Transactional
    public void replace(String tenantId, String subject, String attribute, Set<String> values) {
        jdbc.sql("delete from engine_entitlement where tenant_id = :t and subject = :s and attribute = :a")
                .param("t", tenantId).param("s", subject).param("a", attribute).update();
        for (String value : values) {
            jdbc.sql("insert into engine_entitlement (tenant_id, subject, attribute, value) values (:t, :s, :a, :v)")
                    .param("t", tenantId).param("s", subject).param("a", attribute).param("v", value).update();
        }
    }

    @Override
    public PageResult<Entitlement> list(String tenantId, String subjectOrNull, String attributeOrNull, int page, int size) {
        String where = " where tenant_id = :t" + (subjectOrNull == null ? "" : " and subject = :s")
                + (attributeOrNull == null ? "" : " and attribute = :a");
        Map<String, Object> params = new java.util.HashMap<>();
        params.put("t", tenantId);
        if (subjectOrNull != null) params.put("s", subjectOrNull);
        if (attributeOrNull != null) params.put("a", attributeOrNull);

        long total = jdbc.sql("select count(*) from engine_entitlement" + where).params(params).query(Long.class).single();
        List<Entitlement> content = jdbc.sql("select subject, attribute, value from engine_entitlement" + where
                        + " order by subject, attribute, value limit :limit offset :offset")
                .params(params).param("limit", size).param("offset", (long) page * size)
                .query((rs, n) -> new Entitlement(rs.getString(1), rs.getString(2), rs.getString(3))).list();
        return new PageResult<>(content, page, size, total);
    }
}
