package com.enterprisex.curf.engine.application.schedule;

import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * A report sent on a timetable: every fire of {@code cron} (five fields, in {@code timezone}) runs the report as
 * {@code runAs}, writes {@code format}, and mails the file to {@code recipients}. {@code nextRunAt} is the next fire.
 */
public record Schedule(
        UUID id,
        String tenantId,
        UUID reportId,
        String name,
        String cron,
        String timezone,
        ExportFormat format,
        String locale,
        Map<String, Object> params,
        List<String> recipients,
        ViewerSnapshot runAs,
        boolean enabled,
        Instant nextRunAt,
        Instant createdAt,
        String createdBy,
        Instant updatedAt,
        String updatedBy) {

    public Schedule {
        params = params == null ? Map.of() : Map.copyOf(params);
        recipients = List.copyOf(recipients);
    }
}
