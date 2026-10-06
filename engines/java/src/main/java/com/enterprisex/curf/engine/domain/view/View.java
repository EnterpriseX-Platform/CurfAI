package com.enterprisex.curf.engine.domain.view;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * The unit of governed access. {@code sql} is the administrator's SELECT, already checked by the SQL
 * guard. Viewers never run it directly: it is wrapped so that row rules and masking apply first.
 *
 * <ul>
 *   <li>{@code allowedRoles}: roles that may query the published view (managers always may);
 *   <li>{@code piiRoles}: roles that see MASK and HIDE columns unmasked;
 *   <li>{@code bypassRoles}: roles exempt from the row rules (for example auditors);
 *   <li>{@code refreshSeconds}: how old a cached answer may be by default; null or 0 means always fresh.
 * </ul>
 */
public record View(
        UUID id,
        String tenantId,
        String name,
        String description,
        UUID connectionId,
        String sql,
        List<ViewColumn> columns,
        Set<String> allowedRoles,
        Set<String> piiRoles,
        Set<String> bypassRoles,
        List<RlsRule> rlsRules,
        Integer refreshSeconds,
        int version,
        Integer publishedVersion,
        Instant createdAt,
        String createdBy,
        Instant updatedAt,
        String updatedBy) {

    public View {
        columns = List.copyOf(columns);
        allowedRoles = Set.copyOf(allowedRoles);
        piiRoles = Set.copyOf(piiRoles);
        bypassRoles = Set.copyOf(bypassRoles);
        rlsRules = List.copyOf(rlsRules);
    }

    public ViewColumn column(String name) {
        return columns.stream().filter(c -> c.name().equals(name)).findFirst().orElse(null);
    }
}
