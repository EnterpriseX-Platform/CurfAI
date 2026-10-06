package com.enterprisex.curf.engine.application.sharing;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.query.QueryProperties;
import com.enterprisex.curf.engine.application.report.Report;
import com.enterprisex.curf.engine.application.report.ReportDefinitions;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.Parsed;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.QueryDef;
import com.enterprisex.curf.engine.application.report.ReportRepository;
import com.enterprisex.curf.engine.application.report.ReportRunService;
import com.enterprisex.curf.engine.application.report.ReportRunService.Resolved;
import com.enterprisex.curf.engine.application.report.ReportService;
import com.enterprisex.curf.engine.application.report.ReportService.RunnableView;
import com.enterprisex.curf.engine.application.report.RunResult;
import com.enterprisex.curf.engine.application.sharing.PublicLink.Kind;
import com.enterprisex.curf.engine.application.view.ViewRepository;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.report.ReportAccess.Level;
import com.enterprisex.curf.engine.domain.report.ReportParams;
import com.enterprisex.curf.engine.domain.view.PublicExposure;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Lets someone without an account run a published report, through a link or an embed token. The secret is shown once
 * and only its hash is kept, so it cannot be recovered; revoking, expiring or unpublishing the report stops it at once.
 * The public runs as a viewer with the single role {@code public}: only views that list that role and pass the exposure
 * check are reachable, and a report with a raw SQL query can never be public.
 */
@Service
public class PublicLinkService {

    public static final String TOKEN_PREFIX = "cpl_";
    private static final SecureRandom RANDOM = new SecureRandom();

    /** What creating a link returns: the link, and the secret that is never shown again. */
    public record Created(PublicLink link, String token) {}

    private final ReportRepository reports;
    private final PublicLinkRepository links;
    private final ViewRepository views;
    private final ReportAccessService access;
    private final ReportDefinitions definitions;
    private final ReportRunService runs;
    private final ReportService reportService;
    private final QueryProperties queryProps;
    private final PublicProperties props;
    private final AuditService audit;
    private final Clock clock;
    private final FixedWindowRateLimiter limiter = new FixedWindowRateLimiter();

    public PublicLinkService(
            ReportRepository reports, PublicLinkRepository links, ViewRepository views, ReportAccessService access,
            ReportDefinitions definitions, ReportRunService runs, ReportService reportService, QueryProperties queryProps,
            PublicProperties props, AuditService audit, Clock clock) {
        this.reports = reports;
        this.links = links;
        this.views = views;
        this.access = access;
        this.definitions = definitions;
        this.runs = runs;
        this.reportService = reportService;
        this.queryProps = queryProps;
        this.props = props;
        this.audit = audit;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ managing links

    public Created create(Viewer viewer, UUID reportId, Kind kind, Duration ttl, Map<String, Object> lockedParams) {
        if (kind == null) {
            throw invalid("kind", "must be PUBLIC or EMBED");
        }
        Report report = reports.find(viewer.tenantId(), reportId).orElseThrow(PublicLinkService::notFound);
        if (kind == Kind.PUBLIC) {
            if (!viewer.can(Permission.REPORT_APPROVE)) {
                throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Making a report public requires the report:approve permission");
            }
        } else {
            access.require(viewer, report, Level.EDIT);
        }
        Resolved published = runs.published(report);
        Parsed parsed = definitions.parse(published.definition());
        List<String> problems = exposureProblems(viewer.tenantId(), parsed);
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "The report cannot be shown to the public",
                    problems.stream().map(p -> new FieldError("report", p)).toList());
        }
        Map<String, Object> locked = lockedParams == null ? Map.of() : lockedParams;
        ReportParams.resolve(parsed.parameters(), locked);

        Duration limit = kind == Kind.PUBLIC ? props.linkMaxTtl() : props.embedMaxTtl();
        Duration chosen = ttl != null ? ttl : kind == Kind.PUBLIC ? props.linkDefaultTtl() : props.embedDefaultTtl();
        if (chosen.isNegative() || chosen.isZero() || chosen.compareTo(limit) > 0) {
            throw invalid("expiresInSeconds", "must be between 1 second and " + limit.toSeconds() + " seconds");
        }
        Instant now = clock.instant();
        String token = TOKEN_PREFIX + newSecret();
        PublicLink link = new PublicLink(UUID.randomUUID(), viewer.tenantId(), reportId, kind, now, viewer.subject(), now.plus(chosen), null,
                null, locked);
        links.insert(link, hash(token));
        audit.record(viewer, "public-link.create", "report", reportId.toString(),
                Map.of("linkId", link.id().toString(), "kind", kind.name(), "expiresAt", link.expiresAt().toString()));
        return new Created(link, token);
    }

    public List<PublicLink> list(Viewer viewer, UUID reportId) {
        Report report = reports.find(viewer.tenantId(), reportId).orElseThrow(PublicLinkService::notFound);
        access.require(viewer, report, Level.EDIT);
        return links.forReport(viewer.tenantId(), reportId);
    }

    public void revoke(Viewer viewer, UUID linkId) {
        PublicLink link = links.find(viewer.tenantId(), linkId).orElseThrow(PublicLinkService::notFound);
        Report report = reports.find(viewer.tenantId(), link.reportId()).orElseThrow(PublicLinkService::notFound);
        if (!viewer.can(Permission.REPORT_APPROVE)) {
            access.require(viewer, report, Level.EDIT);
        }
        if (!links.revoke(viewer.tenantId(), linkId, viewer.subject(), clock.instant())) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "The link was already revoked");
        }
        audit.record(viewer, "public-link.revoke", "report", link.reportId().toString(), Map.of("linkId", linkId.toString()));
    }

    // ------------------------------------------------------------------ using a link (no account)

    /** The report as a link holder sees it. Every failure is the same "not found". */
    public RunnableView open(String token) {
        Live live = live(token);
        return reportService.reduce(live.report(), live.resolved().version(), live.resolved().definition());
    }

    public RunResult run(String token, Map<String, Object> supplied) {
        Live live = live(token);
        if (!limiter.tryAcquire(live.link().id().toString(), props.runsPerMinute(), clock.millis())) {
            throw new EngineException(ErrorCode.CURF_TOO_MANY_QUERIES, "Too many requests for this link; try again in a minute");
        }
        Map<String, Object> params = new LinkedHashMap<>(supplied == null ? Map.of() : supplied);
        params.putAll(live.link().lockedParams());
        Viewer viewer = Viewer.publicLink(live.link().tenantId(), live.link().id().toString());
        RunResult result = runs.execute(viewer, live.resolved(), params, queryProps.maxRows());
        audit.record(viewer, "public-link.run", "report", live.report().id().toString(), Map.of("linkId", live.link().id().toString()));
        return result;
    }

    private record Live(PublicLink link, Report report, Resolved resolved) {}

    private Live live(String token) {
        if (token == null || !token.startsWith(TOKEN_PREFIX) || token.length() > 200) {
            throw notFound();
        }
        PublicLink link = links.findByTokenHash(hash(token)).filter(l -> l.usable(clock.instant())).orElseThrow(PublicLinkService::notFound);
        Report report = reports.find(link.tenantId(), link.reportId()).orElseThrow(PublicLinkService::notFound);
        Resolved resolved = runs.published(report);
        // Checked again on every use: a view may have changed since the link was made.
        if (!exposureProblems(link.tenantId(), definitions.parse(resolved.definition())).isEmpty()) {
            throw notFound();
        }
        return new Live(link, report, resolved);
    }

    // ------------------------------------------------------------------ exposure

    /** Why the report cannot go to the public: any raw SQL query, or a bound view the public may not see. */
    List<String> exposureProblems(String tenantId, Parsed parsed) {
        List<String> out = new ArrayList<>();
        for (QueryDef q : parsed.queries()) {
            if (parsed.drillOnly().contains(q.id())) {
                continue;
            }
            if (q.engine() == null) {
                out.add("query '" + q.id() + "' is raw SQL; only queries on governed views can be public");
                continue;
            }
            View view = views.findPublished(tenantId, q.engine().viewId()).orElse(null);
            if (view == null) {
                out.add("query '" + q.id() + "' uses a view that is not published");
            } else if (!PublicExposure.offeredToPublic(view)) {
                out.add("view '" + view.name() + "' is not offered to the public");
            } else {
                PublicExposure.problems(view).forEach(p -> out.add("view '" + view.name() + "' " + p));
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ secrets

    private static String newSecret() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static EngineException notFound() {
        return new EngineException(ErrorCode.CURF_NOT_FOUND, "Not found");
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }
}
