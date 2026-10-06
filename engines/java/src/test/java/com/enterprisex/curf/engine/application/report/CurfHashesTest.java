package com.enterprisex.curf.engine.application.report;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The expected values were produced by running Curf's own hashQueryDef and hashRows (provenance.ts) in Node over
 * the same inputs, so these tests pin the Java port to the original, byte for byte.
 */
class CurfHashesTest {

    private static Map<String, Object> row(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void rowHashesMatchCurfs() {
        assertThat(CurfHashes.rows(List.of())).isEqualTo("sha256:e3b0c44298fc1c149afbf4c8");
        assertThat(CurfHashes.rows(List.of(row("b", 1, "a", "x"), row("a", "y", "b", 2)))).isEqualTo("sha256:66696e8d8cad7eab19dabbb5");
    }

    @Test
    void everyKindOfValueIsWrittenTheWayJavaScriptWritesIt() {
        Map<String, Object> mixed = row(
                "id", 1, "name", "Somchai", "amount", "100.50", "ok", true, "none", null, "rate", 0.1, "big", 1e21, "small", 1e-7,
                "neg", -3, "whole", 5.0, "frac", 2.5, "thai", "ที่อยู่ \"q\" \\ \n\t", "ctl", "\u0001", "tiny", 0.000001,
                "huge", 123456789012345680000.0, "emoji", "😀", "sep", "\u2028");

        assertThat(CurfHashes.rows(List.of(mixed))).isEqualTo("sha256:02879b2c81c383fb271a36e1");
    }

    @Test
    void queryHashesMatchCurfs() {
        assertThat(CurfHashes.queryDefinition(
                        "SELECT region FROM sales WHERE sale_date BETWEEN :from AND :to  AND x = :x::int",
                        Map.of("from", "2025-06-01", "to", "2026-05-31", "x", 5, "unused", "q")))
                .isEqualTo("sha256:a5fc716f50fd83901e13bb91");
        assertThat(CurfHashes.queryDefinition("select 1", Map.of())).isEqualTo("sha256:506a10fd632da67d5f5830ae");
        assertThat(CurfHashes.queryDefinition("SELECT * FROM t WHERE a = :a OR b = :b", Map.of("a", "", "b", 1.5, "c", true)))
                .isEqualTo("sha256:05f0b2df67ba311499b9722b");
    }

    @Test
    void aParameterNotUsedByTheQueryDoesNotChangeItsHash() {
        String sql = "SELECT * FROM t WHERE a = :a";
        assertThat(CurfHashes.queryDefinition(sql, Map.of("a", 1, "other", "x"))).isEqualTo(CurfHashes.queryDefinition(sql, Map.of("a", 1)));
        assertThat(CurfHashes.queryDefinition(sql, Map.of("a", 2))).isNotEqualTo(CurfHashes.queryDefinition(sql, Map.of("a", 1)));
    }

    @Test
    void numbersFollowJavaScriptFormatting() {
        assertThat(JsJson.number(5.0)).isEqualTo("5");
        assertThat(JsJson.number(-0.0)).isEqualTo("0");
        assertThat(JsJson.number(0.1)).isEqualTo("0.1");
        assertThat(JsJson.number(100.0)).isEqualTo("100");
        assertThat(JsJson.number(123.456)).isEqualTo("123.456");
        assertThat(JsJson.number(-2.5)).isEqualTo("-2.5");
        assertThat(JsJson.number(1e21)).isEqualTo("1e+21");
        assertThat(JsJson.number(1.5e300)).isEqualTo("1.5e+300");
        assertThat(JsJson.number(1e-7)).isEqualTo("1e-7");
        assertThat(JsJson.number(0.000001)).isEqualTo("0.000001");
        assertThat(JsJson.number(1.2345e-9)).isEqualTo("1.2345e-9");
        assertThat(JsJson.number(123456789012345680000.0)).isEqualTo("123456789012345680000");
        assertThat(JsJson.number(Double.NaN)).isEqualTo("null");
        assertThat(JsJson.number(Double.POSITIVE_INFINITY)).isEqualTo("null");
    }

    @Test
    void stringsAreEscapedAsJsonStringifyDoes() {
        assertThat(JsJson.stringify("a\"b\\c\n")).isEqualTo("\"a\\\"b\\\\c\\n\"");
        assertThat(JsJson.stringify("\u0001")).isEqualTo("\"\\u0001\"");
        assertThat(JsJson.stringify("\u2028")).isEqualTo("\"\u2028\"");
        assertThat(JsJson.stringify("😀")).isEqualTo("\"😀\"");
        assertThat(JsJson.stringify("\ud800")).as("a lone surrogate is escaped").isEqualTo("\"\\ud800\"");
        assertThat(JsJson.stringify(row("a", List.of(1, "x", true), "b", null))).isEqualTo("{\"a\":[1,\"x\",true],\"b\":null}");
    }
}
