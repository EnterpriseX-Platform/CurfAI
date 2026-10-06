package com.enterprisex.curf.engine.application.sharing;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.report.Report;
import com.enterprisex.curf.engine.application.report.ReportRepository;
import com.enterprisex.curf.engine.application.sharing.PublishRequest.State;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.report.ReportAccess.Level;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

/**
 * Maker and checker. One person asks for a saved version of a report to be published; a different person with the
 * approval permission decides. Approving publishes exactly the version that was asked for, so changes made after the
 * request cannot ride along unseen: the request goes stale instead.
 */
@Service
public class PublishService {

    private static final int MAX_NOTE = 500;

    private final ReportRepository reports;
    private final PublishRequestRepository requests;
    private final ReportAccessService access;
    private final AuditService audit;
    private final Clock clock;

    public PublishService(
            ReportRepository reports, PublishRequestRepository requests, ReportAccessService access, AuditService audit, Clock clock) {
        this.reports = reports;
        this.requests = requests;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    public PublishRequest request(Viewer viewer, UUID reportId, String note) {
        require(viewer, Permission.REPORT_PUBLISH_REQUEST, "Asking to publish a report requires the report:publish-request permission");
        Report report = report(viewer, reportId);
        access.require(viewer, report, Level.EDIT);
        if (report.publishedVersion() != null && report.publishedVersion() == report.version()) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "The latest version is already published");
        }
        if (requests.pendingFor(viewer.tenantId(), reportId).isPresent()) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "A publish request for this report is already waiting for a decision");
        }
        PublishRequest request = new PublishRequest(UUID.randomUUID(), viewer.tenantId(), reportId, report.version(), State.PENDING,
                viewer.subject(), clock.instant(), clip(note), null, null, null);
        try {
            requests.insert(request);
        } catch (DuplicateKeyException e) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "A publish request for this report is already waiting for a decision");
        }
        audit.record(viewer, "report.publish-request", "report", reportId.toString(), Map.of("version", report.version(), "requestId", request.id().toString()));
        return request;
    }

    public PublishRequest approve(Viewer viewer, UUID requestId, String note) {
        require(viewer, Permission.REPORT_APPROVE, "Approving a publish request requires the report:approve permission");
        PublishRequest request = pending(viewer, requestId);
        if (request.requestedBy().equals(viewer.subject())) {
            throw new EngineException(ErrorCode.CURF_SEGREGATION_OF_DUTIES, "You asked for this publication; someone else must approve it");
        }
        Report report = report(viewer, request.reportId());
        if (report.version() != request.version()) {
            throw new EngineException(ErrorCode.CURF_STALE_VERSION,
                    "The report was saved after this request (version " + request.version() + " is now " + report.version()
                            + "); reject it and ask again");
        }
        Instant now = clock.instant();
        if (!requests.decide(viewer.tenantId(), requestId, State.APPROVED, viewer.subject(), now, clip(note))) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "This request was already decided");
        }
        reports.setPublishedVersion(viewer.tenantId(), report.id(), request.version());
        audit.record(viewer, "report.publish", "report", report.id().toString(), Map.of("version", request.version(), "requestId", requestId.toString()));
        return requests.find(viewer.tenantId(), requestId).orElseThrow();
    }

    public PublishRequest reject(Viewer viewer, UUID requestId, String note) {
        require(viewer, Permission.REPORT_APPROVE, "Rejecting a publish request requires the report:approve permission");
        if (note == null || note.isBlank()) {
            throw invalid("note", "is required: say why the request is rejected");
        }
        PublishRequest request = pending(viewer, requestId);
        if (!requests.decide(viewer.tenantId(), requestId, State.REJECTED, viewer.subject(), clock.instant(), clip(note))) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "This request was already decided");
        }
        audit.record(viewer, "report.publish-reject", "report", request.reportId().toString(), Map.of("requestId", requestId.toString()));
        return requests.find(viewer.tenantId(), requestId).orElseThrow();
    }

    /** The person who asked may withdraw their own request. */
    public PublishRequest cancel(Viewer viewer, UUID requestId) {
        PublishRequest request = pending(viewer, requestId);
        if (!request.requestedBy().equals(viewer.subject())) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Only the person who asked can withdraw the request");
        }
        if (!requests.decide(viewer.tenantId(), requestId, State.CANCELLED, viewer.subject(), clock.instant(), null)) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "This request was already decided");
        }
        audit.record(viewer, "report.publish-cancel", "report", request.reportId().toString(), Map.of("requestId", requestId.toString()));
        return requests.find(viewer.tenantId(), requestId).orElseThrow();
    }

    /** Takes a report back from everyone who only runs it; public links stop working at once. */
    public void unpublish(Viewer viewer, UUID reportId, String reason) {
        if (!viewer.can(Permission.REPORT_APPROVE) && !viewer.can(Permission.REPORT_EDIT)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Unpublishing a report requires the report:approve or report:edit permission");
        }
        if (reason == null || reason.isBlank()) {
            throw invalid("reason", "is required: say why the report is withdrawn");
        }
        Report report = report(viewer, reportId);
        if (report.publishedVersion() == null) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "The report is not published");
        }
        reports.setPublishedVersion(viewer.tenantId(), reportId, null);
        audit.record(viewer, "report.unpublish", "report", reportId.toString(), Map.of("reason", clip(reason), "version", report.publishedVersion()));
    }

    public PublishRequest get(Viewer viewer, UUID requestId) {
        PublishRequest request = requests.find(viewer.tenantId(), requestId).orElseThrow(PublishService::notFound);
        if (!viewer.can(Permission.REPORT_APPROVE) && !request.requestedBy().equals(viewer.subject())) {
            throw notFound();
        }
        return request;
    }

    public PageResult<PublishRequest> byState(Viewer viewer, State state, int page, int size) {
        require(viewer, Permission.REPORT_APPROVE, "Listing publish requests requires the report:approve permission");
        if (page < 0 || size < 1 || size > 200) {
            throw invalid("size", "page must be >= 0 and size between 1 and 200");
        }
        return requests.byState(viewer.tenantId(), state == null ? State.PENDING : state, page, size);
    }

    public List<PublishRequest> forReport(Viewer viewer, UUID reportId) {
        Report report = report(viewer, reportId);
        access.require(viewer, report, Level.EDIT);
        return requests.forReport(viewer.tenantId(), reportId);
    }

    private PublishRequest pending(Viewer viewer, UUID requestId) {
        PublishRequest request = requests.find(viewer.tenantId(), requestId).orElseThrow(PublishService::notFound);
        if (request.state() != State.PENDING) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "This request was already decided");
        }
        return request;
    }

    private Report report(Viewer viewer, UUID id) {
        return reports.find(viewer.tenantId(), id).orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report"));
    }

    private static void require(Viewer viewer, Permission permission, String message) {
        if (!viewer.can(permission)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, message);
        }
    }

    private static String clip(String note) {
        if (note == null || note.isBlank()) {
            return null;
        }
        return note.length() > MAX_NOTE ? note.substring(0, MAX_NOTE) : note;
    }

    private static EngineException notFound() {
        return new EngineException(ErrorCode.CURF_NOT_FOUND, "No such publish request");
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }
}
