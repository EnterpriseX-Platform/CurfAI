package com.enterprisex.curf.engine.application.schedule;

import java.time.DateTimeException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import org.springframework.scheduling.support.CronExpression;

/**
 * A five-field cron timetable (minute hour day-of-month month day-of-week) read in a time zone. Seconds are not
 * accepted, nor are macros such as {@code @daily}: a timetable should read the same everywhere.
 */
public final class CronSchedule {

    private final CronExpression expression;
    private final ZoneId zone;

    private CronSchedule(CronExpression expression, ZoneId zone) {
        this.expression = expression;
        this.zone = zone;
    }

    /** @throws IllegalArgumentException with a message fit to show the caller */
    public static CronSchedule parse(String cron, String timezone) {
        if (cron == null || cron.isBlank()) {
            throw new IllegalArgumentException("cron is required");
        }
        String[] fields = cron.trim().split("\\s+");
        if (fields.length != 5 || cron.contains("@")) {
            throw new IllegalArgumentException("cron must have five fields: minute hour day-of-month month day-of-week");
        }
        ZoneId zone;
        try {
            zone = ZoneId.of(timezone == null || timezone.isBlank() ? "UTC" : timezone);
        } catch (DateTimeException e) {
            throw new IllegalArgumentException("timezone is not a known zone, for example Asia/Bangkok");
        }
        try {
            return new CronSchedule(CronExpression.parse("0 " + String.join(" ", fields)), zone);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("cron is not valid: " + e.getMessage());
        }
    }

    /** The first fire strictly after {@code after}, or null if there is none. */
    public Instant next(Instant after) {
        ZonedDateTime next = expression.next(after.atZone(zone));
        return next == null ? null : next.toInstant();
    }

    /** The shortest gap among the next several fires after {@code from}; a guard against schedules that fire too often. */
    public Duration shortestGap(Instant from) {
        Duration shortest = null;
        Instant previous = next(from);
        for (int i = 0; i < 12 && previous != null; i++) {
            Instant following = next(previous);
            if (following == null) {
                break;
            }
            Duration gap = Duration.between(previous, following);
            if (shortest == null || gap.compareTo(shortest) < 0) {
                shortest = gap;
            }
            previous = following;
        }
        return shortest;
    }
}
