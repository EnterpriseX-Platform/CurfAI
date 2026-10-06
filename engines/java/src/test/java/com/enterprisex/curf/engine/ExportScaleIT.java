package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.enterprisex.curf.engine.DbTargets.Target;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

/** The size an export is meant to handle: 100,000 rows, written within a time budget. PostgreSQL only (generate_series). */
@EngineIT
@TestPropertySource(properties = {"curf.engine.exports.max-rows=100000", "curf.engine.query.max-bytes=268435456"})
class ExportScaleIT extends ApiSupport {

    private static final int ROWS = 100_000;
    private static final Duration BUDGET = Duration.ofSeconds(60);

    private String report() throws Exception {
        Target t = (Target) DbTargets.targets().findFirst().orElseThrow().get()[0];
        String conn = connection(t, true);
        String sql = "SELECT g AS id, 'หน่วยงาน ' || g AS name, (g * 1.5)::numeric(12,2) AS amount FROM generate_series(1, " + ROWS + ") g ORDER BY g";
        var definition = ReportIT.definition("scale " + java.util.UUID.randomUUID(), List.of(),
                List.of(ReportIT.rawQuery("ds", conn, sql)),
                List.of(ReportIT.block("b", "table", req("queryId", "ds", "columns", List.of(
                        req("key", "id", "label", "ลำดับ", "type", "number"), req("key", "name", "label", "ชื่อ", "type", "string"),
                        req("key", "amount", "label", "จำนวนเงิน", "type", "currency", "total", "sum"))))));
        MvcResult r = call(post("/engine/v1/reports"), admin(), ReportIT.saved(definition));
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString()).isEqualTo(201);
        return body(r).get("id").asString();
    }

    private MvcResult timed(String report, String format, long[] elapsedMs) throws Exception {
        long started = System.nanoTime();
        MvcResult r = call(post("/engine/v1/reports/" + report + "/exports"), admin(), req("format", format));
        elapsedMs[0] = (System.nanoTime() - started) / 1_000_000;
        return r;
    }

    @Test
    void aHundredThousandRowsAsXlsxAndCsvWithinTheBudget() throws Exception {
        String id = report();
        long[] ms = new long[1];

        MvcResult xlsx = timed(id, "XLSX", ms);
        assertThat(xlsx.getResponse().getStatus()).as(xlsx.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        assertThat(Duration.ofMillis(ms[0])).as("XLSX took %d ms", ms[0]).isLessThan(BUDGET);
        JsonNode info = body(xlsx);
        byte[] bytes = call(get(info.get("downloadUrl").asString()), admin(), null).getResponse().getContentAsByteArray();
        try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(bytes))) {
            var sheet = wb.getSheetAt(0);
            assertThat(sheet.getLastRowNum()).as("header + rows + totals").isEqualTo(ROWS + 1);
            assertThat(sheet.getRow(ROWS).getCell(1).getStringCellValue()).isEqualTo("หน่วยงาน " + ROWS);
            assertThat(sheet.getRow(ROWS + 1).getCell(2).getNumericCellValue()).isEqualTo(1.5 * ROWS * (ROWS + 1) / 2);
        }

        MvcResult csv = timed(id, "CSV", ms);
        assertThat(csv.getResponse().getStatus()).isEqualTo(201);
        assertThat(Duration.ofMillis(ms[0])).as("CSV took %d ms", ms[0]).isLessThan(BUDGET);
        byte[] csvBytes = call(get(body(csv).get("downloadUrl").asString()), admin(), null).getResponse().getContentAsByteArray();
        assertThat(new String(csvBytes, StandardCharsets.UTF_8).lines().count()).isEqualTo(ROWS + 1);
    }

    @Test
    void oneRowOverTheLimitIsRefused() throws Exception {
        Target t = (Target) DbTargets.targets().findFirst().orElseThrow().get()[0];
        String conn = connection(t, true);
        var definition = ReportIT.definition("over " + java.util.UUID.randomUUID(), List.of(),
                List.of(ReportIT.rawQuery("ds", conn, "SELECT g AS id FROM generate_series(1, " + (ROWS + 1) + ") g")),
                List.of(ReportIT.block("b", "table", req("queryId", "ds"))));
        String id = body(call(post("/engine/v1/reports"), admin(), ReportIT.saved(definition))).get("id").asString();

        MvcResult r = call(post("/engine/v1/reports/" + id + "/exports"), admin(), req("format", "CSV"));
        assertThat(r.getResponse().getStatus()).isEqualTo(422);
        assertThat(body(r).get("code").asString()).isEqualTo("CURF_ROW_LIMIT");
    }
}
