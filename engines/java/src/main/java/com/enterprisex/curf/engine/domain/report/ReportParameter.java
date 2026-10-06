package com.enterprisex.curf.engine.domain.report;

import java.util.List;

/** A parameter a report declares, as Curf defines it. {@code defaultValue} is used as is, never coerced. */
public record ReportParameter(
        String name, String label, Type type, boolean required, Object defaultValue, List<String> options) {

    public enum Type {
        STRING,
        NUMBER,
        DATE,
        DATE_RANGE,
        BOOLEAN,
        SELECT
    }

    public ReportParameter {
        options = options == null ? List.of() : List.copyOf(options);
    }
}
