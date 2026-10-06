package com.enterprisex.curf.engine.application.export;

import static com.enterprisex.curf.engine.application.export.ExportFixtures.row;
import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.report.ProvenanceRecord;
import com.enterprisex.curf.engine.application.report.RunResult;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

class ExportSectionsTest {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final CellFormats.Style STYLE = new CellFormats.Style("th", true);

    private static JsonNode def(String json) {
        return JSON.readTree(json);
    }

    private static ProvenanceRecord prov(String id, String name, String denied, String error) {
        return new ProvenanceRecord(id, name, "sha256:q", "t", 1, 2, "sha256:d", "src", "postgres", denied, error, null);
    }

    private static RunResult run(Map<String, List<Map<String, Object>>> data, Map<String, ProvenanceRecord> provenance) {
        return new RunResult(data, provenance, Map.of("from", "2026-01-01"), 7, "2026-10-05T00:00:00.000Z");
    }

    @Test
    void oneSectionPerTableBlockInPageOrderWithTheBlocksOwnColumns() {
        JsonNode d = def("""
                {"pages":[
                  {"blocks":[
                    {"id":"b1","type":"title","config":{"text":"x"}},
                    {"id":"b2","type":"table","config":{"queryId":"q2","title":"Second","showTotals":false,
                       "columns":[{"key":"a","label":"แถว A","type":"number","total":"sum"},{"key":"d","label":"วัน","type":"date","format":"dd/MM/yyyy"}]}}]},
                  {"blocks":[{"id":"b3","type":"table","config":{"queryId":"q1","columns":[]}},
                             {"id":"b4","type":"chart","config":{"queryId":"q1"}}]}]}""");
        Document doc = ExportSections.build("R", d, run(
                Map.of("q1", List.of(row("x", 1, "y", "t")), "q2", List.of(row("a", 5, "d", "2026-01-10"))),
                Map.of("q1", prov("q1", "First query", null, null), "q2", prov("q2", "Q two", null, null))), "th", STYLE, "THB");

        assertThat(doc.sections()).hasSize(2);
        var first = doc.sections().get(0);
        assertThat(first.blockId()).isEqualTo("b2");
        assertThat(first.title()).isEqualTo("Second");
        assertThat(first.showTotals()).isFalse();
        assertThat(first.columns()).extracting(c -> c.label()).containsExactly("แถว A", "วัน");
        assertThat(first.columns().get(1).format()).isEqualTo("dd/MM/yyyy");
        assertThat(first.columns().get(0).total()).isEqualTo("sum");

        var second = doc.sections().get(1);
        assertThat(second.title()).as("no title: the query's name").isEqualTo("First query");
        assertThat(second.columns()).as("no columns declared: the first row's keys").extracting(c -> c.key()).containsExactly("x", "y");
        assertThat(second.columns().get(0).type()).isEqualTo("number");
        assertThat(second.columns().get(1).type()).isEqualTo("string");
        assertThat(second.showTotals()).isTrue();
    }

    @Test
    void aReportWithNoTableGetsOneSectionPerQuery() {
        Document doc = ExportSections.build("R", def("{\"pages\":[{\"blocks\":[{\"id\":\"c\",\"type\":\"chart\",\"config\":{\"queryId\":\"q1\"}}]}]}"),
                run(Map.of("q1", List.of(row("k", 1))), Map.of("q1", prov("q1", "Chart data", null, null))), "en", STYLE, "THB");

        assertThat(doc.sections()).singleElement().satisfies(s -> {
            assertThat(s.title()).isEqualTo("Chart data");
            assertThat(s.blockId()).isEmpty();
            assertThat(s.showTotals()).isFalse();
        });
    }

    @Test
    void aQueryThatDidNotRunBecomesAnUnavailableSectionNotAnEmptyOne() {
        Map<String, List<Map<String, Object>>> data = new LinkedHashMap<>();
        data.put("bad", List.of());
        data.put("denied", List.of());
        Document doc = ExportSections.build("R", def("""
                {"pages":[{"blocks":[{"id":"1","type":"table","config":{"queryId":"bad"}},{"id":"2","type":"table","config":{"queryId":"denied"}}]}]}"""),
                run(data, Map.of("bad", prov("bad", "Bad", null, "relation does not exist"), "denied", prov("denied", "Denied", "no access", null))),
                "en", STYLE, "THB");

        assertThat(doc.sections().get(0).unavailable()).isEqualTo("relation does not exist");
        assertThat(doc.sections().get(1).unavailable()).isEqualTo("no access");
        assertThat(doc.sources()).extracting(s -> s.note()).containsExactlyInAnyOrder("relation does not exist", "no access");
    }

    @Test
    void aTableOnAQueryThatWasNotRunWithTheReportIsLeftOut() {
        Document doc = ExportSections.build("R", def("""
                {"pages":[{"blocks":[{"id":"1","type":"table","config":{"queryId":"drill_only"}},{"id":"2","type":"table","config":{"queryId":"main"}}]}]}"""),
                run(Map.of("main", List.of(row("a", 1))), Map.of("main", prov("main", "Main", null, null))), "en", STYLE, "THB");

        assertThat(doc.sections()).singleElement().extracting(s -> s.queryId()).isEqualTo("main");
    }

    @Test
    void carriesTheRunsDetailsIntoTheDocument() {
        Document doc = ExportSections.build("Report name", def("{\"pages\":[{\"blocks\":[]}]}"), run(Map.of(), Map.of()), "th", STYLE, "usd");
        assertThat(doc.title()).isEqualTo("Report name");
        assertThat(doc.asOf()).isEqualTo("2026-10-05T00:00:00.000Z");
        assertThat(doc.reportVersion()).isEqualTo(7);
        assertThat(doc.params()).containsEntry("from", "2026-01-01");
        assertThat(doc.currency()).isEqualTo("usd");
    }
}
