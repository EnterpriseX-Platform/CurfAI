package com.enterprisex.curf.engine.interfaces.rest;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class ExportDispositionTest {

    @Test
    void anAsciiFallbackAndTheRealNameEncodedAsUtf8() {
        String header = ExportController.disposition("รายงาน-2026-10-05.xlsx");

        assertThat(header).startsWith("attachment; filename=\"");
        assertThat(header).contains("filename*=UTF-8''%E0%B8%A3%E0%B8%B2%E0%B8%A2%E0%B8%87%E0%B8%B2%E0%B8%99-2026-10-05.xlsx");
        assertThat(header).as("the fallback holds no non-ASCII characters").matches("^[\\x20-\\x7E]+$");
    }

    @Test
    void plainNamesPassThroughAndSpacesAreEncodedCorrectly() {
        String header = ExportController.disposition("My report-2026-10-05.csv");
        assertThat(header).contains("filename=\"My report-2026-10-05.csv\"").contains("filename*=UTF-8''My%20report-2026-10-05.csv");
    }

    @Test
    void quotesAndControlCharactersCannotEscapeTheHeader() {
        String header = ExportController.disposition("a\"b\r\nX-Evil: 1.csv");
        assertThat(header).doesNotContain("\r").doesNotContain("\n");
        assertThat(header.substring(0, header.indexOf("; filename*"))).doesNotContain("a\"b");
    }
}
