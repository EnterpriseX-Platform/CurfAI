package com.enterprisex.curf.engine.application.report;

import java.time.Instant;
import java.util.Set;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/**
 * A stored report: Curf's own definition JSON, kept as it was sent. {@code version} is the newest saved version (the
 * working copy); {@code publishedVersion} is the one a checker approved, which is what people who can only run the
 * report get. {@code runRoles} are roles that may run it; shares and the permission to edit reports add to that.
 */
public record Report(
        UUID id,
        String tenantId,
        String name,
        JsonNode definition,
        Set<String> runRoles,
        int version,
        Integer publishedVersion,
        Instant createdAt,
        String createdBy,
        Instant updatedAt,
        String updatedBy) {

    public Report {
        runRoles = Set.copyOf(runRoles);
    }
}
