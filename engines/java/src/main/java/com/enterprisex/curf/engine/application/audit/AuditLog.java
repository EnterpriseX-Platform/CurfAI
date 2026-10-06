package com.enterprisex.curf.engine.application.audit;

import com.enterprisex.curf.engine.application.common.PageResult;

/** Port: append-only storage. There is deliberately no update or delete. */
public interface AuditLog {

    void append(AuditEvent event);

    PageResult<AuditEvent> find(String tenantId, AuditFilter filter, int page, int size);
}
