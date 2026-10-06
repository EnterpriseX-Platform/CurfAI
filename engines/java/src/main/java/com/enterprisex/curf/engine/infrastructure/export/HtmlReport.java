package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.export.Cells;
import com.enterprisex.curf.engine.application.export.ExportLabels;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.util.Base64;
import java.util.List;
import java.util.Map;

/**
 * The report as one self-contained HTML page, ready to be printed to PDF by a browser. Everything is inline: the Thai
 * font is embedded (so shaping, stacked vowels and tone marks are right wherever it is printed), there is no script,
 * and a content security policy forbids any request, so nothing in the data can make the printing browser reach out.
 * Every value is escaped.
 */
final class HtmlReport {

    private static final String FONT_FACES = fontFace("Sarabun", "fonts/Sarabun-Regular.ttf", 400)
            + fontFace("Sarabun", "fonts/Sarabun-Bold.ttf", 700);
    private static final int LANDSCAPE_FROM_COLUMNS = 7;

    private HtmlReport() {}

    static boolean landscape(Document doc) {
        return doc.sections().stream().anyMatch(s -> s.columns().size() >= LANDSCAPE_FROM_COLUMNS);
    }

    static String page(Document doc) {
        ExportLabels words = ExportLabels.of(doc.locale());
        StringBuilder sb = new StringBuilder();
        sb.append("<!doctype html><html lang=\"").append(esc(doc.locale())).append("\"><head><meta charset=\"utf-8\">")
                .append("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; font-src data:\">")
                .append("<title>").append(esc(doc.title())).append("</title><style>").append(FONT_FACES).append(CSS).append("</style></head><body>");
        sb.append("<h1>").append(esc(doc.title())).append("</h1>");
        sb.append("<p class=\"meta\">").append(esc(words.get("asOf"))).append(' ').append(esc(doc.asOf()));
        if (!doc.params().isEmpty()) {
            sb.append("<br>").append(esc(words.get("parameters"))).append(": ");
            doc.params().forEach((k, v) -> sb.append(esc(k)).append(" = ").append(esc(String.valueOf(v))).append("&nbsp;&nbsp; "));
        }
        sb.append("</p>");

        for (Section section : doc.sections()) {
            sb.append("<h2>").append(esc(section.title())).append("</h2>");
            if (section.unavailable() != null) {
                sb.append("<p class=\"note\">").append(esc(words.get("unavailable"))).append(": ").append(esc(section.unavailable())).append("</p>");
                continue;
            }
            table(sb, doc, words, section);
        }

        sb.append("<h2>").append(esc(words.get("sources"))).append("</h2><table class=\"src\"><thead><tr>");
        for (String key : List.of("query", "rows", "queryHash", "dataHash", "note")) {
            sb.append("<th>").append(esc(words.get(key))).append("</th>");
        }
        sb.append("</tr></thead><tbody>");
        for (var src : doc.sources()) {
            sb.append("<tr><td>").append(esc(src.queryName() == null ? src.queryId() : src.queryName())).append("</td><td class=\"n\">")
                    .append(src.rowCount()).append("</td><td class=\"h\">").append(esc(src.queryHash())).append("</td><td class=\"h\">")
                    .append(esc(src.dataHash())).append("</td><td>").append(esc(src.note() == null ? "" : src.note())).append("</td></tr>");
        }
        sb.append("</tbody></table></body></html>");
        return sb.toString();
    }

    /** The page footer the printing browser repeats: as-of time left, page numbers right. */
    static String footer(Document doc) {
        ExportLabels words = ExportLabels.of(doc.locale());
        return "<!doctype html><html lang=\"" + esc(doc.locale()) + "\"><head><meta charset=\"utf-8\"><style>" + FONT_FACES
                + "body{margin:0;font-family:'Sarabun',sans-serif;font-size:8pt;color:#555}"
                + ".f{display:flex;justify-content:space-between;width:100%;padding:0 12mm}</style></head><body><div class=\"f\"><span>"
                + esc(words.get("asOf")) + " " + esc(doc.asOf()) + "</span><span>" + esc(words.get("page"))
                + " <span class=\"pageNumber\"></span> " + esc(words.get("of")) + " <span class=\"totalPages\"></span></span></div></body></html>";
    }

    private static void table(StringBuilder sb, Document doc, ExportLabels words, Section section) {
        List<Column> columns = section.columns();
        sb.append("<table><thead><tr>");
        for (Column c : columns) {
            sb.append("<th>").append(esc(c.label())).append("</th>");
        }
        sb.append("</tr></thead><tbody>");
        if (section.rows().isEmpty()) {
            sb.append("<tr><td class=\"note\" colspan=\"").append(Math.max(1, columns.size())).append("\">").append(esc(words.get("noRows"))).append("</td></tr>");
        }
        for (Map<String, Object> data : section.rows()) {
            sb.append("<tr>");
            for (Column c : columns) {
                Cells.Cell value = Cells.of(c, data.get(c.key()));
                sb.append(value instanceof Cells.Num ? "<td class=\"n\">" : "<td>").append(esc(Cells.display(value, c, doc))).append("</td>");
            }
            sb.append("</tr>");
        }
        if (Cells.hasTotals(section)) {
            List<BigDecimal> totals = Cells.totals(section);
            sb.append("<tr class=\"total\">");
            for (int i = 0; i < columns.size(); i++) {
                String text = totals.get(i) == null ? (i == 0 ? words.get("total") : "") : Cells.display(new Cells.Num(totals.get(i)), columns.get(i), doc);
                sb.append(totals.get(i) != null ? "<td class=\"n\">" : "<td>").append(esc(text)).append("</td>");
            }
            sb.append("</tr>");
        }
        sb.append("</tbody></table>");
    }

    static String esc(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(s.length() + 16);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&' -> out.append("&amp;");
                case '<' -> out.append("&lt;");
                case '>' -> out.append("&gt;");
                case '"' -> out.append("&quot;");
                case '\'' -> out.append("&#39;");
                default -> out.append(c);
            }
        }
        return out.toString();
    }

    private static String fontFace(String family, String resource, int weight) {
        try (InputStream in = HtmlReport.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("Missing font resource " + resource);
            }
            String data = Base64.getEncoder().encodeToString(in.readAllBytes());
            return "@font-face{font-family:'" + family + "';font-weight:" + weight + ";src:url(data:font/ttf;base64," + data + ") format('truetype')}";
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static final String CSS = """
            @page{margin:16mm 12mm 18mm 12mm}
            body{font-family:'Sarabun','Noto Sans Thai','Tahoma',sans-serif;font-size:10.5pt;color:#111;line-height:1.35}
            h1{font-size:18pt;margin:0 0 4pt}
            h2{font-size:13pt;margin:16pt 0 5pt;break-after:avoid}
            .meta{color:#555;font-size:9pt;margin:0 0 8pt}
            .note{color:#666;font-style:italic}
            table{border-collapse:collapse;width:100%;margin-bottom:6pt}
            th,td{border:1px solid #bbb;padding:2.5pt 5pt;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
            th{background:#e8e8e8;text-align:left;font-weight:700}
            thead{display:table-header-group}
            tr{break-inside:avoid}
            td.n{text-align:right;white-space:nowrap}
            td.h{font-family:monospace;font-size:8pt;white-space:nowrap}
            tr.total td{font-weight:700;border-top:2px solid #888}
            table.src th,table.src td{font-size:9pt}
            """;
}
