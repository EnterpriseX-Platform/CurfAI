package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.query.QueryRequest;
import com.enterprisex.curf.engine.application.query.QueryResult;
import com.enterprisex.curf.engine.application.view.ViewDraft;
import com.enterprisex.curf.engine.application.view.ViewDraft.ColumnDraft;
import com.enterprisex.curf.engine.application.view.ViewRepository.VersionInfo;
import com.enterprisex.curf.engine.application.view.ViewService;
import com.enterprisex.curf.engine.application.view.ViewSummary;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.view.RlsRule;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewColumn;
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

@RestController
@RequestMapping("/engine/v1/views")
public class ViewController {

    public record ViewRequest(
            String name, String description, UUID connectionId, String sql, List<ColumnDraft> columns,
            Set<String> allowedRoles, Set<String> piiRoles, Set<String> bypassRoles, List<RlsRule> rlsRules,
            Integer refreshSeconds, Map<String, Object> sampleParams, Integer version) {

        ViewDraft toDraft() {
            return new ViewDraft(name, description, connectionId, sql, columns, allowedRoles, piiRoles, bypassRoles,
                    rlsRules, refreshSeconds, sampleParams);
        }
    }

    /** The full definition, for managers. */
    public record ViewResponse(
            UUID id, String name, String description, UUID connectionId, String sql, List<ViewColumn> columns,
            Set<String> allowedRoles, Set<String> piiRoles, Set<String> bypassRoles, List<RlsRule> rlsRules,
            Integer refreshSeconds, int version, Integer publishedVersion, Instant createdAt, String createdBy,
            Instant updatedAt, String updatedBy) {

        static ViewResponse of(View v) {
            return new ViewResponse(v.id(), v.name(), v.description(), v.connectionId(), v.sql(), v.columns(),
                    new TreeSet<>(v.allowedRoles()), new TreeSet<>(v.piiRoles()), new TreeSet<>(v.bypassRoles()), v.rlsRules(),
                    v.refreshSeconds(), v.version(), v.publishedVersion(), v.createdAt(), v.createdBy(), v.updatedAt(), v.updatedBy());
        }
    }

    private final ViewService service;

    public ViewController(ViewService service) {
        this.service = service;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    ViewResponse create(Viewer viewer, @RequestBody ViewRequest body) {
        return ViewResponse.of(service.create(viewer, body.toDraft()));
    }

    /** Managers see every view's full definition; everyone else sees the published views they may query. */
    @GetMapping
    Object list(Viewer viewer, @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "50") int size) {
        if (viewer.can(Permission.VIEW_MANAGE)) {
            PageResult<View> result = service.list(viewer, page, size);
            return new PageResult<>(result.content().stream().map(ViewResponse::of).toList(), result.page(), result.size(), result.totalElements());
        }
        return service.catalogue(viewer);
    }

    @GetMapping("/{id}")
    Object get(Viewer viewer, @PathVariable UUID id) {
        if (viewer.can(Permission.VIEW_MANAGE)) {
            return ViewResponse.of(service.get(viewer, id));
        }
        return service.summaryOf(viewer, id);
    }

    @GetMapping("/{id}/summary")
    ViewSummary summary(Viewer viewer, @PathVariable UUID id) {
        return service.summaryOf(viewer, id);
    }

    @PutMapping("/{id}")
    ViewResponse update(Viewer viewer, @PathVariable UUID id, @RequestBody ViewRequest body) {
        if (body.version() == null) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                    List.of(new FieldError("version", "is required so concurrent edits are detected")));
        }
        return ViewResponse.of(service.update(viewer, id, body.toDraft(), body.version()));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void delete(Viewer viewer, @PathVariable UUID id) {
        service.delete(viewer, id);
    }

    @PostMapping("/{id}/preview")
    QueryResult preview(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) QueryRequest body) {
        QueryRequest request = body == null ? QueryRequest.raw(null, null, null) : body;
        return service.preview(viewer, id, request);
    }

    @PostMapping("/{id}/publish")
    ViewResponse publish(Viewer viewer, @PathVariable UUID id) {
        return ViewResponse.of(service.publish(viewer, id));
    }

    @PostMapping("/{id}/unpublish")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void unpublish(Viewer viewer, @PathVariable UUID id) {
        service.unpublish(viewer, id);
    }

    @GetMapping("/{id}/versions")
    List<VersionInfo> versions(Viewer viewer, @PathVariable UUID id) {
        return service.versions(viewer, id);
    }
}
