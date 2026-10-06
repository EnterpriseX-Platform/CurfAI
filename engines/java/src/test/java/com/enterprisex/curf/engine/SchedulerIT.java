package com.enterprisex.curf.engine;

import static com.enterprisex.curf.engine.ReportIT.block;
import static com.enterprisex.curf.engine.ReportIT.definition;
import static com.enterprisex.curf.engine.ReportIT.saved;
import static com.enterprisex.curf.engine.ReportIT.unique;
import static com.enterprisex.curf.engine.ReportIT.viewQuery;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.enterprisex.curf.engine.DbTargets.Target;
import com.enterprisex.curf.engine.application.schedule.ReportMailer.Mail;
import com.enterprisex.curf.engine.application.schedule.ScheduleRepository;
import com.enterprisex.curf.engine.application.schedule.ScheduleRunRepository;
import com.enterprisex.curf.engine.application.schedule.SchedulerService;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

/**
 * Scheduled delivery end to end: a fire happens once however many instances tick, it runs as the person who saved the
 * schedule (their rows, their masks), failures that may pass are retried with growing waits, a run whose instance died
 * is taken over, and a schedule cannot name a recipient outside the allowed domains.
 *
 * <p>The timer is off in these tests; each one calls {@code tick(now)} with a time it chooses. Every test uses its own hour
 * of the day, so one test's tick never fires another test's schedule, and removes its schedule when done.
 */
@EngineIT
class SchedulerIT extends ApiSupport {

    static final String SRC = "com.enterprisex.curf.engine.DbTargets#targets";

    @Autowired
    SchedulerService scheduler;

    @Autowired
    TestMailer.Recording mailer;

    @Autowired
    ScheduleRepository schedules;

    @Autowired
    ScheduleRunRepository runRepository;

    // ---------------------------------------------------------------- helpers

    private static Target first() {
        return (Target) DbTargets.targets().findFirst().orElseThrow().get()[0];
    }

    /** Someone who may manage schedules and edit reports, and runs reports as an analyst of agency A001. */
    private static String maker() {
        return person("maker-" + UUID.randomUUID(), "A001", "curf-developer", "analyst");
    }

    private String text(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private int status(MvcResult r) {
        return r.getResponse().getStatus();
    }

    private String reportFor(Target t, String token) throws Exception {
        String view = createView(viewBody(connection(t)), true);
        Map<String, Object> d = definition(unique("scheduled"), List.of(), List.of(viewQuery("ds_rows", view, req(
                "columns", List.of("id", "agency_code", "name", "email"), "orderBy", List.of(req("column", "id", "descending", false))))),
                List.of(block("b_table", "table", req("queryId", "ds_rows", "title", "รายชื่อ"))));
        MvcResult r = call(post("/engine/v1/reports"), token, saved(d, "runRoles", List.of("analyst")));
        assertThat(status(r)).as(text(r)).isEqualTo(201);
        String id = body(r).get("id").asString();
        publishReport(id);
        return id;
    }

    private Map<String, Object> schedule(String report, int hour, String... recipients) {
        return req("reportId", report, "name", unique("schedule"), "cron", "0 " + hour + " * * *", "timezone", "UTC", "format", "CSV",
                "locale", "en", "recipients", List.of(recipients));
    }

    private JsonNode createSchedule(String token, Map<String, Object> body) throws Exception {
        MvcResult r = call(post("/engine/v1/schedules"), token, body);
        assertThat(status(r)).as(text(r)).isEqualTo(201);
        return body(r);
    }

    private JsonNode runsOf(String token, String schedule) throws Exception {
        MvcResult r = call(get("/engine/v1/schedules/" + schedule + "/runs"), token, null);
        assertThat(status(r)).as(text(r)).isEqualTo(200);
        return body(r);
    }

    private static String address(String prefix) {
        return prefix + "-" + UUID.randomUUID().toString().substring(0, 8) + "@example.test";
    }

    private void remove(String token, String schedule) throws Exception {
        call(delete("/engine/v1/schedules/" + schedule), token, null);
    }

    // ---------------------------------------------------------------- firing

    @ParameterizedTest(name = "{0}: a schedule fires at its time, once, as the person who saved it")
    @MethodSource(SRC)
    void firesOnceAsTheMaker(Target t) throws Exception {
        String me = maker();
        String report = reportFor(t, me);
        String to = address("one");
        JsonNode created = createSchedule(me, schedule(report, 3, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        try {
            assertThat(due).isAfter(Instant.now());
            assertThat(created.get("runAs").asString()).as("shown by subject only").doesNotContain("curf-developer");

            scheduler.tick(due.minusSeconds(1));
            assertThat(runsOf(me, id)).as("not due yet").isEmpty();
            assertThat(mailer.sentTo(to)).isEmpty();

            scheduler.tick(due);
            JsonNode runs = runsOf(me, id);
            assertThat(runs).hasSize(1);
            assertThat(runs.get(0).get("state").asString()).as(text(call(get("/engine/v1/schedules/" + id + "/runs"), me, null))).isEqualTo("SUCCEEDED");
            assertThat(runs.get(0).get("deliveredTo").asInt()).isEqualTo(1);
            assertThat(runs.get(0).get("exportId").asString()).isNotBlank();

            List<Mail> mails = mailer.sentTo(to);
            assertThat(mails).hasSize(1);
            Mail mail = mails.get(0);
            assertThat(mail.attachmentName()).endsWith(".csv");
            assertThat(mail.contentType()).startsWith("text/csv");
            String csv = new String(mail.attachment(), StandardCharsets.UTF_8);
            // Run as the maker: their agency's rows only, personal data masked, exactly as if they had run it.
            assertThat(csv).contains("Somchai", "A001").doesNotContain("Pim", "A002", "B001");
            assertThat(csv).doesNotContain("somchai@a001.go.th");
            assertThat(mail.text()).contains("SHA-256");

            // The next fire moved on, and the same instant never fires twice.
            assertThat(Instant.parse(body(call(get("/engine/v1/schedules/" + id), me, null)).get("nextRunAt").asString())).isEqualTo(due.plus(Duration.ofDays(1)));
            scheduler.tick(due);
            scheduler.tick(due.plusSeconds(30));
            assertThat(runsOf(me, id)).hasSize(1);
            assertThat(mailer.sentTo(to)).hasSize(1);
        } finally {
            remove(me, id);
        }
    }

    @Test
    void severalInstancesTickingTogetherFireOnce() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String to = address("race");
        JsonNode created = createSchedule(me, schedule(report, 4, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            CountDownLatch go = new CountDownLatch(1);
            List<Future<Integer>> ticks = new ArrayList<>();
            for (int i = 0; i < 8; i++) {
                ticks.add(pool.submit(() -> {
                    go.await();
                    return scheduler.tick(due);
                }));
            }
            go.countDown();
            for (Future<Integer> f : ticks) {
                f.get();
            }
            assertThat(runsOf(me, id)).as("one run for one fire").hasSize(1);
            assertThat(mailer.sentTo(to)).as("one delivery").hasSize(1);
        } finally {
            pool.shutdownNow();
            remove(me, id);
        }
    }

    @Test
    void anEngineThatWasDownRunsASchedulePastDueOnceNotOncePerMissedFire() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String to = address("missed");
        JsonNode created = createSchedule(me, schedule(report, 5, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        try {
            Instant fiveDaysLater = due.plus(Duration.ofDays(5)).plusSeconds(60);
            scheduler.tick(fiveDaysLater);
            assertThat(runsOf(me, id)).hasSize(1);
            assertThat(mailer.sentTo(to)).hasSize(1);
            assertThat(Instant.parse(body(call(get("/engine/v1/schedules/" + id), me, null)).get("nextRunAt").asString()))
                    .isEqualTo(due.plus(Duration.ofDays(6)));
        } finally {
            remove(me, id);
        }
    }

    // ---------------------------------------------------------------- failures

    @Test
    void aFailureThatMayPassIsRetriedWithGrowingWaitsUntilItWorks() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String to = address("retry");
        mailer.failFor(to, 2, true);
        JsonNode created = createSchedule(me, schedule(report, 6, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        try {
            scheduler.tick(due);
            JsonNode first = runsOf(me, id).get(0);
            assertThat(first.get("state").asString()).isEqualTo("RETRY");
            assertThat(first.get("attempt").asInt()).isEqualTo(1);
            assertThat(first.get("error").asString()).contains("mail server");
            assertThat(Instant.parse(first.get("nextAttemptAt").asString())).as("one minute for the first retry").isEqualTo(due.plus(Duration.ofMinutes(1)));

            scheduler.tick(due.plusSeconds(30));
            assertThat(runsOf(me, id).get(0).get("attempt").asInt()).as("too early").isEqualTo(1);

            scheduler.tick(due.plus(Duration.ofMinutes(1)));
            JsonNode second = runsOf(me, id).get(0);
            assertThat(second.get("state").asString()).isEqualTo("RETRY");
            assertThat(second.get("attempt").asInt()).isEqualTo(2);
            assertThat(Instant.parse(second.get("nextAttemptAt").asString())).as("then twice as long").isEqualTo(due.plus(Duration.ofMinutes(3)));

            scheduler.tick(due.plus(Duration.ofMinutes(3)));
            JsonNode third = runsOf(me, id);
            assertThat(third).hasSize(1);
            assertThat(third.get(0).get("state").asString()).isEqualTo("SUCCEEDED");
            assertThat(third.get(0).get("attempt").asInt()).isEqualTo(3);
            assertThat(mailer.sentTo(to)).hasSize(1);
        } finally {
            remove(me, id);
        }
    }

    @Test
    void aRunThatKeepsFailingGivesUpAfterTheAttemptLimit() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String to = address("giveup");
        mailer.failFor(to, 100, true);
        JsonNode created = createSchedule(me, schedule(report, 7, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        try {
            scheduler.tick(due);
            scheduler.tick(due.plus(Duration.ofMinutes(1)));
            scheduler.tick(due.plus(Duration.ofMinutes(3)));
            JsonNode run = runsOf(me, id).get(0);
            assertThat(run.get("state").asString()).isEqualTo("FAILED");
            assertThat(run.get("attempt").asInt()).isEqualTo(3);
            scheduler.tick(due.plus(Duration.ofHours(2)));
            assertThat(runsOf(me, id).get(0).get("state").asString()).as("failed is final").isEqualTo("FAILED");
            assertThat(mailer.sentTo(to)).isEmpty();
        } finally {
            mailer.failFor(to, 0, true);
            remove(me, id);
        }
    }

    @Test
    void aFailureNoRetryCanFixFailsAtOnce() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String to = address("fatal");
        mailer.failFor(to, 1, false);
        JsonNode created = createSchedule(me, schedule(report, 8, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        try {
            scheduler.tick(due);
            JsonNode run = runsOf(me, id).get(0);
            assertThat(run.get("state").asString()).isEqualTo("FAILED");
            assertThat(run.get("attempt").asInt()).isEqualTo(1);
        } finally {
            remove(me, id);
        }
    }

    @Test
    void aRunWhoseInstanceDiedIsTakenOverWhenItsLeaseEnds() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String to = address("crash");
        JsonNode created = createSchedule(me, schedule(report, 9, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        try {
            // Another instance claimed the fire, then died: its run is RUNNING with a lease and nobody finishes it.
            var schedule = schedules.find(TENANT, UUID.fromString(id)).orElseThrow();
            assertThat(runRepository.claimFire(schedule, due, due.plus(Duration.ofDays(1)), "instance-that-died", due.plus(Duration.ofMinutes(10)), due))
                    .isPresent();
            assertThat(runsOf(me, id).get(0).get("state").asString()).isEqualTo("RUNNING");

            scheduler.tick(due.plus(Duration.ofMinutes(5)));
            assertThat(runsOf(me, id).get(0).get("attempt").asInt()).as("lease still held").isEqualTo(1);
            assertThat(mailer.sentTo(to)).isEmpty();

            scheduler.tick(due.plus(Duration.ofMinutes(11)));
            JsonNode run = runsOf(me, id).get(0);
            assertThat(run.get("state").asString()).isEqualTo("SUCCEEDED");
            assertThat(run.get("attempt").asInt()).isEqualTo(2);
            assertThat(mailer.sentTo(to)).hasSize(1);
        } finally {
            remove(me, id);
        }
    }

    // ---------------------------------------------------------------- managing

    @Test
    void savingAgainRunsAsTheNewPersonAndCanSwitchItOff() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String to = address("update");
        JsonNode created = createSchedule(me, schedule(report, 10, to));
        String id = created.get("id").asString();
        Instant due = Instant.parse(created.get("nextRunAt").asString());
        try {
            String other = TestIdp.bearerWith(TENANT, "other-maker", Map.of("agency_code", "A002"), "curf-developer", "analyst");
            Map<String, Object> changed = schedule(report, 10, to);
            MvcResult updated = call(put("/engine/v1/schedules/" + id), other, changed);
            assertThat(status(updated)).as(text(updated)).isEqualTo(200);
            assertThat(body(updated).get("runAs").asString()).isEqualTo("other-maker");
            assertThat(body(updated).get("createdBy").asString()).as("creation is not rewritten").isEqualTo(created.get("createdBy").asString());

            scheduler.tick(due);
            String csv = new String(mailer.sentTo(to).get(0).attachment(), StandardCharsets.UTF_8);
            assertThat(csv).as("now runs as an A002 person").contains("Pim").doesNotContain("Somchai");

            changed.put("enabled", false);
            MvcResult off = call(put("/engine/v1/schedules/" + id), me, changed);
            assertThat(body(off).get("nextRunAt").isNull()).isTrue();
            scheduler.tick(due.plus(Duration.ofDays(3)));
            assertThat(runsOf(me, id)).as("a switched-off schedule does not fire").hasSize(1);
        } finally {
            remove(me, id);
        }
    }

    @Test
    void schedulesAreValidated() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        String ok = address("valid");

        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "cron", "0 0 11 * * *")))).as("six fields").isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "cron", "@daily")))).isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "cron", "*/1 * * * *")))).as("every minute is too often").isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "cron", "0 25 * * *")))).isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "timezone", "Mars/Olympus")))).isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "locale", "fr")))).isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "format", null)))).isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "params", Map.of("nope", "x"))))).as("unknown report parameter").isEqualTo(422);
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "recipients", List.of())))).isEqualTo(422);

        MvcResult outside = call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "recipients", List.of("someone@elsewhere.example")));
        assertThat(status(outside)).isEqualTo(422);
        assertThat(text(outside)).contains("not an allowed recipient domain");
        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "recipients", List.of("a@example.test\r\nBcc: x@evil.test"))))).as("header injection").isEqualTo(422);
        MvcResult sub = call(post("/engine/v1/schedules"), me, with(schedule(report, 11, ok), "recipients", List.of("a@sub.example.test")));
        assertThat(status(sub)).as("a subdomain of an allowed domain").isEqualTo(201);
        remove(me, body(sub).get("id").asString());

        assertThat(status(call(post("/engine/v1/schedules"), me, with(schedule(UUID.randomUUID().toString(), 11, ok), "name", "x")))).as("no such report").isEqualTo(404);
        assertThat(status(call(post("/engine/v1/schedules"), person("viewer-" + UUID.randomUUID(), "A001", "curf-viewer"), schedule(report, 11, ok)))).isEqualTo(403);
        assertThat(status(call(get("/engine/v1/schedules"), person("viewer-" + UUID.randomUUID(), "A001", "curf-viewer"), null))).isEqualTo(403);
    }

    @Test
    void aPersonWhoCannotRunTheReportCannotScheduleIt() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        // A developer holds schedule:manage and report:edit, so give someone who has neither a way to reach it: none.
        String stranger = TestIdp.bearerWith("other-tenant", "stranger", Map.of(), "curf-developer");
        assertThat(status(call(post("/engine/v1/schedules"), stranger, schedule(report, 12, address("x"))))).isEqualTo(404);
    }

    @Test
    void schedulesBelongToTheirWorkspaceAndCanBeDeleted() throws Exception {
        String me = maker();
        String report = reportFor(first(), me);
        JsonNode created = createSchedule(me, schedule(report, 13, address("tenant")));
        String id = created.get("id").asString();
        String stranger = TestIdp.bearerWith("other-tenant", "stranger", Map.of(), "curf-developer");

        assertThat(status(call(get("/engine/v1/schedules/" + id), stranger, null))).isEqualTo(404);
        assertThat(status(call(get("/engine/v1/schedules/" + id + "/runs"), stranger, null))).isEqualTo(404);
        assertThat(status(call(put("/engine/v1/schedules/" + id), stranger, schedule(report, 13, address("x"))))).isEqualTo(404);
        assertThat(status(call(delete("/engine/v1/schedules/" + id), stranger, null))).isEqualTo(404);
        assertThat(text(call(get("/engine/v1/schedules"), me, null))).contains(id);
        assertThat(text(call(get("/engine/v1/schedules"), stranger, null))).doesNotContain(id);

        assertThat(status(call(delete("/engine/v1/schedules/" + id), me, null))).isEqualTo(204);
        assertThat(status(call(get("/engine/v1/schedules/" + id), me, null))).isEqualTo(404);
        assertThat(status(call(get("/engine/v1/schedules/" + id + "/runs"), me, null))).isEqualTo(404);
    }

    private static Map<String, Object> with(Map<String, Object> body, String key, Object value) {
        Map<String, Object> m = new java.util.LinkedHashMap<>(body);
        m.put(key, value);
        return m;
    }
}
