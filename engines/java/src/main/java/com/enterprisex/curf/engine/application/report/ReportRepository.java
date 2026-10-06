package com.enterprisex.curf.engine.application.report;

import com.enterprisex.curf.engine.application.common.PageResult;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import tools.jackson.databind.JsonNode;

/** Port. Every method is scoped by tenant. Every save also keeps a numbered copy of the definition. */
public interface ReportRepository {

    record VersionInfo(int version, Instant savedAt, String savedBy, String note) {}

    void insert(Report report, String note);

    Optional<Report> find(String tenantId, UUID id);

    PageResult<Report> list(String tenantId, int page, int size);

    /** Every report of the tenant (bounded), for building a catalogue of what a viewer may run. */
    List<Report> listAll(String tenantId);

    /** Saves only if {@code expectedVersion} is still current; returns false when it is not. */
    boolean update(Report report, int expectedVersion, String note);

    boolean delete(String tenantId, UUID id);

    /** Points the published version at a saved version, or at none (null) to unpublish. */
    void setPublishedVersion(String tenantId, UUID id, Integer version);

    List<VersionInfo> versions(String tenantId, UUID id);

    Optional<JsonNode> versionDefinition(String tenantId, UUID id, int version);

    boolean nameTaken(String tenantId, String name, UUID exceptIdOrNull);
}
