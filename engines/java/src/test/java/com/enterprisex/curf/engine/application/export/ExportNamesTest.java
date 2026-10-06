package com.enterprisex.curf.engine.application.export;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.junit.jupiter.api.Test;

class ExportNamesTest {

    private static final Instant AT = Instant.parse("2026-10-05T23:30:00Z");

    @Test
    void fileNamesKeepThaiAndDropWhatIsUnsafe() {
        assertThat(ExportService.fileName("รายงานผลการดำเนินงาน", ExportFormat.XLSX, AT)).isEqualTo("รายงานผลการดำเนินงาน-2026-10-05.xlsx");
        assertThat(ExportService.fileName("Sales/Q1: \"final\"?", ExportFormat.CSV, AT)).isEqualTo("Sales_Q1_ _final__-2026-10-05.csv");
        assertThat(ExportService.fileName("../../etc/passwd", ExportFormat.PDF, AT)).doesNotContain("/").doesNotContain("..".repeat(2) + "/");
        assertThat(ExportService.fileName("  ", ExportFormat.DOCX, AT)).isEqualTo("report-2026-10-05.docx");
        assertThat(ExportService.fileName("ก".repeat(200), ExportFormat.CSV, AT).length()).isLessThanOrEqualTo(80 + "-2026-10-05.csv".length());
    }

    @Test
    void theHashIsSha256OfTheBytes() {
        assertThat(ExportService.sha256("abc".getBytes(StandardCharsets.UTF_8)))
                .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assertThat(ExportService.sha256(new byte[0])).isEqualTo("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    }
}
