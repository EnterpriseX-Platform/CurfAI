package com.enterprisex.curf.engine.application.query;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.application.query.QueryBackend.Column;
import com.enterprisex.curf.engine.application.query.QueryBackend.RawResult;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

class FingerprintsTest {

    private static RawResult result(Object cell) {
        return new RawResult(List.of(new Column("a", "int4")), List.of(java.util.Arrays.asList(cell)), false);
    }

    @Test
    void sameInputsGiveTheSameHash() {
        assertThat(Fingerprints.provenance("select 1", Map.of("id", 1), result(1)))
                .isEqualTo(Fingerprints.provenance("select 1", Map.of("id", 1), result(1)));
    }

    @Test
    void aChangedRowSqlOrParameterChangesTheHash() {
        String base = Fingerprints.provenance("select 1", Map.of("id", 1), result(1));
        assertThat(Fingerprints.provenance("select 1", Map.of("id", 1), result(2))).isNotEqualTo(base);
        assertThat(Fingerprints.provenance("select 2", Map.of("id", 1), result(1))).isNotEqualTo(base);
        assertThat(Fingerprints.provenance("select 1", Map.of("id", 2), result(1))).isNotEqualTo(base);
        assertThat(Fingerprints.provenance("select 1", Map.of("id", "1"), result(1))).isNotEqualTo(base);
    }

    @Test
    void valueBoundariesCannotBeForged() {
        var split = new RawResult(List.of(new Column("a", "t")), List.of(List.of("ab", "c")), false);
        var other = new RawResult(List.of(new Column("a", "t")), List.of(List.of("a", "bc")), false);
        assertThat(Fingerprints.provenance("s", Map.of(), split)).isNotEqualTo(Fingerprints.provenance("s", Map.of(), other));
    }

    @Test
    void nullAndTextNullDiffer() {
        assertThat(Fingerprints.provenance("s", Map.of(), result(null)))
                .isNotEqualTo(Fingerprints.provenance("s", Map.of(), result("~")));
    }

    @Test
    void parameterOrderDoesNotMatter() {
        assertThat(Fingerprints.canonical(Map.of("a", 1, "b", 2))).isEqualTo(Fingerprints.canonical(Map.of("b", 2, "a", 1)));
    }

    @Test
    void viewerScopeSeparatesDifferentPolicies() {
        Viewer a = new Viewer("t", "u1", "u1", Set.of("r"), Set.of(), Map.of("agency", Set.of("A")), Set.of());
        Viewer sameAsA = new Viewer("t", "u2", "u2", Set.of("r"), Set.of(), Map.of("agency", Set.of("A")), Set.of());
        Viewer otherAgency = new Viewer("t", "u3", "u3", Set.of("r"), Set.of(), Map.of("agency", Set.of("B")), Set.of());
        Viewer otherTenant = new Viewer("t2", "u1", "u1", Set.of("r"), Set.of(), Map.of("agency", Set.of("A")), Set.of());

        assertThat(Fingerprints.viewerScope(a)).isEqualTo(Fingerprints.viewerScope(sameAsA));
        assertThat(Fingerprints.viewerScope(a)).isNotEqualTo(Fingerprints.viewerScope(otherAgency));
        assertThat(Fingerprints.viewerScope(a)).isNotEqualTo(Fingerprints.viewerScope(otherTenant));
    }
}
