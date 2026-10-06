package com.enterprisex.curf.engine.application.schedule;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.export.Export;
import com.enterprisex.curf.engine.application.export.ExportRequest;
import com.enterprisex.curf.engine.application.export.ExportService;
import com.enterprisex.curf.engine.application.report.ReportRepository;
import com.enterprisex.curf.engine.application.schedule.ReportMailer.DeliveryException;
import com.enterprisex.curf.engine.application.schedule.ReportMailer.Mail;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.net.InetAddress;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Fires schedules and delivers their reports. Any number of engine instances may run {@link #tick()} against the same
 * database: a fire is claimed with one atomic step (see {@link ScheduleRunRepository#claimFire}), so it happens once.
 * A failure that may pass (the mail server or the PDF printer being down) is retried with growing waits; one that will
 * not (the person lost access to the report) fails at once. A run whose instance died is taken over when its lease ends.
 * Delivery is at least once: a retry after a partial send may deliver to someone twice.
 */
@Service
public class SchedulerService {

    private static final Logger LOG = LoggerFactory.getLogger(SchedulerService.class);
    private static final int BATCH = 50;
    private static final int MAX_ERROR = 500;
    private static final Set<ErrorCode> RETRIABLE = EnumSet.of(
            ErrorCode.CURF_EXPORT_UNAVAILABLE, ErrorCode.CURF_QUERY_TIMEOUT, ErrorCode.CURF_TOO_MANY_QUERIES,
            ErrorCode.CURF_CONNECTION_FAILED, ErrorCode.CURF_INTERNAL);

    private final ScheduleRepository schedules;
    private final ScheduleRunRepository runs;
    private final ExportService exports;
    private final ReportRepository reports;
    private final ReportMailer mailer;
    private final ScheduleProperties props;
    private final AuditService audit;
    private final Clock clock;
    private final String instance;

    public SchedulerService(
            ScheduleRepository schedules, ScheduleRunRepository runs, ExportService exports, ReportRepository reports, ReportMailer mailer,
            ScheduleProperties props, AuditService audit, Clock clock) {
        this.schedules = schedules;
        this.runs = runs;
        this.exports = exports;
        this.reports = reports;
        this.mailer = mailer;
        this.props = props;
        this.audit = audit;
        this.clock = clock;
        this.instance = hostname() + "-" + UUID.randomUUID().toString().substring(0, 8);
    }

    public String instance() {
        return instance;
    }

    public int tick() {
        return tick(clock.instant());
    }

    /** One pass: take over runs that need another attempt, then claim and run every schedule that is due. Returns how many runs it executed. */
    public int tick(Instant now) {
        int executed = 0;
        for (ScheduleRun seen : runs.takeable(now, BATCH)) {
            try {
                Optional<ScheduleRun> mine = runs.takeOver(seen, instance, now.plus(props.lease()), now);
                if (mine.isEmpty()) {
                    continue;
                }
                if (mine.get().attempt() > props.maxAttempts()) {
                    // Instances keep dying on this run; stop rather than loop forever.
                    runs.markFailed(seen.id(), clock.instant(), "Gave up: the run was interrupted " + seen.attempt() + " times");
                    continue;
                }
                execute(mine.get(), now);
                executed++;
            } catch (RuntimeException e) {
                LOG.error("Could not take over scheduled run {}", seen.id(), e);
            }
        }
        for (Schedule due : schedules.due(now, BATCH)) {
            try {
                CronSchedule cron = CronSchedule.parse(due.cron(), due.timezone());
                // The next fire after now, not after the missed one: an engine that was down runs a schedule once, not once per missed fire.
                Instant next = cron.next(now);
                Optional<ScheduleRun> mine = runs.claimFire(due, due.nextRunAt(), next, instance, now.plus(props.lease()), now);
                if (mine.isPresent()) {
                    execute(mine.get(), now);
                    executed++;
                }
            } catch (RuntimeException e) {
                LOG.error("Could not fire schedule {}", due.id(), e);
            }
        }
        return executed;
    }

    private void execute(ScheduleRun run, Instant now) {
        Schedule schedule = schedules.findAnyTenant(run.scheduleId()).orElse(null);
        if (schedule == null) {
            runs.markFailed(run.id(), clock.instant(), "The schedule no longer exists");
            return;
        }
        Viewer viewer = schedule.runAs().toViewer();
        try {
            ExportRequest request = new ExportRequest(schedule.format(), schedule.params(), schedule.locale(), null, null, null);
            Export export = exports.create(viewer, schedule.reportId(), request);
            ExportService.File file = exports.file(viewer, export.id());
            if (file.content().length > props.maxAttachmentBytes()) {
                throw new NotRetriable("The file is " + file.content().length / (1024 * 1024) + " MB, over the " + props.maxAttachmentBytes() / (1024 * 1024)
                        + " MB limit for an email attachment");
            }
            String reportName = reports.find(schedule.tenantId(), schedule.reportId()).map(r -> r.name()).orElse(schedule.name());
            mailer.send(new Mail(schedule.recipients(), subject(schedule, reportName, run.scheduledFor()), body(schedule, reportName, export),
                    export.fileName(), schedule.format().contentType(), file.content()));
            runs.markSucceeded(run.id(), clock.instant(), export.id(), schedule.recipients().size());
            audit.record(viewer, "schedule.run", "schedule", schedule.id().toString(),
                    Map.of("runId", run.id().toString(), "attempt", run.attempt(), "sha256", export.sha256(), "recipients", schedule.recipients().size()));
        } catch (RuntimeException e) {
            fail(run, schedule, viewer, e, now);
        }
    }

    private void fail(ScheduleRun run, Schedule schedule, Viewer viewer, RuntimeException e, Instant now) {
        boolean retriable = retriable(e);
        String message = clip(describe(e));
        if (!(e instanceof EngineException) && !(e instanceof DeliveryException) && !(e instanceof NotRetriable)) {
            LOG.error("Scheduled run {} of schedule {} failed unexpectedly", run.id(), schedule.id(), e);
        }
        Instant at = clock.instant();
        if (retriable && run.attempt() < props.maxAttempts()) {
            Duration wait = props.retryBackoff().multipliedBy(1L << Math.min(run.attempt() - 1, 10));
            runs.markRetry(run.id(), at, now.plus(wait), message);
        } else {
            runs.markFailed(run.id(), at, message);
            audit.record(viewer, "schedule.run-failed", "schedule", schedule.id().toString(),
                    Map.of("runId", run.id().toString(), "attempts", run.attempt(), "error", message));
        }
    }

    private static boolean retriable(RuntimeException e) {
        if (e instanceof NotRetriable) {
            return false;
        }
        if (e instanceof DeliveryException d) {
            return d.retriable();
        }
        if (e instanceof EngineException ee) {
            return RETRIABLE.contains(ee.code());
        }
        return true;
    }

    private static String describe(RuntimeException e) {
        if (e instanceof EngineException || e instanceof DeliveryException || e instanceof NotRetriable) {
            return e.getMessage();
        }
        // Anything else may carry internals; the log has them, the run row does not.
        return "The run failed unexpectedly";
    }

    private static String subject(Schedule s, String reportName, Instant scheduledFor) {
        return reportName + " - " + scheduledFor.toString().substring(0, 10);
    }

    private static String body(Schedule s, String reportName, Export export) {
        if ("en".equals(s.locale())) {
            return "Attached: " + reportName + " (" + export.fileName() + ").\nSHA-256: " + export.sha256() + "\nSent by schedule '" + s.name() + "'.";
        }
        return "แนบรายงาน: " + reportName + " (" + export.fileName() + ")\nSHA-256: " + export.sha256() + "\nส่งตามกำหนดการ '" + s.name() + "'";
    }

    private static String clip(String text) {
        return text.length() > MAX_ERROR ? text.substring(0, MAX_ERROR) : text;
    }

    private static String hostname() {
        try {
            return InetAddress.getLocalHost().getHostName();
        } catch (Exception e) {
            return "engine";
        }
    }

    /** A failure trying again will not fix. */
    private static final class NotRetriable extends RuntimeException {
        NotRetriable(String message) {
            super(message);
        }
    }
}
