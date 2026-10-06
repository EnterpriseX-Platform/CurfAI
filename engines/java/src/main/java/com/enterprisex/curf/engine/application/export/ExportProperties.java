package com.enterprisex.curf.engine.application.export;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code gotenbergUrl} is the Chromium sidecar that prints PDFs; without it PDF export answers 503 and the other
 * formats still work. {@code font} names the font written into spreadsheets and Word files (they cannot embed
 * one, so the reader's machine needs it; the PDF always embeds its own).
 */
@ConfigurationProperties(prefix = "curf.engine.exports")
public record ExportProperties(
        Duration retention,
        Long maxBytes,
        Integer maxRows,
        String font,
        String defaultLocale,
        String defaultCurrency,
        String gotenbergUrl,
        Duration pdfTimeout) {

    public ExportProperties {
        retention = retention == null ? Duration.ofDays(7) : retention;
        maxBytes = maxBytes == null ? 50L * 1024 * 1024 : maxBytes;
        maxRows = maxRows == null ? 100_000 : maxRows;
        font = font == null || font.isBlank() ? "TH Sarabun New" : font;
        defaultLocale = defaultLocale == null || defaultLocale.isBlank() ? "th" : defaultLocale;
        defaultCurrency = defaultCurrency == null || defaultCurrency.isBlank() ? "THB" : defaultCurrency;
        gotenbergUrl = gotenbergUrl == null ? "" : gotenbergUrl.replaceAll("/+$", "");
        pdfTimeout = pdfTimeout == null ? Duration.ofSeconds(60) : pdfTimeout;
    }
}
