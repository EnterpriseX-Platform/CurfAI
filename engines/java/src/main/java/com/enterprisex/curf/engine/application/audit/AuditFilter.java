package com.enterprisex.curf.engine.application.audit;

import java.time.Instant;

/** All fields optional; a null field does not filter. */
public record AuditFilter(String actor, String action, String entityType, String entityId, Instant from, Instant to) {}
