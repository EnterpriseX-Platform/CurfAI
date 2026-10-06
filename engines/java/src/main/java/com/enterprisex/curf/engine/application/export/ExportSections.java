package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.application.export.ExportModel.Source;
import com.enterprisex.curf.engine.application.report.ProvenanceRecord;
import com.enterprisex.curf.engine.application.report.RunResult;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.JsonNode;

/**
 * Builds what a file contains from a report's definition and its run. One section per table block, in page
 * order, with the block's own column labels, types, formats and totals setting; when a report has no table
 * block, one section per query. Mirrors Curf's CSV exporter, which writes the first table block or a named one.
 */
final class ExportSections {

    private ExportSections() {}

    static Document build(String title, JsonNode definition, RunResult run, String locale, CellFormats.Style style, String currency) {
        List<Section> sections = new ArrayList<>();
        Set<String> used = new LinkedHashSet<>();

        for (JsonNode page : definition.path("pages")) {
            for (JsonNode block : page.path("blocks")) {
                if (!"table".equals(block.path("type").asString(""))) {
                    continue;
                }
                JsonNode config = block.path("config");
                String queryId = config.path("queryId").asString("");
                if (!run.dataset().containsKey(queryId) && !run.provenance().containsKey(queryId)) {
                    continue; // drill-only or unknown: not part of this run
                }
                used.add(queryId);
                String blockTitle = config.path("title").asString("");
                sections.add(section(block.path("id").asString(""), blockTitle.isBlank() ? queryName(run, queryId) : blockTitle,
                        queryId, columns(config.path("columns"), run.dataset().get(queryId)), run, config.path("showTotals").asBoolean(true)));
            }
        }
        if (sections.isEmpty()) {
            for (String queryId : run.dataset().keySet()) {
                sections.add(section("", queryName(run, queryId), queryId, columns(null, run.dataset().get(queryId)), run, false));
            }
        }

        List<Source> sources = new ArrayList<>();
        run.provenance().forEach((queryId, p) -> sources.add(new Source(
                queryId, p.queryName(), p.queryHash(), p.dataHash(), p.rowCount(),
                p.executionError() != null ? p.executionError() : p.accessDeniedNote())));

        return new Document(title, locale, style, currency, run.asOf(), run.reportVersion(), run.params(), sections, sources);
    }

    private static Section section(String blockId, String title, String queryId, List<Column> columns, RunResult run, boolean showTotals) {
        ProvenanceRecord p = run.provenance().get(queryId);
        String unavailable = p == null ? null : p.executionError() != null ? p.executionError() : p.accessDeniedNote();
        List<Map<String, Object>> rows = unavailable != null ? List.of() : run.dataset().getOrDefault(queryId, List.of());
        return new Section(blockId, title, queryId, columns, rows, showTotals, unavailable);
    }

    private static String queryName(RunResult run, String queryId) {
        ProvenanceRecord p = run.provenance().get(queryId);
        return p == null || p.queryName() == null ? queryId : p.queryName();
    }

    /** The block's declared columns; when it declares none, every key of the first row, in order. */
    private static List<Column> columns(JsonNode declared, List<Map<String, Object>> rows) {
        List<Column> out = new ArrayList<>();
        if (declared != null && declared.isArray() && !declared.isEmpty()) {
            for (JsonNode c : declared) {
                String key = c.path("key").asString("");
                out.add(new Column(key, c.path("label").asString(key), c.path("type").asString("string"),
                        c.path("format").isString() ? c.path("format").asString() : null, c.path("total").asString("none")));
            }
            return out;
        }
        Map<String, Object> first = rows == null || rows.isEmpty() ? new LinkedHashMap<>() : rows.get(0);
        first.forEach((key, value) -> out.add(new Column(key, key, value instanceof Number ? "number" : "string", null, "none")));
        return out;
    }
}
