package com.enterprisex.curf.engine;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.enterprisex.curf.engine.DbTargets.Target;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.text.PDFTextStripper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;

/**
 * PDF export against a real Chromium sidecar (Gotenberg), set in CURF_ENGINE_TEST_GOTENBERG_URL. The checks are on the
 * text a reader would copy out of the file: Thai with its stacked vowels and tone marks must come back exactly,
 * long Thai text must wrap rather than be clipped, no page may be blank, and data must never turn into markup.
 */
@EngineIT
@EnabledIfEnvironmentVariable(named = "CURF_ENGINE_TEST_GOTENBERG_URL", matches = ".+")
@TestPropertySource(properties = {
    "curf.engine.exports.gotenberg-url=${CURF_ENGINE_TEST_GOTENBERG_URL}",
    "curf.engine.exports.max-rows=1000",
})
class PdfExportIT extends ApiSupport {

    private Target postgres() {
        return (Target) DbTargets.targets().findFirst().orElseThrow().get()[0];
    }

    private String report(Map<String, Object> definition) throws Exception {
        MvcResult r = call(post("/engine/v1/reports"), admin(), ReportIT.saved(definition, "runRoles", List.of("analyst", "hr")));
        assertThat(r.getResponse().getStatus()).as(r.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        String id = body(r).get("id").asString();
        publishReport(id);
        return id;
    }

    private byte[] pdf(String token, String report) throws Exception {
        MvcResult created = call(post("/engine/v1/reports/" + report + "/exports"), token, req("format", "PDF"));
        assertThat(created.getResponse().getStatus()).as(created.getResponse().getContentAsString(StandardCharsets.UTF_8)).isEqualTo(201);
        JsonNode info = body(created);
        MvcResult file = call(get(info.get("downloadUrl").asString()), token, null);
        byte[] bytes = file.getResponse().getContentAsByteArray();
        assertThat(file.getResponse().getContentType()).isEqualTo("application/pdf");
        assertThat(file.getResponse().getHeader("X-Content-SHA256")).isEqualTo(info.get("sha256").asString());
        assertThat(info.get("fileName").asString()).endsWith(".pdf");
        assertThat(new String(bytes, 0, 5, StandardCharsets.ISO_8859_1)).isEqualTo("%PDF-");
        return bytes;
    }

    /** The text of each page, as a reader would copy it. */
    private static List<String> pages(byte[] pdf) throws Exception {
        try (PDDocument doc = Loader.loadPDF(pdf)) {
            List<String> out = new ArrayList<>();
            PDFTextStripper stripper = new PDFTextStripper();
            for (int p = 1; p <= doc.getNumberOfPages(); p++) {
                stripper.setStartPage(p);
                stripper.setEndPage(p);
                out.add(stripper.getText(doc));
            }
            return out;
        }
    }

    /** Leaves the PDF and an image of its first page under build/exports, so a person can look at what was produced. */
    private static void keepForInspection(String name, byte[] pdf) throws Exception {
        java.nio.file.Path dir = java.nio.file.Path.of("build", "exports");
        java.nio.file.Files.createDirectories(dir);
        java.nio.file.Files.write(dir.resolve(name + ".pdf"), pdf);
        try (PDDocument doc = Loader.loadPDF(pdf)) {
            var image = new org.apache.pdfbox.rendering.PDFRenderer(doc).renderImageWithDPI(0, 110);
            javax.imageio.ImageIO.write(image, "png", dir.resolve(name + ".png").toFile());
        }
    }

    private static String squash(String s) {
        return s.replaceAll("\\s+", "");
    }

    @Test
    void thaiTextComesBackExactlyAndTheFontIsEmbedded() throws Exception {
        Target t = postgres();
        String view = createView(viewBody(connection(t)), true);
        Map<String, Object> d = ReportIT.definition("รายงานผลการดำเนินงาน " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.viewQuery("ds", view, req("columns", List.of("id", "agency_code", "ที่อยู่", "amount", "created"),
                        "orderBy", List.of(req("column", "id", "descending", false))))),
                List.of(ReportIT.block("b", "table", req("queryId", "ds", "title", "สรุปรายชื่อหน่วยงาน", "columns", List.of(
                        req("key", "id", "label", "รหัส", "type", "number"),
                        req("key", "agency_code", "label", "หน่วยงาน", "type", "string"),
                        req("key", "ที่อยู่", "label", "ที่อยู่", "type", "string"),
                        req("key", "amount", "label", "จำนวนเงิน", "type", "currency", "total", "sum"),
                        req("key", "created", "label", "วันที่", "type", "date"))))));
        String id = report(d);

        byte[] bytes = pdf(person("hr-1", "A001", "hr"), id);
        String text = String.join("\n", pages(bytes));
        keepForInspection("thai-report", bytes);

        for (String expected : List.of("สรุปรายชื่อหน่วยงาน", "หน่วยงาน", "จำนวนเงิน", "กรุงเทพ", "เชียงใหม่", "ขอนแก่น", "10 ม.ค. 2569", "฿100.50", "฿350.75", "รวม")) {
            assertThat(squash(text)).as(expected).contains(squash(expected));
        }
        assertThat(text).contains("หน้า").contains("จาก").contains("ข้อมูล ณ");

        try (PDDocument doc = Loader.loadPDF(bytes)) {
            List<String> fonts = new ArrayList<>();
            for (PDPage page : doc.getPages()) {
                page.getResources().getFontNames().forEach(n -> {
                    try {
                        fonts.add(page.getResources().getFont(n).getName());
                    } catch (java.io.IOException e) {
                        throw new java.io.UncheckedIOException(e);
                    }
                });
            }
            assertThat(fonts).as("the Thai font is embedded, not left to the machine").anyMatch(n -> n.contains("Sarabun"));
            assertThat(doc.getDocumentInformation().getTitle()).startsWith("รายงานผลการดำเนินงาน");
        }
    }

    @Test
    void anAnalystGetsMasksNotPersonalData() throws Exception {
        Target t = postgres();
        String view = createView(viewBody(connection(t)), true);
        String id = report(ReportIT.definition("masks " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.viewQuery("ds", view, req("columns", List.of("id", "email", "ที่อยู่")))),
                List.of(ReportIT.block("b", "table", req("queryId", "ds")))));

        String text = String.join("\n", pages(pdf(analyst("A001"), id)));
        assertThat(text).contains("***").doesNotContain("somchai@a001.go.th").doesNotContain("กรุงเทพ");
    }

    @Test
    void longThaiTextWrapsInsteadOfBeingClipped() throws Exception {
        Target t = postgres();
        String thai = "การตรวจเงินแผ่นดินเป็นกระบวนการที่ตรวจสอบการใช้จ่ายเงินของหน่วยงานของรัฐเพื่อให้เกิดความโปร่งใสและความคุ้มค่าตามหลักธรรมาภิบาล".repeat(4);
        Map<String, Object> viewReq = viewBody(connection(t));
        viewReq.put("sql", "SELECT 1 AS id, '" + thai + "' AS note");
        viewReq.put("rlsRules", List.of());
        viewReq.put("columns", List.of());
        String view = createView(viewReq, true);
        String id = report(ReportIT.definition("long " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.viewQuery("ds", view, req())), List.of(ReportIT.block("b", "table", req("queryId", "ds")))));

        String text = String.join("", pages(pdf(analyst("A001"), id)));
        assertThat(squash(text)).as("every character of the long cell is on the page").contains(squash(thai));
    }

    @Test
    void manyRowsMakeSeveralPagesNoneBlankWithTheHeaderRepeated() throws Exception {
        Target t = postgres();
        String conn = connection(t, true);
        Map<String, Object> d = ReportIT.definition("many " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.rawQuery("ds", conn, "SELECT g AS id, 'ชื่อ ' || g AS name FROM generate_series(1, 300) g ORDER BY g")),
                List.of(ReportIT.block("b", "table", req("queryId", "ds", "columns", List.of(
                        req("key", "id", "label", "ลำดับ", "type", "number"), req("key", "name", "label", "ชื่อรายการ", "type", "string"))))));
        MvcResult created = call(post("/engine/v1/reports"), admin(), ReportIT.saved(d));
        String id = body(created).get("id").asString();

        List<String> pages = pages(pdf(admin(), id));
        assertThat(pages.size()).isGreaterThanOrEqualTo(3);
        for (int i = 0; i < pages.size(); i++) {
            assertThat(pages.get(i).strip()).as("page %d is not blank", i + 1).isNotBlank();
            assertThat(pages.get(i)).as("the header repeats on page %d", i + 1).contains("ชื่อรายการ");
        }
        assertThat(squash(pages.get(pages.size() - 1))).contains("300");
    }

    @Test
    void dataNeverBecomesMarkupInTheDocument() throws Exception {
        Target t = postgres();
        Map<String, Object> viewReq = viewBody(connection(t));
        viewReq.put("sql", "SELECT 1 AS id, '<script>alert(1)</script><img src=x onerror=alert(2)>' AS note");
        viewReq.put("rlsRules", List.of());
        viewReq.put("columns", List.of());
        String view = createView(viewReq, true);
        String id = report(ReportIT.definition("hostile " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.viewQuery("ds", view, req())), List.of(ReportIT.block("b", "table", req("queryId", "ds")))));

        String text = String.join("\n", pages(pdf(analyst("A001"), id)));
        assertThat(text).as("shown as text, not run or hidden").contains("<script>alert(1)</script>").contains("<img src=x onerror=alert(2)>");
    }

    @Test
    void wideTablesPrintLandscape() throws Exception {
        Target t = postgres();
        String view = createView(viewBody(connection(t)), true);
        List<Map<String, Object>> columns = new ArrayList<>();
        for (String c : List.of("id", "agency_code", "name", "email", "salary", "amount", "created", "national_id")) {
            columns.add(req("key", c, "label", c, "type", "string"));
        }
        String id = report(ReportIT.definition("wide " + UUID.randomUUID(), List.of(),
                List.of(ReportIT.viewQuery("ds", view, req())), List.of(ReportIT.block("b", "table", req("queryId", "ds", "columns", columns)))));

        try (PDDocument doc = Loader.loadPDF(pdf(analyst("A001"), id))) {
            var box = doc.getPage(0).getMediaBox();
            assertThat(box.getWidth()).as("landscape").isGreaterThan(box.getHeight());
        }
    }
}
