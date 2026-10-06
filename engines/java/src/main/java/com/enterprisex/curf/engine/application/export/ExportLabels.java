package com.enterprisex.curf.engine.application.export;

import java.util.Map;

/** The few words the files themselves contain, in the reader's language. */
public final class ExportLabels {

    private static final Map<String, String> TH = Map.ofEntries(
            Map.entry("total", "รวม"), Map.entry("asOf", "ข้อมูล ณ"), Map.entry("parameters", "พารามิเตอร์"),
            Map.entry("sources", "แหล่งข้อมูล"), Map.entry("rows", "แถว"), Map.entry("unavailable", "ไม่มีข้อมูล"),
            Map.entry("page", "หน้า"), Map.entry("of", "จาก"), Map.entry("noRows", "ไม่มีข้อมูล"), Map.entry("query", "ชุดข้อมูล"),
            Map.entry("queryHash", "รหัสคำสั่ง"), Map.entry("dataHash", "รหัสข้อมูล"), Map.entry("note", "หมายเหตุ"),
            Map.entry("version", "เวอร์ชัน"), Map.entry("provenance", "ที่มาของข้อมูล"));
    private static final Map<String, String> EN = Map.ofEntries(
            Map.entry("total", "Total"), Map.entry("asOf", "Data as of"), Map.entry("parameters", "Parameters"),
            Map.entry("sources", "Data sources"), Map.entry("rows", "Rows"), Map.entry("unavailable", "Data unavailable"),
            Map.entry("page", "Page"), Map.entry("of", "of"), Map.entry("noRows", "No rows"), Map.entry("query", "Query"),
            Map.entry("queryHash", "Query hash"), Map.entry("dataHash", "Data hash"), Map.entry("note", "Note"),
            Map.entry("version", "Version"), Map.entry("provenance", "Provenance"));

    private final Map<String, String> words;

    private ExportLabels(Map<String, String> words) {
        this.words = words;
    }

    public static ExportLabels of(String locale) {
        return new ExportLabels("th".equalsIgnoreCase(locale) ? TH : EN);
    }

    public String get(String key) {
        return words.getOrDefault(key, key);
    }
}
