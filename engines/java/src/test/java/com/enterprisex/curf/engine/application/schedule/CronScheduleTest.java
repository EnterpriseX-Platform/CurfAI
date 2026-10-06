package com.enterprisex.curf.engine.application.schedule;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class CronScheduleTest {

    @Test
    void readsFiveFieldsInTheGivenZone() {
        CronSchedule daily = CronSchedule.parse("30 6 * * *", "Asia/Bangkok");

        // 06:30 in Bangkok (UTC+7) is 23:30 UTC the evening before.
        assertThat(daily.next(Instant.parse("2026-10-05T00:00:00Z"))).isEqualTo(Instant.parse("2026-10-05T23:30:00Z"));
        assertThat(daily.next(Instant.parse("2026-10-05T23:30:00Z"))).as("strictly after").isEqualTo(Instant.parse("2026-10-06T23:30:00Z"));
    }

    @Test
    void defaultsToUtc() {
        assertThat(CronSchedule.parse("0 1 * * *", null).next(Instant.parse("2026-10-05T00:00:00Z"))).isEqualTo(Instant.parse("2026-10-05T01:00:00Z"));
    }

    @Test
    void refusesSecondsMacrosAndNonsense() {
        assertThatThrownBy(() -> CronSchedule.parse("0 0 6 * * *", "UTC")).hasMessageContaining("five fields");
        assertThatThrownBy(() -> CronSchedule.parse("@daily", "UTC")).hasMessageContaining("five fields");
        assertThatThrownBy(() -> CronSchedule.parse("", "UTC")).hasMessageContaining("required");
        assertThatThrownBy(() -> CronSchedule.parse("0 25 * * *", "UTC")).hasMessageContaining("not valid");
        assertThatThrownBy(() -> CronSchedule.parse("0 6 * * *", "Mars/Olympus")).hasMessageContaining("timezone");
    }

    @Test
    void measuresTheShortestGapBetweenFires() {
        Instant from = Instant.parse("2026-10-05T00:00:00Z");

        assertThat(CronSchedule.parse("*/1 * * * *", "UTC").shortestGap(from)).isEqualTo(Duration.ofMinutes(1));
        assertThat(CronSchedule.parse("0,10 * * * *", "UTC").shortestGap(from)).isEqualTo(Duration.ofMinutes(10));
        assertThat(CronSchedule.parse("0 6 * * *", "UTC").shortestGap(from)).isEqualTo(Duration.ofDays(1));
    }

    @Test
    void aTimetableThatNeverFiresHasNoNext() {
        assertThat(CronSchedule.parse("0 0 30 2 *", "UTC").next(Instant.parse("2026-10-05T00:00:00Z"))).isNull();
    }
}
