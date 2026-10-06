package com.enterprisex.curf.engine.application.schedule;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port. Claiming is the one place two engine instances can race, so each claim is a single atomic step in the database. */
public interface ScheduleRunRepository {

    /**
     * Claims a fire: moves the schedule's {@code nextRunAt} from {@code expectedNext} to {@code newNext} and records the run
     * as RUNNING for {@code instance}, together or not at all. Empty when another instance got there first.
     */
    Optional<ScheduleRun> claimFire(Schedule schedule, Instant expectedNext, Instant newNext, String instance, Instant leaseUntil, Instant now);

    /** Runs waiting to be retried, and runs whose instance stopped renewing its lease (it died or is stuck). */
    List<ScheduleRun> takeable(Instant now, int limit);

    /** Takes over a run seen as {@code seen}: only one caller wins. Counts a new attempt. */
    Optional<ScheduleRun> takeOver(ScheduleRun seen, String instance, Instant leaseUntil, Instant now);

    void markSucceeded(UUID runId, Instant now, UUID exportId, int deliveredTo);

    /** Waits for another attempt at {@code nextAttemptAt}. */
    void markRetry(UUID runId, Instant now, Instant nextAttemptAt, String error);

    void markFailed(UUID runId, Instant now, String error);

    List<ScheduleRun> forSchedule(String tenantId, UUID scheduleId, int limit);

    Optional<ScheduleRun> find(UUID runId);
}
