package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.util.Map;

/**
 * What to export and how it should read. Anything left out takes the engine's default or the report's own
 * setting (a report that fixes its date era or currency wins over the request).
 *
 * @param blockId CSV only: which table block to write; the first one when omitted
 */
public record ExportRequest(
        ExportFormat format, Map<String, Object> params, String locale, Calendar calendar, String currency, String blockId) {

    public enum Calendar {
        GREGORIAN,
        BUDDHIST
    }

    public ExportRequest {
        params = params == null ? Map.of() : Map.copyOf(params);
    }
}
