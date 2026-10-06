package com.enterprisex.curf.engine.application.sharing;

import com.enterprisex.curf.engine.domain.report.ReportShare;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Port. Shares belong to a report; reading is scoped to the tenant through the report. */
public interface ShareRepository {

    List<ReportShare> list(String tenantId, UUID reportId);

    /** Every share of the tenant's reports, grouped by report, for building a person's catalogue in one query. */
    Map<UUID, List<ReportShare>> listAll(String tenantId);

    /** Replaces the whole set of shares of the report. */
    void replace(String tenantId, UUID reportId, List<ReportShare> shares, String by, Instant at);
}
