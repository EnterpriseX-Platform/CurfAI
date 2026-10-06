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
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;

class XlsxFileRendererTest {

    private final XlsxFileRenderer renderer = new XlsxFileRenderer();

    private XSSFWorkbook read(Document doc) throws IOException {
        return new XSSFWorkbook(new ByteArrayInputStream(renderer.render(doc, new Options(null, "TH Sarabun New"))));
    }

    @Test
    void oneSheetPerTableAndAProvenanceSheet() throws IOException {
        try (XSSFWorkbook wb = read(ExportFixtures.document("th", true))) {
            assertThat(wb.getNumberOfSheets()).isEqualTo(2);
            assertThat(wb.getSheetName(0)).isEqualTo("ตารางสรุป");
            assertThat(wb.getSheetName(1)).isEqualTo("ที่มาของข้อมูล");

            Sheet sheet = wb.getSheetAt(0);
            assertThat(texts(sheet.getRow(0))).containsExactly("ชื่อหน่วยงาน", "จำนวนเงิน", "อัตรา", "วันที่", "หมายเหตุ");
            assertThat(sheet.getRow(1).getCell(0).getStringCellValue()).isEqualTo("สำนักงานตรวจเงินแผ่นดิน");
            assertThat(sheet.getRow(1).getCell(4).getStringCellValue()).isEqualTo("ที่อยู่ เชียงใหม่");
        }
    }

    @Test
    void numbersAreNumbersAndMoneyAndPercentCarryFormats() throws IOException {
        try (XSSFWorkbook wb = read(ExportFixtures.document("th", true))) {
            Sheet sheet = wb.getSheetAt(0);
            Cell money = sheet.getRow(1).getCell(1);
            assertThat(money.getCellType()).isEqualTo(CellType.NUMERIC);
            assertThat(money.getNumericCellValue()).isEqualTo(48500000.50);
            assertThat(money.getCellStyle().getDataFormatString()).contains("฿").contains("#,##0.00");

            Cell rate = sheet.getRow(1).getCell(2);
            assertThat(rate.getNumericCellValue()).isEqualTo(0.153);
            assertThat(rate.getCellStyle().getDataFormatString()).isEqualTo("0.0%");
            assertThat(sheet.getRow(2).getCell(1).getNumericCellValue()).isEqualTo(1500.0);
            assertThat(sheet.getRow(3).getCell(1).getNumericCellValue()).isEqualTo(-25.25);
            Cell absent = sheet.getRow(3).getCell(2);
            assertThat(absent == null || absent.getCellType() == CellType.BLANK).as("absent is blank, not zero").isTrue();
        }
    }

    @Test
    void aBuddhistEraYearIsWrittenAsTextAndAGregorianDateAsARealDate() throws IOException {
        try (XSSFWorkbook buddhist = read(ExportFixtures.document("th", true))) {
            Cell cell = buddhist.getSheetAt(0).getRow(1).getCell(3);
            assertThat(cell.getCellType()).isEqualTo(CellType.STRING);
            assertThat(cell.getStringCellValue()).isEqualTo("10 ม.ค. 2569");
            assertThat(buddhist.getSheetAt(0).getRow(2).getCell(3).getStringCellValue()).isEqualTo("20 ก.พ. 2569");
        }
        try (XSSFWorkbook gregorian = read(ExportFixtures.document("en", false))) {
            Cell cell = gregorian.getSheetAt(0).getRow(1).getCell(3);
            assertThat(cell.getCellType()).isEqualTo(CellType.NUMERIC);
            assertThat(DateUtil.isCellDateFormatted(cell)).isTrue();
            assertThat(cell.getLocalDateTimeCellValue().toLocalDate()).isEqualTo(java.time.LocalDate.of(2026, 1, 10));
        }
    }

    @Test
    void textThatLooksLikeAFormulaStaysText() throws IOException {
        try (XSSFWorkbook wb = read(ExportFixtures.document("th", true))) {
            Sheet sheet = wb.getSheetAt(0);
            for (int r = 1; r <= 3; r++) {
                for (int c : new int[] {0, 4}) {
                    Cell cell = sheet.getRow(r).getCell(c);
                    assertThat(cell.getCellType()).as("row %d col %d", r, c).isNotEqualTo(CellType.FORMULA);
                }
            }
            assertThat(sheet.getRow(2).getCell(0).getStringCellValue()).isEqualTo("=1+1");
            assertThat(sheet.getRow(2).getCell(0).getCellType()).isEqualTo(CellType.STRING);
            assertThat(sheet.getRow(3).getCell(0).getStringCellValue()).isEqualTo("@cmd");
        }
    }

    @Test
    void aTotalsRowFollowsTheColumnSettings() throws IOException {
        try (XSSFWorkbook wb = read(ExportFixtures.document("th", true))) {
            Sheet sheet = wb.getSheetAt(0);
            assertThat(sheet.getRow(4).getCell(0).getStringCellValue()).isEqualTo("รวม");
            assertThat(sheet.getRow(4).getCell(1).getNumericCellValue()).isEqualTo(48500000.50 + 1500 - 25.25);
            assertThat(sheet.getRow(4).getCell(2).getNumericCellValue()).as("average of the present values").isCloseTo((0.153 + 0.2) / 2, org.assertj.core.data.Offset.offset(1e-9));
            assertThat(font(sheet.getRow(4).getCell(0)).getBold()).isTrue();
        }
    }

    @Test
    void theProvenanceSheetAndPropertiesCarryAsOfAndHashes() throws IOException {
        try (XSSFWorkbook wb = read(ExportFixtures.document("th", true))) {
            List<String> all = new ArrayList<>();
            wb.getSheetAt(1).forEach(row -> row.forEach(cell -> all.add(cell.getStringCellValue())));
            assertThat(all).contains("รายงานผลการดำเนินงาน", "2026-10-05T01:02:03.456Z", "sha256:aaaaaaaaaaaaaaaaaaaaaaaa", "sha256:bbbbbbbbbbbbbbbbbbbbbbbb");

            var custom = wb.getProperties().getCustomProperties();
            assertThat(custom.getProperty("curf.asOf").getLpwstr()).isEqualTo("2026-10-05T01:02:03.456Z");
            assertThat(custom.getProperty("curf.dataHash.q1").getLpwstr()).isEqualTo("sha256:bbbbbbbbbbbbbbbbbbbbbbbb");
            assertThat(wb.getProperties().getCoreProperties().getTitle()).isEqualTo("รายงานผลการดำเนินงาน");
        }
    }

    @Test
    void theConfiguredFontIsUsed() throws IOException {
        try (XSSFWorkbook wb = read(ExportFixtures.document("th", true))) {
            assertThat(font(wb.getSheetAt(0).getRow(1).getCell(0)).getFontName()).isEqualTo("TH Sarabun New");
            assertThat(font(wb.getSheetAt(0).getRow(0).getCell(0)).getFontName()).isEqualTo("TH Sarabun New");
        }
    }

    @Test
    void sheetNamesAreSafeAndUnique() throws IOException {
        Column c = new Column("v", "v", "string", null, "none");
        List<Section> sections = List.of(
                new Section("1", "Sales [2026]: Q1/Q2?", "a", List.of(c), List.of(), false, null),
                new Section("2", "Sales [2026]: Q1/Q2?", "b", List.of(c), List.of(), false, null),
                new Section("3", "ข".repeat(50), "c", List.of(c), List.of(), false, null),
                new Section("4", "   ", "d", List.of(c), List.of(), false, null));
        Document doc = new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(), sections, List.of());
        try (XSSFWorkbook wb = read(doc)) {
            List<String> names = new ArrayList<>();
            for (int i = 0; i < wb.getNumberOfSheets(); i++) {
                names.add(wb.getSheetName(i));
            }
            assertThat(names).doesNotHaveDuplicates().allSatisfy(n -> assertThat(n.length()).isLessThanOrEqualTo(31));
            assertThat(names.get(0)).isEqualTo("Sales 2026 Q1 Q2");
            assertThat(names.get(1)).isEqualTo("Sales 2026 Q1 Q2 (2)");
            assertThat(names.get(3)).isEqualTo("Sheet");
        }
    }

    @Test
    void anUnavailableTableSaysSoInsteadOfLookingEmpty() throws IOException {
        Column c = new Column("v", "V", "string", null, "none");
        Section down = new Section("1", "Down", "a", List.of(c), List.of(), false, "relation does not exist");
        Section empty = new Section("2", "Empty", "b", List.of(c), List.of(), false, null);
        Document doc = new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(), List.of(down, empty), List.of());
        try (XSSFWorkbook wb = read(doc)) {
            assertThat(wb.getSheetAt(0).getRow(1).getCell(0).getStringCellValue()).isEqualTo("Data unavailable: relation does not exist");
            assertThat(wb.getSheetAt(1).getRow(1).getCell(0).getStringCellValue()).isEqualTo("No rows");
        }
    }

    @Test
    void aLargeSheetStreamsWithoutTrouble() throws IOException {
        Column c = new Column("n", "N", "number", null, "sum");
        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = 0; i < 50_000; i++) {
            rows.add(Map.of("n", i));
        }
        Document doc = new Document("t", "en", new CellFormats.Style("en", false), "THB", "x", 1, Map.of(),
                List.of(new Section("1", "Big", "a", List.of(c), rows, true, null)), List.of());
        try (XSSFWorkbook wb = read(doc)) {
            assertThat(wb.getSheetAt(0).getLastRowNum()).isEqualTo(50_001);
            assertThat(wb.getSheetAt(0).getRow(50_001).getCell(0).getNumericCellValue()).isEqualTo(49_999.0 * 50_000 / 2);
        }
    }

    private static org.apache.poi.xssf.usermodel.XSSFFont font(Cell cell) {
        return ((org.apache.poi.xssf.usermodel.XSSFCellStyle) cell.getCellStyle()).getFont();
    }

    private static List<String> texts(org.apache.poi.ss.usermodel.Row row) {
        List<String> out = new ArrayList<>();
        row.forEach(cell -> out.add(cell.getStringCellValue()));
        return out;
    }
}
