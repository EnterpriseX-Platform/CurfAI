package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.domain.export.ExportFormat;
import java.time.Instant;
import java.util.UUID;

/** A stored file. Only its creator may download it, and it is deleted when {@code expiresAt} passes. */
public record Export(
        UUID id,
        String tenantId,
        UUID reportId,
        String reportName,
        ExportFormat format,
        String fileName,
        long sizeBytes,
        String sha256,
        String asOf,
        Instant createdAt,
        String createdBy,
        Instant expiresAt) {}
