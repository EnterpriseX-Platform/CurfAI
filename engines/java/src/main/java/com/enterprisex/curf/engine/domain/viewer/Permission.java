package com.enterprisex.curf.engine.domain.viewer;

/** What a viewer may do. Roles map to permissions by configuration, never in code paths. */
public enum Permission {
    CONNECTION_MANAGE("connection:manage"),
    VIEW_MANAGE("view:manage"),
    REPORT_EDIT("report:edit"),
    REPORT_PUBLISH_REQUEST("report:publish-request"),
    REPORT_APPROVE("report:approve"),
    SCHEDULE_MANAGE("schedule:manage"),
    POLICY_MANAGE("policy:manage"),
    AUDIT_READ("audit:read");

    private final String key;

    Permission(String key) {
        this.key = key;
    }

    /** The name used in the API, for example {@code audit:read}. */
    public String key() {
        return key;
    }
}
