package com.enterprisex.curf.engine.application.audit;

import java.time.Instant;
import java.util.UUID;

/** One append-only record of a state change or a sensitive read. {@code details} is JSON text. */
public record AuditEvent(
        UUID id,
        String tenantId,
        Instant occurredAt,
        String actor,
        String action,
        String entityType,
        String entityId,
        String details) {}
