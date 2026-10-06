package com.enterprisex.curf.engine.domain.report;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.report.ReportParameter.Type;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ReportParamsTest {

    private static ReportParameter p(String name, Type type, boolean required, Object fallback, String... options) {
        return new ReportParameter(name, name, type, required, fallback, List.of(options));
    }

    private static final List<ReportParameter> DECLARED = List.of(
            p("from", Type.DATE, false, "2026-01-01"),
            p("min", Type.NUMBER, false, 0),
            p("active", Type.BOOLEAN, false, null),
            p("region", Type.SELECT, false, null, "north", "south"),
            p("note", Type.STRING, false, null),
            p("period", Type.DATE_RANGE, false, null));

    @Test
    void everyDeclaredParameterIsAlwaysBoundWithItsDefaultOrAnEmptyString() {
        Map<String, Object> out = ReportParams.resolve(DECLARED, Map.of());

        assertThat(out).containsExactly(
                Map.entry("from", "2026-01-01"), Map.entry("min", 0), Map.entry("active", ""), Map.entry("region", ""),
                Map.entry("note", ""), Map.entry("period", ""));
    }

    @Test
    void anEmptySuppliedValueMeansTheDefaultToo() {
        assertThat(ReportParams.resolve(DECLARED, Map.of("from", "", "min", "")).get("from")).isEqualTo("2026-01-01");
    }

    @Test
    void suppliedValuesAreConvertedToTheirType() {
        Map<String, Object> out = ReportParams.resolve(DECLARED, Map.of(
                "from", "2026-02-15", "min", "12.5", "active", "true", "region", "north", "note", "ก", "period", "2026-01-01..2026-03-31"));

        assertThat(out).containsEntry("from", "2026-02-15").containsEntry("min", 12.5).containsEntry("active", true)
                .containsEntry("region", "north").containsEntry("note", "ก").containsEntry("period", "2026-01-01..2026-03-31");
        assertThat(ReportParams.resolve(DECLARED, Map.of("min", "7")).get("min")).as("a whole number stays whole").isEqualTo(7L);
        assertThat(ReportParams.resolve(DECLARED, Map.of("min", 7.0)).get("min")).isEqualTo(7L);
    }

    @Test
    void aDefaultIsUsedAsIsAndNeverCoerced() {
        var declared = List.of(p("n", Type.STRING, false, 5));
        assertThat(ReportParams.resolve(declared, Map.of()).get("n")).isEqualTo(5);
    }

    @Test
    void valuesThatCannotBeWhatTheParameterSaysAreRefused() {
        for (Map<String, Object> bad : List.<Map<String, Object>>of(
                Map.of("min", "abc"), Map.of("min", "1e999"), Map.of("active", "yes"), Map.of("from", "31/01/2026"),
                Map.of("from", "2026-02-30"), Map.of("region", "east"), Map.of("note", List.of("x")),
                Map.of("note", "x".repeat(2001)), Map.of("typo", "x"))) {
            assertThatThrownBy(() -> ReportParams.resolve(DECLARED, bad)).as(bad.toString()).isInstanceOf(EngineException.class);
        }
    }

    @Test
    void aRequiredParameterNeedsAValueOrADefault() {
        var declared = List.of(p("site", Type.STRING, true, null), p("year", Type.NUMBER, true, 2026));
        assertThatThrownBy(() -> ReportParams.resolve(declared, Map.of())).isInstanceOf(EngineException.class)
                .satisfies(e -> assertThat(((EngineException) e).errors().get(0).field()).isEqualTo("params.site"));
        assertThat(ReportParams.resolve(declared, Map.of("site", "A")).get("year")).isEqualTo(2026);
    }

    @Test
    void everyProblemIsReportedAtOnce() {
        assertThatThrownBy(() -> ReportParams.resolve(DECLARED, Map.of("min", "abc", "from", "nope", "typo", "x")))
                .isInstanceOfSatisfying(EngineException.class, e -> assertThat(e.errors()).hasSize(3));
    }
}
