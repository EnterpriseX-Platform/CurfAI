package com.enterprisex.curf.engine.infrastructure.export;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.application.export.ExportFixtures;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Options;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class CsvFileRendererTest {

    private final CsvFileRenderer renderer = new CsvFileRenderer();

    private String render(Document doc) {
        byte[] bytes = renderer.render(doc, new Options(null, "TH Sarabun New"));
        assertThat(bytes).startsWith(0xEF, 0xBB, 0xBF);
        return new String(bytes, 3, bytes.length - 3, StandardCharsets.UTF_8);
    }

    @Test
    void writesAByteOrderMarkCrlfLinesAndMachineReadableValues() {
        String csv = render(ExportFixtures.document("th", true));
        String[] lines = csv.split("\r\n", -1);

        assertThat(lines[0]).isEqualTo("ชื่อหน่วยงาน,จำนวนเงิน,อัตรา,วันที่,หมายเหตุ");
        assertThat(lines[1]).isEqualTo("สำนักงานตรวจเงินแผ่นดิน,48500000.50,0.153,2026-01-10,ที่อยู่ เชียงใหม่");
        assertThat(lines[2]).as("a number is plain, an ISO timestamp is a date").contains(",1500,0.2,2026-02-20,");
        assertThat(lines[3]).as("absent is empty, never zero or the word null").endsWith(",-25.25,,,-x".replace("-x", "'-x"));
        assertThat(lines[4]).isEmpty();
        assertThat(csv).doesNotContain("฿").doesNotContain("2569").doesNotContain("null");
    }

    @ParameterizedTest(name = "text {0} cannot run as a formula")
    @CsvSource(delimiter = '|', value = {"=1+1", "+SUM(A1)", "-2+3", "@cmd", "=HYPERLINK(\"http://x\")"})
    void textThatLooksLikeAFormulaIsDefused(String value) {
        Section s = new Section("b", "t", "q", List.of(new Column("v", "v", "string", null, "none")), List.of(Map.of("v", value)), false, null);
        String csv = render(doc(s));
        String line = csv.split("\r\n")[1];
        String first = line.startsWith("\"") ? line.substring(1) : line; // a value with quotes is itself quoted
        assertThat(first).startsWith("'").doesNotStartWith("=").doesNotStartWith("+").doesNotStartWith("@");
        assertThat(first.replace("\"", "")).contains(value.replace("\"", ""));
    }

    @Test
    void tabsAndCarriageReturnsAreDefusedToo() {
        assertThat(CsvFileRenderer.field("\tcmd", true)).startsWith("'");
        assertThat(CsvFileRenderer.field("\rcmd", true)).startsWith("\"'");
    }

    @Test
    void aNegativeNumberIsDataNotAFormula() {
        Section s = new Section("b", "t", "q", List.of(new Column("v", "v", "number", null, "none")), List.of(Map.of("v", -5), Map.of("v", "-2.5")), false, null);
        assertThat(render(doc(s))).isEqualTo("v\r\n-5\r\n-2.5\r\n");
    }

    @Test
    void headersAreDefusedToo() {
        Section s = new Section("b", "t", "q", List.of(new Column("v", "=evil", "string", null, "none")), List.of(), false, null);
        assertThat(render(doc(s))).startsWith("'=evil");
    }

    @Test
    void quotesCommasAndNewlinesFollowRfc4180() {
        Section s = new Section("b", "t", "q", List.of(new Column("v", "a,b", "string", null, "none")),
                List.of(Map.of("v", "say \"hi\", ok"), Map.of("v", "two\nlines"), Map.of("v", "plain")), false, null);
        assertThat(render(doc(s))).isEqualTo("\"a,b\"\r\n\"say \"\"hi\"\", ok\"\r\n\"two\nlines\"\r\nplain\r\n");
    }

    @Test
    void writesTheChosenTableAndNoTotals() {
        Section a = new Section("b1", "A", "qa", List.of(new Column("v", "A", "number", null, "sum")), List.of(Map.of("v", 1)), true, null);
        Section b = new Section("b2", "B", "qb", List.of(new Column("v", "B", "number", null, "sum")), List.of(Map.of("v", 2)), true, null);
        Document doc = new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(), List.of(a, b), List.of());

        assertThat(new String(renderer.render(doc, new Options("b2", "f")), StandardCharsets.UTF_8)).endsWith("B\r\n2\r\n");
        assertThat(new String(renderer.render(doc, new Options(null, "f")), StandardCharsets.UTF_8)).endsWith("A\r\n1\r\n");
    }

    private static Document doc(Section s) {
        return new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(), List.of(s), List.of());
    }
}
