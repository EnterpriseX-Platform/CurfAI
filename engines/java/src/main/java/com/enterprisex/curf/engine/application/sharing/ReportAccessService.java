package com.enterprisex.curf.engine.application.sharing;

import com.enterprisex.curf.engine.application.report.Report;
import com.enterprisex.curf.engine.application.view.AttributeResolver;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.report.ReportAccess;
import com.enterprisex.curf.engine.domain.report.ReportAccess.Level;
import com.enterprisex.curf.engine.domain.report.ReportShare;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/** Works out what a person may do with a report: the one place access is decided. */
@Service
public class ReportAccessService {

    private final ShareRepository shares;
    private final AttributeResolver attributes;
    private final Clock clock;

    public ReportAccessService(ShareRepository shares, AttributeResolver attributes, Clock clock) {
        this.shares = shares;
        this.attributes = attributes;
        this.clock = clock;
    }

    public Level level(Viewer viewer, Report report) {
        return ReportAccess.resolve(viewer, report.runRoles(), shares.list(viewer.tenantId(), report.id()), clock.instant(),
                attribute -> attributes.values(viewer, attribute));
    }

    /** The level for each report, reading every share once. */
    public Map<UUID, Level> levels(Viewer viewer, List<Report> reports) {
        Map<UUID, List<ReportShare>> all = shares.listAll(viewer.tenantId());
        Map<UUID, Level> out = new HashMap<>();
        for (Report report : reports) {
            out.put(report.id(), ReportAccess.resolve(viewer, report.runRoles(), all.getOrDefault(report.id(), List.of()), clock.instant(),
                    attribute -> attributes.values(viewer, attribute)));
        }
        return out;
    }

    /** Throws "no such report" unless the person has at least {@code needed}; the same answer whether it exists or not. */
    public Level require(Viewer viewer, Report report, Level needed) {
        Level level = level(viewer, report);
        if (!level.atLeast(needed) || level == Level.NONE) {
            throw new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report");
        }
        return level;
    }
}
