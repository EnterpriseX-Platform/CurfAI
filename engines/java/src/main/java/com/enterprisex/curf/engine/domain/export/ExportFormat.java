package com.enterprisex.curf.engine.domain.export;

/** The file formats a report can be exported to. */
public enum ExportFormat {
    CSV("csv", "text/csv; charset=utf-8"),
    XLSX("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    DOCX("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    PDF("pdf", "application/pdf");

    private final String extension;
    private final String contentType;

    ExportFormat(String extension, String contentType) {
        this.extension = extension;
        this.contentType = contentType;
    }

    public String extension() {
        return extension;
    }

    public String contentType() {
        return contentType;
    }
}
