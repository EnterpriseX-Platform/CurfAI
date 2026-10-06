package com.enterprisex.curf.engine.infrastructure.export;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.application.export.ExportFixtures;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Options;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.junit.jupiter.api.Test;

class DocxFileRendererTest {

    private final DocxFileRenderer renderer = new DocxFileRenderer();

    private XWPFDocument read(Document doc) throws IOException {
        return new XWPFDocument(new ByteArrayInputStream(renderer.render(doc, new Options(null, "TH Sarabun New"))));
    }

    private static List<String> row(XWPFTable table, int r) {
        List<String> out = new ArrayList<>();
        table.getRow(r).getTableCells().forEach(c -> out.add(c.getText()));
        return out;
    }

    @Test
    void holdsTheTitleTheAsOfTimeAndTheParameters() throws IOException {
        try (XWPFDocument docx = read(ExportFixtures.document("th", true))) {
            List<String> paragraphs = docx.getParagraphs().stream().map(p -> p.getText()).toList();
            assertThat(paragraphs).contains("รายงานผลการดำเนินงาน", "ข้อมูล ณ 2026-10-05T01:02:03.456Z", "ตารางสรุป");
            assertThat(paragraphs.stream().filter(p -> p.startsWith("พารามิเตอร์"))).singleElement().asString().contains("from = 2026-01-01").contains("min = 0");
            assertThat(docx.getProperties().getCoreProperties().getTitle()).isEqualTo("รายงานผลการดำเนินงาน");
            assertThat(docx.getProperties().getCustomProperties().getProperty("curf.asOf").getLpwstr()).isEqualTo("2026-10-05T01:02:03.456Z");
            assertThat(docx.getProperties().getCustomProperties().getProperty("curf.dataHash.q1").getLpwstr()).isEqualTo("sha256:bbbbbbbbbbbbbbbbbbbbbbbb");
        }
    }

    @Test
    void theTableShowsValuesTheWayAThaiReaderReadsThem() throws IOException {
        try (XWPFDocument docx = read(ExportFixtures.document("th", true))) {
            XWPFTable table = docx.getTables().get(0);
            assertThat(row(table, 0)).containsExactly("ชื่อหน่วยงาน", "จำนวนเงิน", "อัตรา", "วันที่", "หมายเหตุ");
            assertThat(row(table, 1)).containsExactly("สำนักงานตรวจเงินแผ่นดิน", "฿48,500,000.50", "15.3%", "10 ม.ค. 2569", "ที่อยู่ เชียงใหม่");
            assertThat(row(table, 2)).containsExactly("=1+1", "฿1,500.00", "20.0%", "20 ก.พ. 2569", "+SUM(A1)");
            assertThat(row(table, 3)).containsExactly("@cmd", "-฿25.25", "", "", "-x");
            assertThat(row(table, 4)).as("totals row").containsExactly("รวม", "฿48,501,475.25", "17.7%", "", "");
        }
    }

    @Test
    void englishAndGregorianWhenAsked() throws IOException {
        try (XWPFDocument docx = read(ExportFixtures.document("en", false))) {
            XWPFTable table = docx.getTables().get(0);
            assertThat(row(table, 1).get(3)).isEqualTo("2026-01-10");
            assertThat(row(table, 4).get(0)).isEqualTo("Total");
            assertThat(docx.getParagraphs().stream().map(p -> p.getText())).contains("Data as of 2026-10-05T01:02:03.456Z");
        }
    }

    @Test
    void closesWithWhereTheDataCameFromAndAFooter() throws IOException {
        try (XWPFDocument docx = read(ExportFixtures.document("th", true))) {
            XWPFTable sources = docx.getTables().get(docx.getTables().size() - 1);
            assertThat(row(sources, 0)).containsExactly("ชุดข้อมูล", "แถว", "รหัสคำสั่ง", "รหัสข้อมูล", "หมายเหตุ");
            assertThat(row(sources, 1)).containsExactly("Totals", "3", "sha256:aaaaaaaaaaaaaaaaaaaaaaaa", "sha256:bbbbbbbbbbbbbbbbbbbbbbbb", "");
            assertThat(docx.getFooterList().get(0).getText()).contains("ข้อมูล ณ 2026-10-05T01:02:03.456Z").contains("เวอร์ชัน 3");
        }
    }

    @Test
    void thaiTextGetsThaiFontSettingsSoWordPicksTheRightFont() throws IOException {
        try (XWPFDocument docx = read(ExportFixtures.document("th", true))) {
            String xml = docx.getDocument().xmlText();
            assertThat(xml).contains("w:ascii=\"TH Sarabun New\"").contains("w:cs=\"TH Sarabun New\"").contains("w:eastAsia=\"TH Sarabun New\"");
        }
    }

    @Test
    void wideTablesTurnThePageToLandscape() throws IOException {
        List<Column> wide = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            wide.add(new Column("c" + i, "C" + i, "string", null, "none"));
        }
        Document doc = new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(),
                List.of(new Section("1", "Wide", "q", wide, List.of(Map.of("c0", "a")), false, null)), List.of());
        try (XWPFDocument docx = read(doc)) {
            assertThat(docx.getDocument().getBody().getSectPr().getPgSz().getOrient().toString()).isEqualTo("landscape");
        }
        try (XWPFDocument portrait = read(ExportFixtures.document("th", true))) {
            assertThat(portrait.getDocument().getBody().isSetSectPr() && portrait.getDocument().getBody().getSectPr().isSetPgSz()
                    && portrait.getDocument().getBody().getSectPr().getPgSz().getOrient() != null).isFalse();
        }
    }

    @Test
    void anUnavailableTableSaysSoInsteadOfLookingEmpty() throws IOException {
        Column c = new Column("v", "V", "string", null, "none");
        Document doc = new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(),
                List.of(new Section("1", "Down", "a", List.of(c), List.of(), false, "relation does not exist")), List.of());
        try (XWPFDocument docx = read(doc)) {
            assertThat(docx.getParagraphs().stream().map(p -> p.getText())).contains("Data unavailable: relation does not exist");
        }
    }
}
