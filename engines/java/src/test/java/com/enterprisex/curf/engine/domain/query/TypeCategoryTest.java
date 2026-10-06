package com.enterprisex.curf.engine.domain.query;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;

class TypeCategoryTest {

    @Test
    void classifiesTheTypeNamesThreeDatabasesReport() {
        Map<String, TypeCategory> expected = Map.ofEntries(
                Map.entry("varchar", TypeCategory.TEXT), Map.entry("VARCHAR", TypeCategory.TEXT), Map.entry("text", TypeCategory.TEXT),
                Map.entry("bpchar", TypeCategory.TEXT),Map.entry("uuid", TypeCategory.TEXT), Map.entry("jsonb", TypeCategory.TEXT),
                Map.entry("int4", TypeCategory.NUMBER), Map.entry("INT", TypeCategory.NUMBER), Map.entry("BIGINT UNSIGNED", TypeCategory.NUMBER),
                Map.entry("serial", TypeCategory.NUMBER), Map.entry("numeric", TypeCategory.NUMBER), Map.entry("DECIMAL", TypeCategory.NUMBER),
                Map.entry("float8", TypeCategory.NUMBER), Map.entry("DOUBLE", TypeCategory.NUMBER), Map.entry("TINYINT", TypeCategory.NUMBER),
                Map.entry("date", TypeCategory.DATE), Map.entry("DATE", TypeCategory.DATE),
                Map.entry("timestamp", TypeCategory.TIMESTAMP), Map.entry("timestamptz", TypeCategory.TIMESTAMP),
                Map.entry("DATETIME", TypeCategory.TIMESTAMP), Map.entry("TIMESTAMP", TypeCategory.TIMESTAMP),
                Map.entry("bool", TypeCategory.BOOLEAN), Map.entry("boolean", TypeCategory.BOOLEAN), Map.entry("BIT", TypeCategory.BOOLEAN),
                Map.entry("interval", TypeCategory.OTHER), Map.entry("point", TypeCategory.OTHER), Map.entry("bytea", TypeCategory.OTHER),
                Map.entry("time", TypeCategory.OTHER));
        expected.forEach((type, category) -> assertThat(TypeCategory.of(type)).as(type).isEqualTo(category));
        assertThat(TypeCategory.of(null)).isEqualTo(TypeCategory.OTHER);
    }

    @Test
    void onlyPlainTypeNamesAreEverPlacedInACast() {
        assertThat(TypeCategory.safeTypeName("int4")).isEqualTo("int4");
        assertThat(TypeCategory.safeTypeName("double precision")).isEqualTo("double precision");
        assertThat(TypeCategory.safeTypeName("int); DROP TABLE t; --")).isNull();
        assertThat(TypeCategory.safeTypeName("varchar(50)")).isNull();
        assertThat(TypeCategory.safeTypeName(null)).isNull();
    }
}
