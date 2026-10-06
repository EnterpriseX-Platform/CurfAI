package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.application.export.ExportModel.Source;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Small documents for the renderer tests. */
public final class ExportFixtures {

    private ExportFixtures() {}

    public static Map<String, Object> row(Object... keyValues) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < keyValues.length; i += 2) {
            m.put((String) keyValues[i], keyValues[i + 1]);
        }
        return m;
    }

    public static final List<Column> COLUMNS = List.of(
            new Column("name", "ชื่อหน่วยงาน", "string", null, "none"),
            new Column("amount", "จำนวนเงิน", "currency", null, "sum"),
            new Column("rate", "อัตรา", "percent", null, "avg"),
            new Column("created", "วันที่", "date", null, "none"),
            new Column("note", "หมายเหตุ", "string", null, "none"));

    public static List<Map<String, Object>> rows() {
        return List.of(
                row("name", "สำนักงานตรวจเงินแผ่นดิน", "amount", "48500000.50", "rate", "0.153", "created", "2026-01-10", "note", "ที่อยู่ เชียงใหม่"),
                row("name", "=1+1", "amount", 1500, "rate", "0.2", "created", "2026-02-20T00:00:00.000Z", "note", "+SUM(A1)"),
                row("name", "@cmd", "amount", "-25.25", "rate", null, "created", null, "note", "-x"));
    }

    public static Document document(String locale, boolean buddhist) {
        Section section = new Section("b1", "ตารางสรุป", "q1", COLUMNS, rows(), true, null);
        return new Document("รายงานผลการดำเนินงาน", locale, new CellFormats.Style(locale, buddhist), "THB", "2026-10-05T01:02:03.456Z", 3,
                row("from", "2026-01-01", "min", 0), List.of(section),
                List.of(new Source("q1", "Totals", "sha256:aaaaaaaaaaaaaaaaaaaaaaaa", "sha256:bbbbbbbbbbbbbbbbbbbbbbbb", 3, null)));
    }
}
