package com.enterprisex.curf.engine.application.schedule;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port. Everything is scoped by tenant except {@link #due}, which the scheduler uses across tenants. */
public interface ScheduleRepository {

    void insert(Schedule schedule);

    Optional<Schedule> find(String tenantId, UUID id);

    /** Used by the scheduler, which works across tenants. */
    Optional<Schedule> findAnyTenant(UUID id);

    List<Schedule> list(String tenantId);

    void update(Schedule schedule);

    boolean delete(String tenantId, UUID id);

    /** Enabled schedules whose next fire is at or before {@code now}, oldest first. */
    List<Schedule> due(Instant now, int limit);
}
