package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.audit.AuditEvent;
import com.enterprisex.curf.engine.application.audit.AuditFilter;
import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Instant;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/engine/v1/audit-events")
public class AuditController {

    private final AuditService audit;

    public AuditController(AuditService audit) {
        this.audit = audit;
    }

    @GetMapping
    PageResult<AuditEvent> list(
            Viewer viewer,
            @RequestParam(required = false) String actor,
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String entityType,
            @RequestParam(required = false) String entityId,
            @RequestParam(required = false) Instant from,
            @RequestParam(required = false) Instant to,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size) {
        return audit.list(viewer, new AuditFilter(actor, action, entityType, entityId, from, to), page, size);
    }
}
