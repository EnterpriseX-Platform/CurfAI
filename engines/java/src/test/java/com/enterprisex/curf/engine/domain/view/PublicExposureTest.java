package com.enterprisex.curf.engine.domain.view;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class PublicExposureTest {

    private static View view(Set<String> allowed, Set<String> pii, Set<String> bypass, List<RlsRule> rules, ViewColumn... columns) {
        return new View(UUID.randomUUID(), "t", "v", null, UUID.randomUUID(), "select 1", List.of(columns), allowed, pii, bypass, rules,
                null, 1, 1, Instant.EPOCH, "x", Instant.EPOCH, "x");
    }

    private static ViewColumn column(String name, PiiMode pii) {
        return new ViewColumn(name, "varchar", null, null, pii);
    }

    @Test
    void aPlainAggregateViewCanBePublic() {
        View v = view(Set.of("public"), Set.of(), Set.of(), List.of(), column("province", PiiMode.NONE), column("total", PiiMode.NONE));

        assertThat(PublicExposure.offeredToPublic(v)).isTrue();
        assertThat(PublicExposure.problems(v)).isEmpty();
    }

    @Test
    void aViewNotListingPublicIsNotOffered() {
        assertThat(PublicExposure.offeredToPublic(view(Set.of("analyst"), Set.of(), Set.of(), List.of(), column("a", PiiMode.NONE)))).isFalse();
    }

    @Test
    void rowRulesBlockPublicExposure() {
        View v = view(Set.of("public"), Set.of(), Set.of(), List.of(new RlsRule("agency_code", RlsRule.Operator.EQ, "agency_code")),
                column("agency_code", PiiMode.NONE));

        assertThat(PublicExposure.problems(v)).singleElement().asString().contains("row rules");
    }

    @Test
    void publicMustNotHoldPiiOrBypassRoles() {
        View v = view(Set.of("public"), Set.of("public"), Set.of("public"), List.of(), column("a", PiiMode.NONE));

        assertThat(PublicExposure.problems(v)).hasSize(2);
    }

    @Test
    void anUnmaskedPersonalLookingColumnBlocksPublicExposure() {
        View v = view(Set.of("public"), Set.of(), Set.of(), List.of(), column("email", PiiMode.NONE), column("phone", PiiMode.MASK),
                column("national_id", PiiMode.HIDE));

        assertThat(PublicExposure.problems(v)).singleElement().asString().contains("email");
    }
}
