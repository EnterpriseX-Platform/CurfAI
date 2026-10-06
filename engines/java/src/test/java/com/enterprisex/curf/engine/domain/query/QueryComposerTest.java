package com.enterprisex.curf.engine.domain.query;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.query.QueryComposer.Composed;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Aggregate;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.AggregateFn;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Filter;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.FilterOp;
import com.enterprisex.curf.engine.domain.query.StructuredQuery.Order;
import com.enterprisex.curf.engine.domain.view.PiiMode;
import com.enterprisex.curf.engine.domain.view.RlsRule;
import com.enterprisex.curf.engine.domain.view.View;
import com.enterprisex.curf.engine.domain.view.ViewColumn;
import com.enterprisex.curf.engine.domain.view.ViewPolicy;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

class QueryComposerTest {

    private static final String VIEW_SQL = "SELECT id, agency_code, email, salary, national_id, amount, created, active, notes FROM agency_data";

    private static View view(List<RlsRule> rules) {
        return new View(UUID.randomUUID(), "t", "agency", null, UUID.randomUUID(), VIEW_SQL,
                List.of(new ViewColumn("id", "int4", null, null, PiiMode.NONE),
                        new ViewColumn("agency_code", "varchar", null, null, PiiMode.NONE),
                        new ViewColumn("email", "varchar", null, null, PiiMode.MASK),
                        new ViewColumn("salary", "int4", null, null, PiiMode.MASK),
                        new ViewColumn("national_id", "varchar", null, null, PiiMode.HIDE),
                        new ViewColumn("amount", "numeric", null, null, PiiMode.NONE),
                        new ViewColumn("created", "date", null, null, PiiMode.NONE),
                        new ViewColumn("active", "bool", null, null, PiiMode.NONE),
                        new ViewColumn("notes", "text", null, null, PiiMode.NONE)),
                Set.of("analyst"), Set.of("hr"), Set.of(), rules, null, 3, 3, Instant.EPOCH, "x", Instant.EPOCH, "x");
    }

    private static final List<RlsRule> AGENCY = List.of(new RlsRule("agency_code", RlsRule.Operator.EQ, "agency_code"));

    private static ViewPolicy.Access access(View v, Set<String> roles, Function<String, Set<String>> attributes) {
        return ViewPolicy.resolve(v, new Viewer("t", "u", "u", roles, Set.of(), Map.of(), Set.of()), attributes);
    }

    private static ViewPolicy.Access analyst(View v) {
        return access(v, Set.of("analyst"), a -> Set.of("A001"));
    }

    private static Composed compose(StructuredQuery q) {
        View v = view(AGENCY);
        return QueryComposer.compose(v, analyst(v), q, ConnectionKind.POSTGRESQL, 101);
    }

    private static StructuredQuery filter(String column, FilterOp op, Object value) {
        return new StructuredQuery(null, List.of(new Filter(column, op, value, null)), null, null, null);
    }

    private static void assertRefused(StructuredQuery q) {
        assertThatThrownBy(() -> compose(q)).isInstanceOf(EngineException.class);
    }

    // ------------------------------------------------------------------ the shape of the statement

    @Test
    void rowRulesRunInsideAndMaskingReplacesColumnsBeforeTheViewerCanTouchThem() {
        Composed c = compose(StructuredQuery.all());

        assertThat(c.sql()).startsWith("SELECT \"id\", \"agency_code\", \"email\", \"salary\", \"amount\", \"created\", \"active\", \"notes\" FROM (SELECT ");
        assertThat(c.sql()).contains("v.\"id\" AS \"id\"").contains("'***' AS \"email\"").contains("CAST(NULL AS int4) AS \"salary\"");
        assertThat(c.sql()).contains("FROM (" + VIEW_SQL + ") AS v WHERE v.\"agency_code\" IN (:__r0_0)");
        assertThat(c.sql()).doesNotContain("national_id AS").doesNotContain("\"national_id\"");
        assertThat(c.sql()).endsWith(") AS m LIMIT 101");
        assertThat(c.params()).containsEntry("__r0_0", "A001");
        assertThat(c.outputNames()).containsExactly("id", "agency_code", "email", "salary", "amount", "created", "active", "notes");
    }

    @Test
    void aViewerWithNoRowAccessGetsAStatementThatReturnsNothing() {
        View v = view(AGENCY);
        Composed c = QueryComposer.compose(v, access(v, Set.of("analyst"), a -> Set.of()), StructuredQuery.all(), ConnectionKind.POSTGRESQL, 11);
        assertThat(c.sql()).contains("WHERE 1 = 0");
        assertThat(c.params()).isEmpty();
    }

    @Test
    void aPiiRoleSeesRealColumns() {
        View v = view(AGENCY);
        Composed c = QueryComposer.compose(v, access(v, Set.of("hr"), a -> Set.of("A001")), StructuredQuery.all(), ConnectionKind.POSTGRESQL, 11);
        assertThat(c.sql()).contains("v.\"email\" AS \"email\"").contains("v.\"national_id\" AS \"national_id\"").doesNotContain("'***'");
    }

    @Test
    void anUnrestrictedViewerGetsNoRowFilter() {
        View v = view(List.of());
        Composed c = QueryComposer.compose(v, analyst(v), StructuredQuery.all(), ConnectionKind.POSTGRESQL, 11);
        assertThat(c.sql()).doesNotContain(" WHERE ");
    }

    @Test
    void numericRowRuleValuesAreConvertedAndUnusableOnesMatchNothing() {
        View v = new View(UUID.randomUUID(), "t", "v", null, UUID.randomUUID(), "SELECT 1",
                List.of(new ViewColumn("org", "int4", null, null, PiiMode.NONE)), Set.of(), Set.of(), Set.of(),
                List.of(new RlsRule("org", RlsRule.Operator.IN, "org_unit")), null, 1, 1, Instant.EPOCH, "x", Instant.EPOCH, "x");

        Composed good = QueryComposer.compose(v, access(v, Set.of(), a -> Set.of("7", "x")), StructuredQuery.all(), ConnectionKind.POSTGRESQL, 11);
        assertThat(good.params()).containsEntry("__r0_0", new BigDecimal("7")).hasSize(1);

        Composed none = QueryComposer.compose(v, access(v, Set.of(), a -> Set.of("x")), StructuredQuery.all(), ConnectionKind.POSTGRESQL, 11);
        assertThat(none.sql()).contains("1 = 0");
    }

    // ------------------------------------------------------------------ nothing hidden can be reached

    @Test
    void hiddenAndUnknownColumnsAreRefusedEverywhereTheyCouldAppear() {
        assertRefused(filter("national_id", FilterOp.EQ, "x"));
        assertRefused(filter("nope", FilterOp.EQ, "x"));
        assertRefused(new StructuredQuery(List.of("national_id"), null, null, null, null));
        assertRefused(new StructuredQuery(null, null, List.of("national_id"), List.of(new Aggregate(AggregateFn.COUNT, null, null)), null));
        assertRefused(new StructuredQuery(null, null, null, List.of(new Aggregate(AggregateFn.MAX, "national_id", "m")), null));
        assertRefused(new StructuredQuery(null, null, null, null, List.of(new Order("national_id", false))));
    }

    @Test
    void theRowRuleColumnCanBeHiddenAndStillApply() {
        View v = new View(UUID.randomUUID(), "t", "v", null, UUID.randomUUID(), "SELECT 1",
                List.of(new ViewColumn("id", "int4", null, null, PiiMode.NONE),
                        new ViewColumn("agency_code", "varchar", null, null, PiiMode.HIDE)),
                Set.of(), Set.of(), Set.of(), AGENCY, null, 1, 1, Instant.EPOCH, "x", Instant.EPOCH, "x");
        Composed c = QueryComposer.compose(v, access(v, Set.of(), a -> Set.of("A001")), StructuredQuery.all(), ConnectionKind.POSTGRESQL, 11);

        assertThat(c.sql()).contains("v.\"agency_code\" IN (:__r0_0)");
        assertThat(c.outputNames()).containsExactly("id");
        assertThatThrownBy(() -> QueryComposer.compose(v, access(v, Set.of(), a -> Set.of("A001")), filter("agency_code", FilterOp.EQ, "A002"),
                ConnectionKind.POSTGRESQL, 11)).isInstanceOf(EngineException.class);
    }

    @Test
    void valuesAreBoundNeverWrittenIntoTheStatement() {
        String attack = "x' OR '1'='1' --";
        Composed c = compose(filter("notes", FilterOp.EQ, attack));

        assertThat(c.sql()).doesNotContain("OR '1'").doesNotContain("--").contains("\"notes\" = :__f0_0");
        assertThat(c.params()).containsEntry("__f0_0", attack);
    }

    @Test
    void filtersAreCombinedWithAndOutsideTheRowRule() {
        Composed c = compose(new StructuredQuery(null, List.of(
                new Filter("id", FilterOp.GT, 1, null), new Filter("notes", FilterOp.LIKE, "a%", null)), null, null, null));
        assertThat(c.sql()).contains(") AS m WHERE \"id\" > :__f0_0 AND \"notes\" LIKE :__f1_0");
        assertThat(c.sql().indexOf("agency_code\" IN")).isLessThan(c.sql().indexOf(") AS m"));
    }

    @Test
    void filtersOnMaskedColumnsSeeTheMaskNotTheRealValue() {
        Composed c = compose(filter("email", FilterOp.EQ, "somchai@example.com"));
        // "email" resolves against the masked projection m, where it is the constant mask.
        assertThat(c.sql()).contains("'***' AS \"email\"").contains(") AS m WHERE \"email\" = :__f0_0");
    }

    // ------------------------------------------------------------------ filters, types, aggregates

    @Test
    void filterValuesAreConvertedToTheColumnsType() {
        assertThat(compose(filter("amount", FilterOp.GE, "10.50")).params()).containsEntry("__f0_0", new BigDecimal("10.50"));
        assertThat(compose(filter("active", FilterOp.EQ, "true")).params()).containsEntry("__f0_0", true);
        assertThat(compose(filter("created", FilterOp.GE, "2026-01-31")).sql()).contains("\"created\" >= CAST(:__f0_0 AS date)");
        assertRefused(filter("amount", FilterOp.GE, "ten"));
        assertRefused(filter("created", FilterOp.GE, "31/01/2026"));
        assertRefused(filter("active", FilterOp.GT, true));
        assertRefused(filter("id", FilterOp.LIKE, "1%"));
        assertRefused(filter("id", FilterOp.EQ, null));
    }

    @Test
    void inBetweenAndNullTests() {
        Composed in = compose(new StructuredQuery(null, List.of(new Filter("id", FilterOp.IN, null, List.of(1, 2, 3))), null, null, null));
        assertThat(in.sql()).contains("\"id\" IN (:__f0_0, :__f0_1, :__f0_2)");
        Composed between = compose(new StructuredQuery(null, List.of(new Filter("id", FilterOp.BETWEEN, null, List.of(1, 5))), null, null, null));
        assertThat(between.sql()).contains("\"id\" BETWEEN :__f0_0 AND :__f0_1");
        assertThat(compose(filter("notes", FilterOp.IS_NULL, null)).sql()).contains("\"notes\" IS NULL");
        assertRefused(new StructuredQuery(null, List.of(new Filter("id", FilterOp.BETWEEN, null, List.of(1))), null, null, null));
        assertRefused(new StructuredQuery(null, List.of(new Filter("id", FilterOp.IN, null, List.of())), null, null, null));
        assertRefused(new StructuredQuery(null, List.of(new Filter("id", FilterOp.IN, null, java.util.Collections.nCopies(1001, 1))), null, null, null));
    }

    @Test
    void groupingAndAggregates() {
        Composed c = compose(new StructuredQuery(null, null, List.of("agency_code"),
                List.of(new Aggregate(AggregateFn.SUM, "amount", "total"), new Aggregate(AggregateFn.COUNT, null, null)),
                List.of(new Order("total", true))));

        assertThat(c.sql()).startsWith("SELECT \"agency_code\", SUM(\"amount\") AS \"total\", COUNT(*) AS \"count_all\" FROM (");
        assertThat(c.sql()).contains(") AS m GROUP BY \"agency_code\" ORDER BY \"total\" DESC LIMIT 101");
        assertThat(c.outputNames()).containsExactly("agency_code", "total", "count_all");
    }

    @Test
    void groupingRulesAreEnforced() {
        assertRefused(new StructuredQuery(List.of("id"), null, List.of("agency_code"), List.of(new Aggregate(AggregateFn.COUNT, null, null)), null));
        assertRefused(new StructuredQuery(null, null, null, List.of(new Aggregate(AggregateFn.SUM, "notes", "s")), null));
        assertRefused(new StructuredQuery(null, null, null, List.of(new Aggregate(AggregateFn.SUM, null, "s")), null));
        assertRefused(new StructuredQuery(null, null, null, List.of(new Aggregate(AggregateFn.COUNT, null, "x; DROP TABLE t")), null));
        assertRefused(new StructuredQuery(null, null, null, List.of(new Aggregate(AggregateFn.COUNT, null, "a"), new Aggregate(AggregateFn.COUNT, null, "a")), null));
        assertRefused(new StructuredQuery(null, null, List.of("agency_code"), List.of(new Aggregate(AggregateFn.COUNT, null, null)),
                List.of(new Order("id", false))));
    }

    @Test
    void aSumOverAMaskedNumberIsOverNothing() {
        Composed c = compose(new StructuredQuery(null, null, null, List.of(new Aggregate(AggregateFn.SUM, "salary", "total")), null));
        assertThat(c.sql()).contains("CAST(NULL AS int4) AS \"salary\"").contains("SUM(\"salary\") AS \"total\"");
    }

    @Test
    void orderingMustNameAColumnYouCanSee() {
        assertThat(compose(new StructuredQuery(null, null, null, null, List.of(new Order("id", false), new Order("notes", true)))).sql())
                .contains("ORDER BY \"id\" ASC, \"notes\" DESC");
        assertRefused(new StructuredQuery(null, null, null, null, List.of(new Order("id; DROP TABLE t", false))));
        assertRefused(new StructuredQuery(null, null, null, null, List.of(new Order(null, false))));
    }

    // ------------------------------------------------------------------ dialects

    @Test
    void mysqlFamilyQuotesAndCastsItsOwnWay() {
        View v = view(AGENCY);
        Composed c = QueryComposer.compose(v, analyst(v), filter("created", FilterOp.GE, "2026-01-31"), ConnectionKind.MYSQL, 11);

        assertThat(c.sql()).contains("`agency_code`").contains("CAST(NULL AS SIGNED) AS `salary`").contains("CAST(:__f0_0 AS DATE)");
        assertThat(c.sql()).doesNotContain("\"agency_code\"");
    }

    @Test
    void identifiersAreQuotedSoAHostileNameCannotBreakOut() {
        assertThat(Dialects.quote(ConnectionKind.POSTGRESQL, "a\"b")).isEqualTo("\"a\"\"b\"");
        assertThat(Dialects.quote(ConnectionKind.MYSQL, "a`b")).isEqualTo("`a``b`");
        assertThat(QueryComposer.validName("agency_code")).isTrue();
        assertThat(QueryComposer.validName("ชื่อ_หน่วยงาน")).as("Thai with vowel and tone marks").isTrue();
        assertThat(QueryComposer.validName("ที่อยู่")).isTrue();
        assertThat(QueryComposer.validName("a\"b")).isFalse();
        assertThat(QueryComposer.validName("a b")).isFalse();
        assertThat(QueryComposer.validName("1abc")).isFalse();
    }

    // ------------------------------------------------------------------ the guard still accepts what is composed

    @ParameterizedTest
    @EnumSource(ConnectionKind.class)
    void everyComposedStatementIsAcceptedByTheSqlGuard(ConnectionKind kind) {
        View v = view(AGENCY);
        List<StructuredQuery> requests = List.of(
                StructuredQuery.all(),
                filter("created", FilterOp.BETWEEN, null),
                new StructuredQuery(List.of("id", "email"), List.of(new Filter("id", FilterOp.IN, null, List.of(1, 2))), null, null,
                        List.of(new Order("id", true))),
                new StructuredQuery(null, List.of(new Filter("created", FilterOp.GE, "2026-01-01", null),
                        new Filter("notes", FilterOp.LIKE, "a%", null), new Filter("active", FilterOp.EQ, true, null),
                        new Filter("amount", FilterOp.NE, 3, null)), null, null, null),
                new StructuredQuery(null, null, List.of("agency_code", "active"),
                        List.of(new Aggregate(AggregateFn.SUM, "amount", "total"), new Aggregate(AggregateFn.AVG, "salary", "avg_salary"),
                                new Aggregate(AggregateFn.MAX, "created", "latest"), new Aggregate(AggregateFn.COUNT, null, null)),
                        List.of(new Order("total", true))));

        for (ViewPolicy.Access access : List.of(
                analyst(v), access(v, Set.of("hr"), a -> Set.of("A001")), access(v, Set.of("analyst"), a -> Set.of()))) {
            for (StructuredQuery q : requests) {
                if (q.filters().stream().anyMatch(f -> f.op() == FilterOp.BETWEEN && f.values() == null)) {
                    continue; // deliberately malformed: covered by the refusal tests
                }
                Composed c = QueryComposer.compose(v, access, q, kind, 101);
                var verdict = SqlGuard.check(c.sql());
                assertThat(verdict.accepted()).as(kind + ": " + c.sql() + " -> " + verdict.rejection()).isTrue();
            }
        }
    }
}
