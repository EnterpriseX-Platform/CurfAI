package com.enterprisex.curf.engine.domain.view;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.domain.view.ViewPolicy.Access;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class ViewPolicyTest {

    static View view(Set<String> pii, Set<String> bypass, List<RlsRule> rules) {
        return new View(UUID.randomUUID(), "t", "v", null, UUID.randomUUID(), "select 1",
                List.of(new ViewColumn("id", "int4", null, null, PiiMode.NONE),
                        new ViewColumn("agency_code", "varchar", null, null, PiiMode.NONE),
                        new ViewColumn("email", "varchar", null, null, PiiMode.MASK),
                        new ViewColumn("national_id", "varchar", null, null, PiiMode.HIDE)),
                Set.of("analyst"), pii, bypass, rules, null, 1, 1, Instant.EPOCH, "x", Instant.EPOCH, "x");
    }

    static Viewer viewer(Set<String> roles, Map<String, Set<String>> attributes, Permission... permissions) {
        return new Viewer("t", "u", "u", roles, Set.of(), attributes, Set.of(permissions));
    }

    static final Function<String, Set<String>> NO_ATTRIBUTES = a -> Set.of();
    static final List<RlsRule> AGENCY_RULE = List.of(new RlsRule("agency_code", RlsRule.Operator.EQ, "agency_code"));

    private static List<String> names(Access a) {
        return a.columns().stream().map(c -> c.column().name()).toList();
    }

    private static boolean masked(Access a, String column) {
        return a.columns().stream().filter(c -> c.column().name().equals(column)).findFirst().orElseThrow().masked();
    }

    // ------------------------------------------------------------------ columns

    @Test
    void anOrdinaryViewerSeesMaskedAndNoHiddenColumns() {
        Access a = ViewPolicy.resolve(view(Set.of("hr"), Set.of(), List.of()), viewer(Set.of("analyst"), Map.of()), NO_ATTRIBUTES);

        assertThat(names(a)).containsExactly("id", "agency_code", "email");
        assertThat(masked(a, "email")).isTrue();
        assertThat(masked(a, "id")).isFalse();
        assertThat(a.seesPii()).isFalse();
    }

    @Test
    void aPiiRoleSeesEverythingUnmasked() {
        Access a = ViewPolicy.resolve(view(Set.of("hr"), Set.of(), List.of()), viewer(Set.of("hr"), Map.of()), NO_ATTRIBUTES);

        assertThat(names(a)).containsExactly("id", "agency_code", "email", "national_id");
        assertThat(masked(a, "email")).isFalse();
        assertThat(a.seesPii()).isTrue();
    }

    @Test
    void managingViewsDoesNotImplyPii() {
        Access a = ViewPolicy.resolve(view(Set.of("hr"), Set.of(), List.of()),
                viewer(Set.of("curf-admin"), Map.of(), Permission.VIEW_MANAGE), NO_ATTRIBUTES);

        assertThat(a.seesPii()).isFalse();
        assertThat(names(a)).doesNotContain("national_id");
    }

    @Test
    void theAnonymousViewerNeverSeesPiiEvenIfTheViewListsNoRoles() {
        Access a = ViewPolicy.resolve(view(Set.of("hr"), Set.of(), List.of()), Viewer.ANONYMOUS, NO_ATTRIBUTES);

        assertThat(a.seesPii()).isFalse();
        assertThat(names(a)).containsExactly("id", "agency_code", "email");
        assertThat(masked(a, "email")).isTrue();
    }

    // ------------------------------------------------------------------ rows

    @Test
    void noRulesMeansEveryRow() {
        Access a = ViewPolicy.resolve(view(Set.of(), Set.of(), List.of()), viewer(Set.of("analyst"), Map.of()), NO_ATTRIBUTES);
        assertThat(a.rows()).isInstanceOf(ViewPolicy.Unrestricted.class);
    }

    @Test
    void aRuleRestrictsToTheViewersValues() {
        Access a = ViewPolicy.resolve(view(Set.of(), Set.of(), AGENCY_RULE), viewer(Set.of("analyst"), Map.of()),
                attribute -> Set.of("A001", "A002"));

        assertThat(a.rows()).isInstanceOfSatisfying(ViewPolicy.Restricted.class, r -> {
            assertThat(r.rules()).hasSize(1);
            assertThat(r.rules().get(0).values()).containsExactlyInAnyOrder("A001", "A002");
        });
    }

    @Test
    void aViewerWithNoValueSeesNoRowsRatherThanAllRows() {
        Access a = ViewPolicy.resolve(view(Set.of(), Set.of(), AGENCY_RULE), viewer(Set.of("analyst"), Map.of()), NO_ATTRIBUTES);
        assertThat(a.rows()).isInstanceOf(ViewPolicy.Denied.class);
    }

    @Test
    void oneMissingAttributeAmongSeveralRulesDeniesEverything() {
        List<RlsRule> rules = List.of(
                new RlsRule("agency_code", RlsRule.Operator.EQ, "agency_code"),
                new RlsRule("id", RlsRule.Operator.IN, "org_unit"));
        Access a = ViewPolicy.resolve(view(Set.of(), Set.of(), rules), viewer(Set.of("analyst"), Map.of()),
                attribute -> attribute.equals("agency_code") ? Set.of("A001") : Set.of());
        assertThat(a.rows()).isInstanceOf(ViewPolicy.Denied.class);
    }

    @Test
    void theAnonymousViewerIsDeniedEvenWhenTheResolverWouldAnswer() {
        Access a = ViewPolicy.resolve(view(Set.of(), Set.of(), AGENCY_RULE), Viewer.ANONYMOUS, attribute -> Set.of("A001"));
        assertThat(a.rows()).isInstanceOf(ViewPolicy.Denied.class);
    }

    @Test
    void aBypassRoleSkipsTheRules() {
        Access a = ViewPolicy.resolve(view(Set.of(), Set.of("auditor"), AGENCY_RULE), viewer(Set.of("auditor"), Map.of()), NO_ATTRIBUTES);
        assertThat(a.rows()).isInstanceOf(ViewPolicy.Unrestricted.class);
    }

    // ------------------------------------------------------------------ who may query

    @Test
    void managersAndAllowedRolesMayQueryOthersMayNot() {
        View v = view(Set.of(), Set.of(), List.of());
        assertThat(ViewPolicy.mayQuery(v, viewer(Set.of("analyst"), Map.of()))).isTrue();
        assertThat(ViewPolicy.mayQuery(v, viewer(Set.of("other"), Map.of()))).isFalse();
        assertThat(ViewPolicy.mayQuery(v, viewer(Set.of(), Map.of(), Permission.VIEW_MANAGE))).isTrue();
        assertThat(ViewPolicy.mayQuery(v, Viewer.ANONYMOUS)).isFalse();
    }

    // ------------------------------------------------------------------ cache profile

    @Test
    void theProfileChangesWithAnythingThatChangesWhatIsSeen() {
        View v = view(Set.of("hr"), Set.of(), AGENCY_RULE);
        String a = ViewPolicy.resolve(v, viewer(Set.of("analyst"), Map.of()), x -> Set.of("A001")).profile();
        String same = ViewPolicy.resolve(v, viewer(Set.of("analyst"), Map.of()), x -> Set.of("A001")).profile();
        String otherAgency = ViewPolicy.resolve(v, viewer(Set.of("analyst"), Map.of()), x -> Set.of("A002")).profile();
        String withPii = ViewPolicy.resolve(v, viewer(Set.of("hr"), Map.of()), x -> Set.of("A001")).profile();

        assertThat(a).isEqualTo(same).isNotEqualTo(otherAgency).isNotEqualTo(withPii);
    }
}
