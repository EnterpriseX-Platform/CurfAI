package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.report.Report;
import com.enterprisex.curf.engine.application.report.ReportRepository.VersionInfo;
import com.enterprisex.curf.engine.application.report.ReportRunService;
import com.enterprisex.curf.engine.application.report.ReportService;
import com.enterprisex.curf.engine.application.report.RunResult;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.report.ReportAccess.Level;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/engine/v1/reports")
public class ReportController {

    /** {@code version} is required on update; {@code note} describes the change in the history. */
    public record ReportRequest(JsonNode definition, Set<String> runRoles, Integer version, String note) {}

    public record RunRequest(Map<String, Object> params) {}

    public record ReportResponse(
            UUID id, String name, JsonNode definition, Set<String> runRoles, int version, Integer publishedVersion,
            Instant createdAt, String createdBy, Instant updatedAt, String updatedBy) {

        static ReportResponse of(Report r) {
            return new ReportResponse(r.id(), r.name(), r.definition(), new TreeSet<>(r.runRoles()), r.version(), r.publishedVersion(),
                    r.createdAt(), r.createdBy(), r.updatedAt(), r.updatedBy());
        }
    }

    public record ReportSummary(UUID id, String name, Set<String> runRoles, int version, Integer publishedVersion, Instant updatedAt,
            String updatedBy) {

        static ReportSummary of(Report r) {
            return new ReportSummary(r.id(), r.name(), new TreeSet<>(r.runRoles()), r.version(), r.publishedVersion(), r.updatedAt(), r.updatedBy());
        }
    }

    private final ReportService service;
    private final ReportRunService runs;

    public ReportController(ReportService service, ReportRunService runs) {
        this.service = service;
        this.runs = runs;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    ReportResponse create(Viewer viewer, @RequestBody ReportRequest body) {
        return ReportResponse.of(service.create(viewer, body.definition(), body.runRoles(), body.note()));
    }

    /** Editors get a page of every report; everyone else gets the reports they may run. */
    @GetMapping
    Object list(Viewer viewer, @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "50") int size) {
        if (viewer.can(Permission.REPORT_EDIT)) {
            PageResult<Report> result = service.list(viewer, page, size);
            return new PageResult<>(result.content().stream().map(ReportSummary::of).toList(), result.page(), result.size(), result.totalElements());
        }
        return service.runnable(viewer);
    }

    @GetMapping("/{id}")
    Object get(Viewer viewer, @PathVariable UUID id) {
        if (service.level(viewer, id) == Level.EDIT) {
            return ReportResponse.of(service.get(viewer, id));
        }
        return service.forRunner(viewer, id);
    }

    @PutMapping("/{id}")
    ReportResponse update(Viewer viewer, @PathVariable UUID id, @RequestBody ReportRequest body) {
        if (body.version() == null) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                    List.of(new FieldError("version", "is required so concurrent edits are detected")));
        }
        return ReportResponse.of(service.update(viewer, id, body.definition(), body.runRoles(), body.version(), body.note()));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void delete(Viewer viewer, @PathVariable UUID id) {
        service.delete(viewer, id);
    }

    @GetMapping("/{id}/versions")
    List<VersionInfo> versions(Viewer viewer, @PathVariable UUID id) {
        return service.versions(viewer, id);
    }

    @GetMapping("/{id}/versions/{version}")
    JsonNode version(Viewer viewer, @PathVariable UUID id, @PathVariable int version) {
        return service.version(viewer, id, version);
    }

    @PostMapping("/{id}/restore/{version}")
    ReportResponse restore(Viewer viewer, @PathVariable UUID id, @PathVariable int version) {
        return ReportResponse.of(service.restore(viewer, id, version));
    }

    @PostMapping("/{id}/run")
    RunResult run(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) RunRequest body) {
        return runs.run(viewer, id, body == null ? null : body.params());
    }
}
