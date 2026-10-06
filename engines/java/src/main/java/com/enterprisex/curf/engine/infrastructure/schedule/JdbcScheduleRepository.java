package com.enterprisex.curf.engine.infrastructure.schedule;

import com.enterprisex.curf.engine.application.schedule.Schedule;
import com.enterprisex.curf.engine.application.schedule.ScheduleRepository;
import com.enterprisex.curf.engine.application.schedule.ScheduleRun;
import com.enterprisex.curf.engine.application.schedule.ScheduleRun.State;
import com.enterprisex.curf.engine.application.schedule.ScheduleRunRepository;
import com.enterprisex.curf.engine.application.schedule.ViewerSnapshot;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

@Repository
public class JdbcScheduleRepository implements ScheduleRepository, ScheduleRunRepository {

    private static final String SCHEDULE_COLUMNS = """
            id, tenant_id, report_id, name, cron, timezone, format, locale, cast(params as text) as params,
            cast(recipients as text) as recipients, cast(run_as as text) as run_as, enabled, next_run_at,
            created_at, created_by, updated_at, updated_by""";

    private static final String RUN_COLUMNS = """
            id, schedule_id, tenant_id, scheduled_for, state, attempt, claimed_by, lease_until, next_attempt_at, started_at,
            finished_at, error, export_id, delivered_to""";

    private final JdbcClient jdbc;
    private final JsonMapper json;

    public JdbcScheduleRepository(JdbcClient jdbc, JsonMapper json) {
        this.jdbc = jdbc;
        this.json = json;
    }

    // ------------------------------------------------------------------ schedules

    @Override
    public void insert(Schedule s) {
        jdbc.sql("""
                insert into engine_schedule (id, tenant_id, report_id, name, cron, timezone, format, locale, params, recipients, run_as,
                  enabled, next_run_at, created_at, created_by, updated_at, updated_by)
                values (:id, :t, :report, :name, :cron, :tz, :format, :locale, cast(:params as jsonb), cast(:recipients as jsonb),
                  cast(:runAs as jsonb), :enabled, :next, :createdAt, :createdBy, :updatedAt, :updatedBy)
                """)
                .param("id", s.id()).param("t", s.tenantId()).param("report", s.reportId()).param("name", s.name())
                .param("cron", s.cron()).param("tz", s.timezone()).param("format", s.format().name())
                .param("locale", s.locale(), Types.VARCHAR).param("params", json.writeValueAsString(s.params()))
                .param("recipients", json.writeValueAsString(s.recipients())).param("runAs", json.writeValueAsString(s.runAs()))
                .param("enabled", s.enabled()).param("next", ts(s.nextRunAt()), Types.TIMESTAMP)
                .param("createdAt", Timestamp.from(s.createdAt())).param("createdBy", s.createdBy())
                .param("updatedAt", Timestamp.from(s.updatedAt())).param("updatedBy", s.updatedBy()).update();
    }

    @Override
    public Optional<Schedule> find(String tenantId, UUID id) {
        return jdbc.sql("select " + SCHEDULE_COLUMNS + " from engine_schedule where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id).query((rs, n) -> schedule(rs)).optional();
    }

    @Override
    public Optional<Schedule> findAnyTenant(UUID id) {
        return jdbc.sql("select " + SCHEDULE_COLUMNS + " from engine_schedule where id = :id")
                .param("id", id).query((rs, n) -> schedule(rs)).optional();
    }

    @Override
    public List<Schedule> list(String tenantId) {
        return jdbc.sql("select " + SCHEDULE_COLUMNS + " from engine_schedule where tenant_id = :t order by name limit 1000")
                .param("t", tenantId).query((rs, n) -> schedule(rs)).list();
    }

    @Override
    public void update(Schedule s) {
        jdbc.sql("""
                update engine_schedule set name = :name, cron = :cron, timezone = :tz, format = :format, locale = :locale,
                  params = cast(:params as jsonb), recipients = cast(:recipients as jsonb), run_as = cast(:runAs as jsonb),
                  enabled = :enabled, next_run_at = :next, updated_at = :updatedAt, updated_by = :updatedBy
                where tenant_id = :t and id = :id
                """)
                .param("name", s.name()).param("cron", s.cron()).param("tz", s.timezone()).param("format", s.format().name())
                .param("locale", s.locale(), Types.VARCHAR).param("params", json.writeValueAsString(s.params()))
                .param("recipients", json.writeValueAsString(s.recipients())).param("runAs", json.writeValueAsString(s.runAs()))
                .param("enabled", s.enabled()).param("next", ts(s.nextRunAt()), Types.TIMESTAMP)
                .param("updatedAt", Timestamp.from(s.updatedAt())).param("updatedBy", s.updatedBy())
                .param("t", s.tenantId()).param("id", s.id()).update();
    }

    @Override
    public boolean delete(String tenantId, UUID id) {
        return jdbc.sql("delete from engine_schedule where tenant_id = :t and id = :id").param("t", tenantId).param("id", id).update() == 1;
    }

    @Override
    public List<Schedule> due(Instant now, int limit) {
        return jdbc.sql("select " + SCHEDULE_COLUMNS + " from engine_schedule where enabled and next_run_at <= :now order by next_run_at limit :limit")
                .param("now", Timestamp.from(now)).param("limit", limit).query((rs, n) -> schedule(rs)).list();
    }

    // ------------------------------------------------------------------ runs

    @Override
    @Transactional
    public Optional<ScheduleRun> claimFire(Schedule s, Instant expectedNext, Instant newNext, String instance, Instant leaseUntil, Instant now) {
        int moved = jdbc.sql("update engine_schedule set next_run_at = :new where id = :id and enabled and next_run_at = :expected")
                .param("new", ts(newNext), Types.TIMESTAMP).param("id", s.id()).param("expected", Timestamp.from(expectedNext)).update();
        if (moved != 1) {
            return Optional.empty();
        }
        UUID runId = UUID.randomUUID();
        jdbc.sql("""
                insert into engine_schedule_run (id, schedule_id, tenant_id, scheduled_for, state, attempt, claimed_by, lease_until, started_at)
                values (:id, :schedule, :t, :for, 'RUNNING', 1, :by, :lease, :now)
                """)
                .param("id", runId).param("schedule", s.id()).param("t", s.tenantId()).param("for", Timestamp.from(expectedNext))
                .param("by", instance).param("lease", Timestamp.from(leaseUntil)).param("now", Timestamp.from(now)).update();
        return find(runId);
    }

    @Override
    public List<ScheduleRun> takeable(Instant now, int limit) {
        return jdbc.sql("select " + RUN_COLUMNS + """
                 from engine_schedule_run
                where (state = 'RETRY' and next_attempt_at <= :now) or (state = 'RUNNING' and lease_until < :now)
                order by scheduled_for limit :limit""")
                .param("now", Timestamp.from(now)).param("limit", limit).query((rs, n) -> run(rs)).list();
    }

    @Override
    public Optional<ScheduleRun> takeOver(ScheduleRun seen, String instance, Instant leaseUntil, Instant now) {
        // Checking the state and attempt we saw makes this a compare-and-set: of several instances, one updates the row.
        int taken = jdbc.sql("""
                update engine_schedule_run set state = 'RUNNING', attempt = attempt + 1, claimed_by = :by, lease_until = :lease,
                  started_at = :now, next_attempt_at = null
                where id = :id and state = :state and attempt = :attempt
                """)
                .param("by", instance).param("lease", Timestamp.from(leaseUntil)).param("now", Timestamp.from(now))
                .param("id", seen.id()).param("state", seen.state().name()).param("attempt", seen.attempt()).update();
        return taken == 1 ? find(seen.id()) : Optional.empty();
    }

    @Override
    public void markSucceeded(UUID runId, Instant now, UUID exportId, int deliveredTo) {
        jdbc.sql("""
                update engine_schedule_run set state = 'SUCCEEDED', finished_at = :now, export_id = :export, delivered_to = :delivered,
                  error = null, lease_until = null where id = :id
                """)
                .param("now", Timestamp.from(now)).param("export", exportId).param("delivered", deliveredTo).param("id", runId).update();
    }

    @Override
    public void markRetry(UUID runId, Instant now, Instant nextAttemptAt, String error) {
        jdbc.sql("""
                update engine_schedule_run set state = 'RETRY', next_attempt_at = :next, error = :error, lease_until = null, claimed_by = null
                where id = :id
                """)
                .param("next", Timestamp.from(nextAttemptAt)).param("error", error).param("id", runId).update();
    }

    @Override
    public void markFailed(UUID runId, Instant now, String error) {
        jdbc.sql("update engine_schedule_run set state = 'FAILED', finished_at = :now, error = :error, lease_until = null where id = :id")
                .param("now", Timestamp.from(now)).param("error", error).param("id", runId).update();
    }

    @Override
    public List<ScheduleRun> forSchedule(String tenantId, UUID scheduleId, int limit) {
        return jdbc.sql("select " + RUN_COLUMNS + " from engine_schedule_run where tenant_id = :t and schedule_id = :s order by scheduled_for desc limit :limit")
                .param("t", tenantId).param("s", scheduleId).param("limit", limit).query((rs, n) -> run(rs)).list();
    }

    @Override
    public Optional<ScheduleRun> find(UUID runId) {
        return jdbc.sql("select " + RUN_COLUMNS + " from engine_schedule_run where id = :id").param("id", runId).query((rs, n) -> run(rs)).optional();
    }

    // ------------------------------------------------------------------ mapping

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp t = rs.getTimestamp(column);
        return t == null ? null : t.toInstant();
    }

    private Schedule schedule(ResultSet rs) throws SQLException {
        return new Schedule(rs.getObject("id", UUID.class), rs.getString("tenant_id"), rs.getObject("report_id", UUID.class), rs.getString("name"),
                rs.getString("cron"), rs.getString("timezone"), ExportFormat.valueOf(rs.getString("format")), rs.getString("locale"),
                json.readValue(rs.getString("params"), new TypeReference<Map<String, Object>>() {}),
                json.readValue(rs.getString("recipients"), new TypeReference<List<String>>() {}),
                json.readValue(rs.getString("run_as"), ViewerSnapshot.class), rs.getBoolean("enabled"), instant(rs, "next_run_at"),
                instant(rs, "created_at"), rs.getString("created_by"), instant(rs, "updated_at"), rs.getString("updated_by"));
    }

    private static ScheduleRun run(ResultSet rs) throws SQLException {
        return new ScheduleRun(rs.getObject("id", UUID.class), rs.getObject("schedule_id", UUID.class), rs.getString("tenant_id"),
                instant(rs, "scheduled_for"), State.valueOf(rs.getString("state")), rs.getInt("attempt"), rs.getString("claimed_by"),
                instant(rs, "lease_until"), instant(rs, "next_attempt_at"), instant(rs, "started_at"), instant(rs, "finished_at"),
                rs.getString("error"), rs.getObject("export_id", UUID.class), rs.getObject("delivered_to", Integer.class));
    }
}
