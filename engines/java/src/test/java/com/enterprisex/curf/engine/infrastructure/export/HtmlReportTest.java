package com.enterprisex.curf.engine.infrastructure.export;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.application.export.ExportFixtures;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.application.export.ExportModel.Source;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class HtmlReportTest {

    private static Document hostile() {
        Column c = new Column("v", "<img src=x onerror=alert(1)>", "string", null, "none");
        Section s = new Section("1", "</title><script>alert(1)</script>", "q", List.of(c),
                List.of(Map.of("v", "\"><script>fetch('http://evil')</script>"), Map.of("v", "a & b < c")), false, null);
        Section down = new Section("2", "Down", "q2", List.of(c), List.of(), false, "<b>boom</b>");
        return new Document("<script>alert('t')</script>", "en", new CellFormats.Style("en", false), "THB", "x", 1,
                Map.of("p", "<i>v</i>"), List.of(s, down), List.of(new Source("q", "<q>", "h", "d", 2, "<n>")));
    }

    @Test
    void nothingInTheDataCanBecomeMarkup() {
        String html = HtmlReport.page(hostile());

        assertThat(html).doesNotContain("<script>alert").doesNotContain("<img src").doesNotContain("<b>boom").doesNotContain("<i>v</i>")
                .doesNotContain("<q>").doesNotContain("<n>");
        assertThat(html).contains("&lt;script&gt;alert(1)&lt;/script&gt;").contains("a &amp; b &lt; c").contains("&quot;&gt;&lt;script&gt;");
        // The only script-like text left is escaped text; there is no real script element.
        assertThat(html.replaceAll("(?s)<style>.*?</style>", "")).doesNotContainPattern("<script");
    }

    @Test
    void aContentSecurityPolicyForbidsEveryRequest() {
        String html = HtmlReport.page(ExportFixtures.document("th", true));
        assertThat(html).contains("Content-Security-Policy").contains("default-src 'none'").contains("font-src data:")
                .doesNotContain("src=\"http").doesNotContain("href=\"http").doesNotContain("@import");
    }

    @Test
    void theThaiFontIsEmbeddedSoPrintingNeedsNoFontOnTheMachine() {
        String html = HtmlReport.page(ExportFixtures.document("th", true));
        assertThat(html).contains("@font-face{font-family:'Sarabun';font-weight:400;src:url(data:font/ttf;base64,")
                .contains("font-weight:700");
        assertThat(html.length()).as("two embedded fonts").isGreaterThan(200_000);
    }

    @Test
    void showsValuesInTheReadersLanguageAndCalendar() {
        String html = HtmlReport.page(ExportFixtures.document("th", true));
        assertThat(html).contains("<html lang=\"th\">").contains("ข้อมูล ณ 2026-10-05T01:02:03.456Z").contains("10 ม.ค. 2569")
                .contains("฿48,500,000.50").contains("<td class=\"n\">฿48,500,000.50</td>").contains("<tr class=\"total\">").contains("รวม")
                .contains("sha256:aaaaaaaaaaaaaaaaaaaaaaaa");
    }

    @Test
    void theFooterRepeatsTheAsOfTimeAndPageNumbers() {
        String footer = HtmlReport.footer(ExportFixtures.document("th", true));
        assertThat(footer).contains("class=\"pageNumber\"").contains("class=\"totalPages\"").contains("ข้อมูล ณ 2026-10-05T01:02:03.456Z")
                .contains("หน้า").contains("จาก").contains("@font-face");
    }

    @Test
    void wideTablesPrintLandscape() {
        assertThat(HtmlReport.landscape(ExportFixtures.document("th", true))).isFalse();
        List<Column> wide = java.util.stream.IntStream.range(0, 8).mapToObj(i -> new Column("c" + i, "C" + i, "string", null, "none")).toList();
        Document doc = new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(),
                List.of(new Section("1", "W", "q", wide, List.of(), false, null)), List.of());
        assertThat(HtmlReport.landscape(doc)).isTrue();
    }
}
