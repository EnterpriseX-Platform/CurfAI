package com.enterprisex.curf.engine.application.schedule;

import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.Map;
import java.util.Set;

/**
 * Who a schedule runs as: the person who last saved it, as they were then. A scheduled run has no access token, so it
 * uses this copy, and their row rules and masking apply exactly as if they had run the report. Saving the schedule again
 * refreshes it; nobody can make a schedule run with more access than they hold themselves.
 */
public record ViewerSnapshot(
        String tenantId,
        String subject,
        String username,
        Set<String> roles,
        Set<String> groups,
        Map<String, Set<String>> attributes,
        Set<Permission> permissions) {

    public static ViewerSnapshot of(Viewer v) {
        return new ViewerSnapshot(v.tenantId(), v.subject(), v.username(), v.roles(), v.groups(), v.attributes(), v.permissions());
    }

    public Viewer toViewer() {
        return new Viewer(tenantId, subject, username, roles, groups, attributes, permissions);
    }
}
