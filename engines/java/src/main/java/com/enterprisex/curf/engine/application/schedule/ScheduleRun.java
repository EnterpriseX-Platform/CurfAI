package com.enterprisex.curf.engine.application.schedule;

import java.time.Instant;
import java.util.UUID;

/**
 * One fire of a schedule. There is at most one per schedule and fire time, so however many engine instances run, a
 * fire is done once. A run that fails for a reason that may pass waits in RETRY; one whose instance died is taken over
 * when its lease runs out.
 */
public record ScheduleRun(
        UUID id,
        UUID scheduleId,
        String tenantId,
        Instant scheduledFor,
        State state,
        int attempt,
        String claimedBy,
        Instant leaseUntil,
        Instant nextAttemptAt,
        Instant startedAt,
        Instant finishedAt,
        String error,
        UUID exportId,
        Integer deliveredTo) {

    public enum State {
        RUNNING,
        RETRY,
        SUCCEEDED,
        FAILED
    }
}
