package com.enterprisex.curf.engine.domain.report;

import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * What a person may do with one report, from every way access can come: the permission to edit reports, the
 * report's own run roles, and shares with them, their groups or an attribute they hold. The highest level wins.
 * Nobody who is not signed in has any access here; the public reaches reports only through a public link.
 */
public final class ReportAccess {

    public enum Level {
        NONE,
        /** May run the published version. */
        VIEW,
        /** May also change the report and see its working copy. */
        EDIT;

        public boolean atLeast(Level other) {
            return compareTo(other) >= 0;
        }
    }

    private ReportAccess() {}

    /** @param attributeValues the viewer's values for an attribute (token claim, else the entitlement table) */
    public static Level resolve(
            Viewer viewer, Set<String> runRoles, List<ReportShare> shares, Instant now, Function<String, Set<String>> attributeValues) {
        if (viewer.isAnonymous()) {
            return Level.NONE;
        }
        if (viewer.can(Permission.REPORT_EDIT)) {
            return Level.EDIT;
        }
        Level level = Collections.disjoint(runRoles, viewer.roles()) ? Level.NONE : Level.VIEW;
        for (ReportShare share : shares) {
            if (share.expired(now) || !matches(share, viewer, attributeValues)) {
                continue;
            }
            Level granted = share.permission() == ReportShare.Permission.EDIT ? Level.EDIT : Level.VIEW;
            if (granted.compareTo(level) > 0) {
                level = granted;
            }
        }
        return level;
    }

    private static boolean matches(ReportShare share, Viewer viewer, Function<String, Set<String>> attributeValues) {
        return switch (share.subjectType()) {
            case USER -> share.subjectId().equals(viewer.subject());
            case GROUP -> viewer.groups().contains(share.subjectId());
            case ATTRIBUTE -> {
                int eq = share.subjectId().indexOf('=');
                yield eq > 0 && attributeValues.apply(share.subjectId().substring(0, eq)).contains(share.subjectId().substring(eq + 1));
            }
        };
    }
}
