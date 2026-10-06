package com.enterprisex.curf.engine.application.sharing;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.report.Report;
import com.enterprisex.curf.engine.application.report.ReportRepository;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.report.ReportShare;
import com.enterprisex.curf.engine.domain.report.ReportShare.SubjectType;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/** Who a report is shared with. Managing shares takes the permission to edit reports. */
@Service
public class ShareService {

    private static final int MAX_SHARES = 200;
    private static final Pattern ATTRIBUTE = Pattern.compile("[A-Za-z][A-Za-z0-9_]{0,63}=[^\\s=][^=]{0,254}");

    private final ReportRepository reports;
    private final ShareRepository shares;
    private final AuditService audit;
    private final Clock clock;

    public ShareService(ReportRepository reports, ShareRepository shares, AuditService audit, Clock clock) {
        this.reports = reports;
        this.shares = shares;
        this.audit = audit;
        this.clock = clock;
    }

    public List<ReportShare> list(Viewer viewer, UUID reportId) {
        requireManage(viewer);
        report(viewer, reportId);
        return shares.list(viewer.tenantId(), reportId);
    }

    /** Replaces every share of the report with the given set. */
    public List<ReportShare> replace(Viewer viewer, UUID reportId, List<ReportShare> wanted) {
        requireManage(viewer);
        report(viewer, reportId);
        List<ReportShare> clean = validate(wanted == null ? List.of() : wanted);
        Instant now = clock.instant();
        shares.replace(viewer.tenantId(), reportId, clean, viewer.subject(), now);
        audit.record(viewer, "report.share", "report", reportId.toString(), Map.of("shares", clean.size()));
        return shares.list(viewer.tenantId(), reportId);
    }

    private List<ReportShare> validate(List<ReportShare> wanted) {
        List<FieldError> problems = new ArrayList<>();
        if (wanted.size() > MAX_SHARES) {
            problems.add(new FieldError("shares", "at most " + MAX_SHARES + " shares per report"));
        }
        Instant now = clock.instant();
        Set<String> seen = new HashSet<>();
        List<ReportShare> out = new ArrayList<>();
        for (int i = 0; i < wanted.size(); i++) {
            ReportShare s = wanted.get(i);
            String at = "shares[" + i + "]";
            if (s == null || s.subjectType() == null || s.permission() == null || s.subjectId() == null || s.subjectId().isBlank()) {
                problems.add(new FieldError(at, "needs subjectType, subjectId and permission"));
                continue;
            }
            if (s.subjectId().length() > 255) {
                problems.add(new FieldError(at + ".subjectId", "is longer than 255 characters"));
            } else if (s.subjectType() == SubjectType.ATTRIBUTE && !ATTRIBUTE.matcher(s.subjectId()).matches()) {
                problems.add(new FieldError(at + ".subjectId", "must be name=value for an attribute"));
            }
            if (s.expiresAt() != null && !s.expiresAt().isAfter(now)) {
                problems.add(new FieldError(at + ".expiresAt", "must be in the future"));
            }
            if (!seen.add(s.subjectType() + "/" + s.subjectId())) {
                problems.add(new FieldError(at, "is a duplicate of an earlier share"));
            }
            out.add(s);
        }
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", problems);
        }
        return out;
    }

    private Report report(Viewer viewer, UUID id) {
        return reports.find(viewer.tenantId(), id).orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report"));
    }

    private static void requireManage(Viewer viewer) {
        if (!viewer.can(Permission.REPORT_EDIT)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Sharing reports requires the report:edit permission");
        }
    }
}
