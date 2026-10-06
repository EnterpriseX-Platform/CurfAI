package com.enterprisex.curf.engine.domain.report;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.domain.report.ReportAccess.Level;
import com.enterprisex.curf.engine.domain.report.ReportShare.Permission;
import com.enterprisex.curf.engine.domain.report.ReportShare.SubjectType;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class ReportAccessTest {

    private static final Instant NOW = Instant.parse("2026-10-05T00:00:00Z");
    private static final Function<String, Set<String>> NO_ATTRIBUTES = a -> Set.of();

    private static Viewer viewer(Set<String> roles, Set<String> groups, com.enterprisex.curf.engine.domain.viewer.Permission... permissions) {
        return new Viewer("t", "u1", "u1", roles, groups, Map.of(), Set.of(permissions));
    }

    private static Level level(Viewer v, Set<String> runRoles, List<ReportShare> shares) {
        return ReportAccess.resolve(v, runRoles, shares, NOW, NO_ATTRIBUTES);
    }

    @Test
    void nobodyHasAccessByDefault() {
        assertThat(level(viewer(Set.of("analyst"), Set.of()), Set.of(), List.of())).isEqualTo(Level.NONE);
    }

    @Test
    void theEditPermissionGivesEditEverywhere() {
        assertThat(level(viewer(Set.of(), Set.of(), com.enterprisex.curf.engine.domain.viewer.Permission.REPORT_EDIT), Set.of(), List.of()))
                .isEqualTo(Level.EDIT);
    }

    @Test
    void aRunRoleGivesView() {
        assertThat(level(viewer(Set.of("analyst"), Set.of()), Set.of("analyst"), List.of())).isEqualTo(Level.VIEW);
    }

    @Test
    void sharesWithAUserOrGroupRaiseTheLevel() {
        Viewer v = viewer(Set.of(), Set.of("finance"));
        assertThat(level(v, Set.of(), List.of(new ReportShare(SubjectType.USER, "u1", Permission.VIEW, null)))).isEqualTo(Level.VIEW);
        assertThat(level(v, Set.of(), List.of(new ReportShare(SubjectType.GROUP, "finance", Permission.EDIT, null)))).isEqualTo(Level.EDIT);
        assertThat(level(v, Set.of(), List.of(new ReportShare(SubjectType.GROUP, "other", Permission.EDIT, null)))).isEqualTo(Level.NONE);
        assertThat(level(v, Set.of(), List.of(new ReportShare(SubjectType.USER, "someone-else", Permission.EDIT, null)))).isEqualTo(Level.NONE);
    }

    @Test
    void theHighestLevelWins() {
        Viewer v = viewer(Set.of("analyst"), Set.of());
        assertThat(level(v, Set.of("analyst"), List.of(new ReportShare(SubjectType.USER, "u1", Permission.EDIT, null)))).isEqualTo(Level.EDIT);
    }

    @Test
    void anExpiredShareGrantsNothing() {
        Viewer v = viewer(Set.of(), Set.of());
        assertThat(level(v, Set.of(), List.of(new ReportShare(SubjectType.USER, "u1", Permission.EDIT, NOW)))).isEqualTo(Level.NONE);
        assertThat(level(v, Set.of(), List.of(new ReportShare(SubjectType.USER, "u1", Permission.EDIT, NOW.plusSeconds(1))))).isEqualTo(Level.EDIT);
    }

    @Test
    void anAttributeShareMatchesTheViewersValues() {
        Viewer v = viewer(Set.of(), Set.of());
        Function<String, Set<String>> values = a -> a.equals("agency_code") ? Set.of("A001", "A002") : Set.of();
        List<ReportShare> shares = List.of(new ReportShare(SubjectType.ATTRIBUTE, "agency_code=A002", Permission.VIEW, null));

        assertThat(ReportAccess.resolve(v, Set.of(), shares, NOW, values)).isEqualTo(Level.VIEW);
        assertThat(ReportAccess.resolve(v, Set.of(), List.of(new ReportShare(SubjectType.ATTRIBUTE, "agency_code=A999", Permission.VIEW, null)), NOW, values))
                .isEqualTo(Level.NONE);
        assertThat(ReportAccess.resolve(v, Set.of(), List.of(new ReportShare(SubjectType.ATTRIBUTE, "malformed", Permission.VIEW, null)), NOW, values))
                .isEqualTo(Level.NONE);
    }

    @Test
    void thePublicAndAnonymousHaveNoAccessEvenWithARunRole() {
        Set<String> roles = Set.of("public");
        assertThat(level(Viewer.publicLink("t", "link-1"), roles, List.of(new ReportShare(SubjectType.USER, "public:link-1", Permission.EDIT, null))))
                .isEqualTo(Level.NONE);
        assertThat(level(Viewer.ANONYMOUS, roles, List.of())).isEqualTo(Level.NONE);
    }
}
