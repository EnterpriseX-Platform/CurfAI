package com.enterprisex.curf.engine.application.schedule;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.report.ReportDefinitions;
import com.enterprisex.curf.engine.application.report.ReportRunService;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import com.enterprisex.curf.engine.domain.report.ReportParams;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Creates and changes schedules. A schedule runs as whoever last saved it (see {@link ViewerSnapshot}), so saving needs
 * the right to manage schedules and the right to run that report; recipients must be on an allowed domain.
 */
@Service
public class ScheduleService {

    /** What a caller sends; {@code enabled} defaults to true. */
    public record Draft(
            UUID reportId, String name, String cron, String timezone, ExportFormat format, String locale, Map<String, Object> params,
            List<String> recipients, Boolean enabled) {}

    private static final Pattern EMAIL = Pattern.compile("[^@\\s,;<>\"]{1,64}@[A-Za-z0-9.-]{1,190}\\.[A-Za-z]{2,}");

    private final ScheduleRepository schedules;
    private final ScheduleRunRepository runs;
    private final ReportRunService reportRuns;
    private final ReportDefinitions definitions;
    private final ScheduleProperties props;
    private final AuditService audit;
    private final Clock clock;

    public ScheduleService(
            ScheduleRepository schedules, ScheduleRunRepository runs, ReportRunService reportRuns, ReportDefinitions definitions,
            ScheduleProperties props, AuditService audit, Clock clock) {
        this.schedules = schedules;
        this.runs = runs;
        this.reportRuns = reportRuns;
        this.definitions = definitions;
        this.props = props;
        this.audit = audit;
        this.clock = clock;
    }

    public Schedule create(Viewer viewer, Draft draft) {
        requireManage(viewer);
        Instant now = clock.instant();
        Schedule built = build(viewer, draft, UUID.randomUUID(), now, viewer.subject(), now);
        schedules.insert(built);
        audit.record(viewer, "schedule.create", "schedule", built.id().toString(), details(built));
        return built;
    }

    /** Saves the schedule again; it now runs as the person saving. */
    public Schedule update(Viewer viewer, UUID id, Draft draft) {
        requireManage(viewer);
        Schedule old = schedules.find(viewer.tenantId(), id).orElseThrow(ScheduleService::notFound);
        Draft full = new Draft(old.reportId(), draft.name(), draft.cron(), draft.timezone(), draft.format(), draft.locale(), draft.params(),
                draft.recipients(), draft.enabled());
        Schedule changed = build(viewer, full, old.id(), old.createdAt(), old.createdBy(), clock.instant());
        schedules.update(changed);
        audit.record(viewer, "schedule.update", "schedule", id.toString(), details(changed));
        return changed;
    }

    public Schedule get(Viewer viewer, UUID id) {
        requireManage(viewer);
        return schedules.find(viewer.tenantId(), id).orElseThrow(ScheduleService::notFound);
    }

    public List<Schedule> list(Viewer viewer) {
        requireManage(viewer);
        return schedules.list(viewer.tenantId());
    }

    public void delete(Viewer viewer, UUID id) {
        requireManage(viewer);
        if (!schedules.delete(viewer.tenantId(), id)) {
            throw notFound();
        }
        audit.record(viewer, "schedule.delete", "schedule", id.toString(), Map.of());
    }

    public List<ScheduleRun> runs(Viewer viewer, UUID id) {
        get(viewer, id);
        return runs.forSchedule(viewer.tenantId(), id, 100);
    }

    // ------------------------------------------------------------------ validation

    private Schedule build(Viewer viewer, Draft d, UUID id, Instant createdAt, String createdBy, Instant now) {
        List<FieldError> problems = new ArrayList<>();
        if (d.reportId() == null) {
            problems.add(new FieldError("reportId", "is required"));
        }
        String name = d.name() == null ? "" : d.name().trim();
        if (name.isEmpty() || name.length() > 200) {
            problems.add(new FieldError("name", "must be 1 to 200 characters"));
        }
        if (d.format() == null) {
            problems.add(new FieldError("format", "is required (csv, xlsx, docx or pdf)"));
        }
        String locale = d.locale() == null || d.locale().isBlank() ? null : d.locale().toLowerCase(Locale.ROOT);
        if (locale != null && !locale.equals("th") && !locale.equals("en")) {
            problems.add(new FieldError("locale", "must be th or en"));
        }
        CronSchedule cron = null;
        try {
            cron = CronSchedule.parse(d.cron(), d.timezone());
            if (cron.next(now) == null) {
                problems.add(new FieldError("cron", "never fires"));
            }
            var gap = cron.shortestGap(now);
            if (gap != null && gap.compareTo(props.minInterval()) < 0) {
                problems.add(new FieldError("cron", "fires more often than every " + props.minInterval().toMinutes() + " minutes"));
            }
        } catch (IllegalArgumentException e) {
            problems.add(new FieldError("cron", e.getMessage()));
        }
        List<String> recipients = recipients(d.recipients(), problems);

        Map<String, Object> params = d.params() == null ? Map.of() : d.params();
        if (d.reportId() != null && problems.isEmpty()) {
            // The person must be able to run the report now; the same check every later run makes.
            ReportRunService.Resolved resolved = reportRuns.resolve(viewer, d.reportId());
            try {
                ReportParams.resolve(definitions.parse(resolved.definition()).parameters(), params);
            } catch (EngineException e) {
                problems.addAll(e.errors());
            }
        }
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", problems);
        }
        boolean enabled = d.enabled() == null || d.enabled();
        Instant next = enabled ? cron.next(now) : null;
        return new Schedule(id, viewer.tenantId(), d.reportId(), name, d.cron().trim().replaceAll("\\s+", " "),
                cron == null ? "UTC" : (d.timezone() == null || d.timezone().isBlank() ? "UTC" : d.timezone()), d.format(), locale, params,
                recipients, ViewerSnapshot.of(viewer), enabled, next, createdAt, createdBy, now, viewer.subject());
    }

    private List<String> recipients(List<String> given, List<FieldError> problems) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        if (given == null || given.isEmpty()) {
            problems.add(new FieldError("recipients", "needs at least one address"));
            return List.of();
        }
        if (given.size() > props.maxRecipients()) {
            problems.add(new FieldError("recipients", "at most " + props.maxRecipients() + " addresses"));
        }
        for (String raw : given) {
            String address = raw == null ? "" : raw.trim();
            if (!EMAIL.matcher(address).matches()) {
                problems.add(new FieldError("recipients", "'" + clip(address) + "' is not an email address"));
                continue;
            }
            String domain = address.substring(address.indexOf('@') + 1).toLowerCase(Locale.ROOT);
            if (props.allowedRecipientDomains().stream().noneMatch(d -> domain.equals(d) || domain.endsWith("." + d))) {
                problems.add(new FieldError("recipients", "'" + domain + "' is not an allowed recipient domain"));
                continue;
            }
            out.add(address);
        }
        return List.copyOf(out);
    }

    private static String clip(String s) {
        return s.length() > 60 ? s.substring(0, 60) : s;
    }

    private static Map<String, Object> details(Schedule s) {
        return Map.of("name", s.name(), "reportId", s.reportId().toString(), "cron", s.cron(), "format", s.format().name(),
                "recipients", s.recipients().size(), "enabled", s.enabled());
    }

    private static void requireManage(Viewer viewer) {
        if (!viewer.can(Permission.SCHEDULE_MANAGE)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Managing schedules requires the schedule:manage permission");
        }
    }

    private static EngineException notFound() {
        return new EngineException(ErrorCode.CURF_NOT_FOUND, "No such schedule");
    }
}
