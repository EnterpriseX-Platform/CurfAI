package com.enterprisex.curf.engine.domain.query;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Runs the shared corpus (engines/conformance/corpus/guard.json) through the guard. */
class SqlGuardCorpusTest {

    private static final JsonNode CORPUS = load();

    private static JsonNode load() {
        try {
            return JsonMapper.builder().build().readTree(
                    Files.readString(Path.of("..", "conformance", "corpus", "guard.json")));
        } catch (Exception e) {
            throw new IllegalStateException("guard corpus not found; run from engines/java", e);
        }
    }

    static Stream<Arguments> rejected() {
        return CORPUS.get("rejected").valueStream()
                .map(n -> Arguments.of(n.get("id").asString(), n.get("sql").asString()));
    }

    static Stream<Arguments> accepted() {
        // The generic text and every dialect variant must all pass the guard.
        List<Arguments> all = new java.util.ArrayList<>();
        for (JsonNode n : CORPUS.get("accepted")) {
            all.add(Arguments.of(n.get("id").asString(), n.get("sql").asString()));
            n.path("variants").properties().forEach(e -> all.add(Arguments.of(n.get("id").asString() + " on " + e.getKey(), e.getValue().asString())));
        }
        return all.stream();
    }

    @ParameterizedTest(name = "rejects {0}")
    @MethodSource("rejected")
    void rejectsAttack(String id, String sql) {
        var verdict = SqlGuard.check(sql);
        assertThat(verdict.accepted()).as("%s should be rejected but ran as: %s", id, verdict.sql()).isFalse();
        assertThat(verdict.rejection()).isNotBlank();
    }

    @ParameterizedTest(name = "accepts {0}")
    @MethodSource("accepted")
    void acceptsHarmlessLookalikes(String id, String sql) {
        var verdict = SqlGuard.check(sql);
        assertThat(verdict.accepted()).as("%s rejected: %s", id, verdict.rejection()).isTrue();
        assertThat(verdict.sql()).isNotBlank();
    }

    @org.junit.jupiter.api.Test
    void whatRunsIsTheRenderedTreeNotTheOriginalText() {
        var verdict = SqlGuard.check("SELECT 1 -- ; DROP TABLE guard_probe");
        assertThat(verdict.sql()).doesNotContain("DROP").doesNotContain("--");
    }

    @org.junit.jupiter.api.Test
    void everyRejectionHasAReasonAndNeverEchoesTheStatement() {
        for (JsonNode n : CORPUS.get("rejected")) {
            var verdict = SqlGuard.check(n.get("sql").asString());
            assertThat(verdict.rejection()).doesNotContain("passwd");
        }
        assertThat(List.of("rejected", "accepted").stream().allMatch(CORPUS::has)).isTrue();
    }
}
