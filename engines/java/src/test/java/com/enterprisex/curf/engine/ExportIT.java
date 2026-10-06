package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.enterprisex.curf.engine.DbTargets.Target;
import com.enterprisex.curf.engine.application.export.ExportService;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

/**
 * Exporting a report to a file, end to end over HTTP on every database: the person's own rows and masks, the real
 * files read back, the SHA-256, who may fetch them, the row limit, retention and the audit trail.
 */
@EngineIT
class ExportIT extends ApiSupport {

    static final String SRC = "com.enterprisex.curf.engine.DbTargets#targets";

    @Autowired ExportService exportService;

    // ---------------------------------------------------------------- reports to export

    static List<Map<String, Object>> columns() {
        return List.of(
                req("key", "id", "label", "รหัส", "type", "number"),
                req("key", "agency_code", "label", "หน่วยงาน", "type", "string"),
                req("key", "name", "label", "ชื่อ", "type", "string"),
                req("key", "email", "label", "อีเมล", "type", "string"),
                req("key", "amount", "label", "จำนวนเงิน", "type", "currency", "total", "sum"),
                req("key", "created", "label", "วันที่", "type", "date"));
    }

    Map<String, Object> exportReport(String name, String view) {
        return ReportIT.definition(name, List.of(),
                List.of(ReportIT.viewQuery("ds_rows", view, req(
                                "columns", List.of("id", "agency_code", "name", "email", "amount", "created"),
                                "orderBy", List.of(req("column", "id", "descending", false)))),
                        ReportIT.viewQuery("ds_totals", view, req("groupBy", List.of("agency_code"),
                                "aggregates", List.of(req("fn", "SUM", "column", "amount", "as", "total"))))),
                List.of(ReportIT.block("b_rows", "table", req("queryId", "ds_rows", "title", "รายชื่อ", "columns", columns())),
                        ReportIT.block("b_chart", "chart", req("queryId", "ds_totals", "chartType", "bar"))));
    }

    String report(Map<String, Object> definition) throws Exception {
        return report(definition, List.of("analyst", "hr", "auditor"));
    }

    String report(Map<String, Object> definition, List<String> runRoles) throws Exception {
        MvcResult r = call(post("/engine/v1/reports"), admin(), ReportIT.saved(definition, "runRoles", runRoles));
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        String id = body(r).get("id").asString();
        publishReport(id);
        return id;
    }

    MvcResult export(String token, String report, Map<String, Object> body) throws Exception {
        return call(post("/engine/v1/reports/" + report + "/exports"), token, body);
    }

    JsonNode created(MvcResult r) throws Exception {
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        return body(r);
    }

    MockHttpServletResponse download(String token, JsonNode info) throws Exception {
        MvcResult r = call(get(info.get("downloadUrl").asString()), token, null);
        assertThat(r.getResponse().getStatus()).isEqualTo(200);
        return r.getResponse();
    }

    static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    // ---------------------------------------------------------------- the files

    @ParameterizedTest(name = "{0}: a CSV holds the person's own rows and masks, with a hash and a Thai file name")
    @MethodSource(SRC)
    void csvIsTheViewersOwnData(Target t) throws Exception {
        String id = report(exportReport("รายงานหน่วยงาน " + UUID.randomUUID(), publishedView(t)));

        String me = person("csv-user", "A001", "analyst");
        JsonNode info = created(export(me, id, req("format", "CSV")));
        MockHttpServletResponse file = download(me, info);
        byte[] bytes = file.getContentAsByteArray();

        assertThat(file.getContentType()).startsWith("text/csv");
        assertThat(file.getHeader("X-Content-SHA256")).isEqualTo(sha256(bytes)).isEqualTo(info.get("sha256").asString());
        assertThat(file.getHeader("X-Curf-As-Of")).isEqualTo(info.get("asOf").asString()).matches("\\d{4}-\\d{2}-\\d{2}T.*Z");
        assertThat(file.getHeader("Cache-Control")).contains("no-store");
        assertThat(file.getHeader("Content-Disposition")).contains("filename*=UTF-8''").contains("%E0%B8%A3%E0%B8%B2%E0%B8%A2");
        assertThat(info.get("fileName").asString()).startsWith("รายงานหน่วยงาน").endsWith(".csv");
        assertThat(info.get("sizeBytes").asLong()).isEqualTo(bytes.length);

        assertThat(bytes).startsWith(0xEF, 0xBB, 0xBF);
        String[] lines = new String(bytes, 3, bytes.length - 3, StandardCharsets.UTF_8).split("\r\n");
        assertThat(lines[0]).isEqualTo("รหัส,หน่วยงาน,ชื่อ,อีเมล,จำนวนเงิน,วันที่");
        assertThat(lines).hasSize(4);
        assertThat(lines[1]).isEqualTo("1,A001,Somchai,***,100.50,2026-01-10");
        assertThat(lines[3]).startsWith("3,A001,Anan,***,50.00,");

        JsonNode hr = created(export(person("hr-1", "A001", "hr"), id, req("format", "CSV")));
        String hrCsv = new String(download(person("hr-1", "A001", "hr"), hr).getContentAsByteArray(), StandardCharsets.UTF_8);
        assertThat(hrCsv).contains("1,A001,Somchai,somchai@a001.go.th,100.50,2026-01-10").doesNotContain("***");

        JsonNode other = created(export(analyst("A002"), id, req("format", "CSV")));
        assertThat(info.get("sha256").asString()).isNotEqualTo(other.get("sha256").asString());
    }

    @ParameterizedTest(name = "{0}: an XLSX has typed cells, Thai headings, Buddhist-era dates and the data hashes")
    @MethodSource(SRC)
    void xlsxIsTypedAndCarriesProvenance(Target t) throws Exception {
        String id = report(exportReport("xlsx " + UUID.randomUUID(), publishedView(t)));
        String me = analyst("A001");

        JsonNode info = created(export(me, id, req("format", "XLSX")));
        byte[] bytes = download(me, info).getContentAsByteArray();
        assertThat(sha256(bytes)).isEqualTo(info.get("sha256").asString());

        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            assertThat(wb.getSheetName(0)).isEqualTo("รายชื่อ");
            var sheet = wb.getSheetAt(0);
            assertThat(sheet.getRow(0).getCell(4).getStringCellValue()).isEqualTo("จำนวนเงิน");
            assertThat(sheet.getRow(1).getCell(3).getStringCellValue()).as("masked for an analyst").isEqualTo("***");
            assertThat(sheet.getRow(1).getCell(0).getNumericCellValue()).isEqualTo(1.0);
            assertThat(sheet.getRow(1).getCell(4).getNumericCellValue()).isEqualTo(100.5);
            assertThat(sheet.getRow(1).getCell(4).getCellStyle().getDataFormatString()).contains("฿");
            assertThat(sheet.getRow(1).getCell(5).getStringCellValue()).as("Thai reader, Buddhist era by default").isEqualTo("10 ม.ค. 2569");
            assertThat(sheet.getRow(4).getCell(0).getStringCellValue()).isEqualTo("รวม");
            assertThat(sheet.getRow(4).getCell(4).getNumericCellValue()).isEqualTo(350.75);

            // The hash the file records is the hash the run reports for the same data.
            JsonNode run = body(call(post("/engine/v1/reports/" + id + "/run"), me, req("params", Map.of())));
            String dataHash = run.get("provenance").get("ds_rows").get("dataHash").asString();
            var props = wb.getProperties().getCustomProperties();
            assertThat(props.getProperty("curf.dataHash.ds_rows").getLpwstr()).isEqualTo(dataHash);
            assertThat(props.getProperty("curf.asOf").getLpwstr()).isEqualTo(info.get("asOf").asString());
            List<String> provenance = new ArrayList<>();
            wb.getSheetAt(wb.getNumberOfSheets() - 1).forEach(row -> row.forEach(c -> provenance.add(c.getStringCellValue())));
            assertThat(provenance).contains(dataHash);
        }
    }

    @ParameterizedTest(name = "{0}: language, calendar and currency follow the request, and a report's own era wins")
    @MethodSource(SRC)
    void localeCalendarAndCurrencyOptions(Target t) throws Exception {
        String view = publishedView(t);
        String me = analyst("A001");

        String plain = report(exportReport("opts " + UUID.randomUUID(), view));
        JsonNode english = created(export(me, plain, req("format", "XLSX", "locale", "en", "currency", "USD")));
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(download(me, english).getContentAsByteArray()))) {
            var sheet = wb.getSheetAt(0);
            assertThat(sheet.getRow(4).getCell(0).getStringCellValue()).isEqualTo("Total");
            assertThat(sheet.getRow(1).getCell(4).getCellStyle().getDataFormatString()).contains("$");
            assertThat(sheet.getRow(1).getCell(5).getCellType()).as("English and Gregorian: a real date").isEqualTo(CellType.NUMERIC);
            assertThat(DateUtil.isCellDateFormatted(sheet.getRow(1).getCell(5))).isTrue();
        }

        JsonNode thaiGregorian = created(export(me, plain, req("format", "XLSX", "locale", "th", "calendar", "GREGORIAN")));
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(download(me, thaiGregorian).getContentAsByteArray()))) {
            assertThat(DateUtil.isCellDateFormatted(wb.getSheetAt(0).getRow(1).getCell(5))).isTrue();
        }

        Map<String, Object> fixed = exportReport("fixed " + UUID.randomUUID(), view);
        fixed.put("dateEra", "ce");
        fixed.put("currency", "EUR");
        String fixedId = report(fixed);
        JsonNode locked = created(export(me, fixedId, req("format", "XLSX", "locale", "th", "calendar", "BUDDHIST", "currency", "USD")));
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(download(me, locked).getContentAsByteArray()))) {
            var cell = wb.getSheetAt(0).getRow(1).getCell(5);
            assertThat(DateUtil.isCellDateFormatted(cell)).as("the report fixes the era, whatever was asked").isTrue();
            assertThat(wb.getSheetAt(0).getRow(1).getCell(4).getCellStyle().getDataFormatString()).contains("€");
        }
    }

    @ParameterizedTest(name = "{0}: a DOCX holds the tables, the totals and a footer")
    @MethodSource(SRC)
    void docxHoldsTheTables(Target t) throws Exception {
        String id = report(exportReport("docx " + UUID.randomUUID(), publishedView(t)));
        String me = analyst("A001");

        JsonNode info = created(export(me, id, req("format", "DOCX")));
        byte[] bytes = download(me, info).getContentAsByteArray();
        try (XWPFDocument docx = new XWPFDocument(new ByteArrayInputStream(bytes))) {
            var table = docx.getTables().get(0);
            assertThat(table.getRow(0).getCell(1).getText()).isEqualTo("หน่วยงาน");
            assertThat(table.getRow(1).getCell(3).getText()).isEqualTo("***");
            assertThat(table.getRow(1).getCell(4).getText()).isEqualTo("฿100.50");
            assertThat(table.getRow(1).getCell(5).getText()).isEqualTo("10 ม.ค. 2569");
            assertThat(table.getRow(4).getCell(0).getText()).isEqualTo("รวม");
            assertThat(table.getRow(4).getCell(4).getText()).isEqualTo("฿350.75");
            assertThat(docx.getFooterList().get(0).getText()).contains(info.get("asOf").asString());
        }
    }

    // ---------------------------------------------------------------- who, how long, how big

    @ParameterizedTest(name = "{0}: only the creator can fetch a file, and it can be deleted")
    @MethodSource(SRC)
    void onlyTheCreatorCanFetchAFile(Target t) throws Exception {
        String id = report(exportReport("mine " + UUID.randomUUID(), publishedView(t)));
        String me = person("creator-1", "A001", "analyst");
        JsonNode info = created(export(me, id, req("format", "CSV")));
        String url = info.get("downloadUrl").asString();

        for (String other : List.of(person("creator-2", "A001", "analyst"), admin(), TestIdp.bearerWith(OTHER_TENANT, "creator-1", Map.of(), "curf-admin"))) {
            assertThat(call(get(url), other, null).getResponse().getStatus()).isEqualTo(404);
            assertThat(call(get("/engine/v1/exports/" + info.get("id").asString()), other, null).getResponse().getStatus()).isEqualTo(404);
            assertThat(call(delete("/engine/v1/exports/" + info.get("id").asString()), other, null).getResponse().getStatus()).isEqualTo(404);
        }
        String mine = call(get("/engine/v1/exports"), me, null).getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(mine).contains(info.get("id").asString());
        assertThat(call(get("/engine/v1/exports"), person("creator-2", "A001", "analyst"), null).getResponse().getContentAsString())
                .doesNotContain(info.get("id").asString());

        assertThat(call(delete("/engine/v1/exports/" + info.get("id").asString()), me, null).getResponse().getStatus()).isEqualTo(204);
        assertThat(call(get(url), me, null).getResponse().getStatus()).isEqualTo(404);
    }

    @ParameterizedTest(name = "{0}: an expired file is gone, and the purge removes it for good")
    @MethodSource(SRC)
    void filesAreKeptForALimitedTime(Target t) throws Exception {
        String id = report(exportReport("expiry " + UUID.randomUUID(), publishedView(t)));
        String me = analyst("A001");
        JsonNode info = created(export(me, id, req("format", "CSV")));
        Instant expires = Instant.parse(info.get("expiresAt").asString());
        assertThat(expires).isAfter(Instant.now().plusSeconds(6 * 24 * 3600L)).isBefore(Instant.now().plusSeconds(8 * 24 * 3600L));

        jdbc.sql("update engine_export set expires_at = now() - interval '1 minute' where id = :id").param("id", UUID.fromString(info.get("id").asString())).update();
        assertThat(call(get(info.get("downloadUrl").asString()), me, null).getResponse().getStatus()).isEqualTo(404);
        assertThat(call(get("/engine/v1/exports"), me, null).getResponse().getContentAsString()).doesNotContain(info.get("id").asString());

        assertThat(exportService.purgeExpired()).isGreaterThanOrEqualTo(1);
        assertThat(jdbc.sql("select count(*) from engine_export where id = :id").param("id", UUID.fromString(info.get("id").asString())).query(Long.class).single()).isZero();
    }

    @ParameterizedTest(name = "{0}: a result cut short by the row limit is refused, not written")
    @MethodSource(SRC)
    void aTruncatedResultIsRefused(Target t) throws Exception {
        String id = report(exportReport("limit " + UUID.randomUUID(), publishedView(t)));

        MvcResult tooMany = export(person("auditor-1", null, "auditor"), id, req("format", "CSV"));
        assertThat(tooMany.getResponse().getStatus()).isEqualTo(422);
        assertThat(body(tooMany).get("code").asString()).isEqualTo("CURF_ROW_LIMIT");
        assertThat(body(tooMany).get("detail").asString()).contains("more than 6 rows");

        assertThat(export(analyst("A001"), id, req("format", "CSV")).getResponse().getStatus()).as("fewer rows fit").isEqualTo(201);
        assertThat(ids(body(call(post("/engine/v1/reports/" + id + "/run"), person("auditor-1", null, "auditor"), req("params", Map.of()))), "ds_rows"))
                .as("the on-screen run is not held to the export limit").hasSize(7);
    }

    @ParameterizedTest(name = "{0}: a CSV needs a table that loaded; other formats say what is missing")
    @MethodSource(SRC)
    void csvNeedsATableThatLoaded(Target t) throws Exception {
        String view = publishedView(t);
        String conn = connection(t, true);
        String me = admin();

        String failing = report(ReportIT.definition("failing " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.rawQuery("ds_bad", conn, "SELECT * FROM no_such_table_here")),
                List.of(ReportIT.block("b", "table", req("queryId", "ds_bad", "title", "พัง")))), List.of());
        MvcResult csv = export(me, failing, req("format", "CSV"));
        assertThat(csv.getResponse().getStatus()).isEqualTo(422);
        assertThat(body(csv).get("detail").asString()).contains("data didn't load");

        JsonNode xlsx = created(export(me, failing, req("format", "XLSX")));
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(download(me, xlsx).getContentAsByteArray()))) {
            assertThat(wb.getSheetAt(0).getRow(1).getCell(0).getStringCellValue()).startsWith("ไม่มีข้อมูล:");
        }

        String noTable = report(ReportIT.definition("no table " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.viewQuery("ds", view, req("columns", List.of("id")))), List.of(ReportIT.block("c", "chart", req("queryId", "ds")))), List.of("analyst"));
        String viewer1 = analyst("A001");
        assertThat(export(viewer1, noTable, req("format", "CSV")).getResponse().getStatus()).isEqualTo(422);
        JsonNode sheets = created(export(viewer1, noTable, req("format", "XLSX")));
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(download(viewer1, sheets).getContentAsByteArray()))) {
            assertThat(wb.getSheetName(0)).as("one sheet per query when there is no table").isEqualTo("Query ds");
        }
    }

    @ParameterizedTest(name = "{0}: bad requests are refused with a reason")
    @MethodSource(SRC)
    void badRequestsAreRefused(Target t) throws Exception {
        String id = report(exportReport("bad " + UUID.randomUUID(), publishedView(t)));
        String me = analyst("A001");

        for (Map<String, Object> bad : List.<Map<String, Object>>of(
                req(), req("format", "ODT"), req("format", "CSV", "locale", "fr"), req("format", "CSV", "currency", "EURO"),
                req("format", "CSV", "blockId", "not_a_block"), req("format", "CSV", "params", req("typo", "x")),
                req("format", "CSV", "calendar", "LUNAR"))) {
            assertThat(export(me, id, bad).getResponse().getStatus()).as(bad.toString()).isEqualTo(422);
        }
        assertThat(export(me, UUID.randomUUID().toString(), req("format", "CSV")).getResponse().getStatus()).isEqualTo(404);
        assertThat(export(person("s", "A001", "stranger"), id, req("format", "CSV")).getResponse().getStatus()).as("not allowed to run it").isEqualTo(404);
    }

    @ParameterizedTest(name = "{0}: PDF says so when no Chromium sidecar is configured")
    @MethodSource(SRC)
    void pdfNeedsASidecar(Target t) throws Exception {
        String id = report(exportReport("pdf " + UUID.randomUUID(), publishedView(t)));
        MvcResult r = export(analyst("A001"), id, req("format", "PDF"));
        assertThat(r.getResponse().getStatus()).isEqualTo(503);
        assertThat(body(r).get("code").asString()).isEqualTo("CURF_EXPORT_UNAVAILABLE");
    }

    @ParameterizedTest(name = "{0}: an export is audited by hash and size, never by content")
    @MethodSource(SRC)
    void exportsAreAudited(Target t) throws Exception {
        String id = report(exportReport("audit " + UUID.randomUUID(), publishedView(t)));
        JsonNode info = created(export(analyst("A001"), id, req("format", "CSV")));

        String audit = call(get("/engine/v1/audit-events?entityId=" + info.get("id").asString()), admin(), null).getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(audit).contains("report.export").contains(info.get("sha256").asString()).contains("CSV").contains("\\\"bytes\\\"");
        assertThat(audit).doesNotContain("Somchai").doesNotContain("***");
    }

    static List<Integer> ids(JsonNode result, String query) {
        return ReportIT.ids(result, query);
    }
}
