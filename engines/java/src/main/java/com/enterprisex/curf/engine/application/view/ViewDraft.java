package com.enterprisex.curf.engine.application.view;

import com.enterprisex.curf.engine.domain.view.PiiMode;
import com.enterprisex.curf.engine.domain.view.RlsRule;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * What an administrator supplies. {@code columns} is optional: when absent, the columns are read from the
 * statement and the PII treatment is suggested from their names and applied (secure by default).
 * When present it lists only what to override; types always come from the database.
 */
public record ViewDraft(
        String name,
        String description,
        UUID connectionId,
        String sql,
        List<ColumnDraft> columns,
        Set<String> allowedRoles,
        Set<String> piiRoles,
        Set<String> bypassRoles,
        List<RlsRule> rlsRules,
        Integer refreshSeconds,
        Map<String, Object> sampleParams) {

    public record ColumnDraft(String name, String label, String description, PiiMode pii) {}
}
