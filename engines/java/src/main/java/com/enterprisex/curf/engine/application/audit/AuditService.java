package com.enterprisex.curf.engine.application.audit;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

@Service
public class AuditService {

    static final int MAX_PAGE_SIZE = 200;

    private final AuditLog log;
    private final Clock clock;
    private final JsonMapper json;

    public AuditService(AuditLog log, Clock clock, JsonMapper json) {
        this.log = log;
        this.clock = clock;
        this.json = json;
    }

    /** Same as the text form, serialising {@code details}. Callers must keep secrets out of the map. */
    public void record(Viewer viewer, String action, String entityType, String entityId, Map<String, ?> details) {
        record(viewer, action, entityType, entityId, json.writeValueAsString(details));
    }

    /** Every state change calls this. {@code details} must be JSON text and must not carry secrets. */
    public void record(Viewer viewer, String action, String entityType, String entityId, String details) {
        log.append(new AuditEvent(
                UUID.randomUUID(), viewer.tenantId(), clock.instant(), viewer.subject(),
                action, entityType, entityId, details));
    }

    public PageResult<AuditEvent> list(Viewer viewer, AuditFilter filter, int page, int size) {
        if (!viewer.can(Permission.AUDIT_READ)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Audit access requires the audit:read permission");
        }
        if (page < 0 || size < 1 || size > MAX_PAGE_SIZE) {
            throw new EngineException(
                    ErrorCode.CURF_INVALID_INPUT, "page must be >= 0 and size between 1 and " + MAX_PAGE_SIZE);
        }
        return log.find(viewer.tenantId(), filter, page, size);
    }
}
