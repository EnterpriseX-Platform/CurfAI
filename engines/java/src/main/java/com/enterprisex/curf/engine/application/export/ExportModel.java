package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.util.List;
import java.util.Map;

/** What every file format is rendered from: one description of the report's data, already run as the caller. */
public final class ExportModel {

    private ExportModel() {}

    /** {@code type}: string, number, currency, percent, date, datetime (anything else is shown as text). */
    public record Column(String key, String label, String type, String format, String total) {}

    /**
     * One table. {@code unavailable} is set instead of rows when the query did not run (failed, or the viewer may
     * not use its data source); the file then says so rather than looking like an empty result.
     */
    public record Section(
            String blockId, String title, String queryId, List<Column> columns, List<Map<String, Object>> rows,
            boolean showTotals, String unavailable) {}

    /** One query's provenance, written into the file so a reader can tell where the numbers came from. */
    public record Source(String queryId, String queryName, String queryHash, String dataHash, int rowCount, String note) {}

    public record Document(
            String title,
            String locale,
            CellFormats.Style style,
            String currency,
            String asOf,
            int reportVersion,
            Map<String, Object> params,
            List<Section> sections,
            List<Source> sources) {}

    public record Options(String blockId, String font) {}
}
