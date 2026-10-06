package com.enterprisex.curf.engine.application.sharing;

import java.time.Instant;
import java.util.UUID;

/**
 * A maker's request to publish one saved version of a report. A different person (the checker) approves or rejects it.
 * Approving publishes exactly {@code version}; if the report has been saved again since, the request is stale.
 */
public record PublishRequest(
        UUID id,
        String tenantId,
        UUID reportId,
        int version,
        State state,
        String requestedBy,
        Instant requestedAt,
        String requestNote,
        String decidedBy,
        Instant decidedAt,
        String decisionNote) {

    public enum State {
        PENDING,
        APPROVED,
        REJECTED,
        CANCELLED
    }
}
