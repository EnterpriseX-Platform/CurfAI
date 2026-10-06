package com.enterprisex.curf.engine.domain.report;

import java.time.Instant;

/**
 * Who a report is shared with. {@code subjectId} depends on the type: the person's token subject (USER), a group
 * name from the token (GROUP), or {@code name=value} for an attribute the viewer holds, such as an agency code, so a
 * whole office can be shared with at once (ATTRIBUTE). {@code expiresAt} may be null for no expiry.
 */
public record ReportShare(SubjectType subjectType, String subjectId, Permission permission, Instant expiresAt) {

    public enum SubjectType {
        USER,
        GROUP,
        ATTRIBUTE
    }

    /** VIEW runs the published report; EDIT also changes it (and sees the working copy). */
    public enum Permission {
        VIEW,
        EDIT
    }

    public boolean expired(Instant now) {
        return expiresAt != null && !expiresAt.isAfter(now);
    }
}
