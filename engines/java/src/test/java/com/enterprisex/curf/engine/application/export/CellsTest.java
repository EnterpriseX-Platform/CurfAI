package com.enterprisex.curf.engine.application.export;

import static com.enterprisex.curf.engine.application.export.ExportFixtures.row;
import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.application.export.Cells.Bool;
import com.enterprisex.curf.engine.application.export.Cells.Date;
import com.enterprisex.curf.engine.application.export.Cells.Empty;
import com.enterprisex.curf.engine.application.export.Cells.Num;
import com.enterprisex.curf.engine.application.export.Cells.Text;
import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

class CellsTest {

    private static Column col(String type) {
        return new Column("v", "V", type, null, "none");
    }

    @Test
    void valuesBecomeTypedCells() {
        assertThat(Cells.of(col("number"), 5)).isEqualTo(new Num(new BigDecimal("5")));
        assertThat(Cells.of(col("currency"), "100.50")).isEqualTo(new Num(new BigDecimal("100.50")));
        assertThat(Cells.of(col("percent"), 0.25)).isEqualTo(new Num(new BigDecimal("0.25")));
        assertThat(Cells.of(col("number"), "abc")).as("text that is not a number stays text").isEqualTo(new Text("abc"));
        assertThat(Cells.of(col("date"), "2026-01-10")).isInstanceOf(Date.class);
        assertThat(((Date) Cells.of(col("datetime"), "2026-01-10T14:05:00.000Z")).withTime()).isTrue();
        assertThat(Cells.of(col("date"), "garbage")).isEqualTo(new Text("garbage"));
        assertThat(Cells.of(col("string"), true)).isEqualTo(new Bool(true));
        assertThat(Cells.of(col("string"), 5.0)).as("a whole double is not shown as 5.0").isEqualTo(new Text("5"));
        assertThat(Cells.of(col("string"), "ที่อยู่")).isEqualTo(new Text("ที่อยู่"));
    }

    @Test
    void absentIsEmptyNeverZero() {
        assertThat(Cells.of(col("number"), null)).isInstanceOf(Empty.class);
        assertThat(Cells.of(col("number"), "")).isInstanceOf(Empty.class);
        assertThat(Cells.display(new Empty(), col("number"), ExportFixtures.document("en", false))).isEmpty();
        assertThat(Cells.machine(new Empty())).isEmpty();
    }

    @Test
    void displayFollowsTheColumnTypeAndTheReader() {
        var th = ExportFixtures.document("th", true);
        var en = ExportFixtures.document("en", false);
        assertThat(Cells.display(Cells.of(col("currency"), "48500000.5"), col("currency"), th)).isEqualTo("฿48,500,000.50");
        assertThat(Cells.display(Cells.of(col("percent"), "0.153"), col("percent"), th)).isEqualTo("15.3%");
        assertThat(Cells.display(Cells.of(col("number"), "1234.5"), col("number"), th)).isEqualTo("1,234.5");
        assertThat(Cells.display(Cells.of(col("date"), "2026-01-10"), col("date"), th)).isEqualTo("10 ม.ค. 2569");
        assertThat(Cells.display(Cells.of(col("date"), "2026-01-10"), col("date"), en)).isEqualTo("2026-01-10");
        assertThat(Cells.display(Cells.of(col("datetime"), "2026-01-10T14:05:00Z"), col("datetime"), en)).isEqualTo("2026-01-10 14:05");
    }

    @Test
    void machineValuesAreForScripts() {
        assertThat(Cells.machine(Cells.of(col("currency"), "100.50"))).isEqualTo("100.50");
        assertThat(Cells.machine(Cells.of(col("number"), 1234567))).isEqualTo("1234567");
        assertThat(Cells.machine(Cells.of(col("date"), "2026-01-10T00:00:00.000Z"))).isEqualTo("2026-01-10");
        assertThat(Cells.machine(Cells.of(col("datetime"), "2026-01-10T14:05:09.000Z"))).isEqualTo("2026-01-10 14:05:09");
        assertThat(Cells.machine(Cells.of(col("string"), false))).isEqualTo("false");
    }

    @Test
    void totalsFollowTheColumnSetting() {
        List<Column> columns = List.of(
                new Column("a", "A", "number", null, "sum"), new Column("b", "B", "number", null, "avg"),
                new Column("c", "C", "number", null, "min"), new Column("d", "D", "number", null, "max"),
                new Column("e", "E", "string", null, "count"), new Column("f", "F", "number", null, "none"));
        List<java.util.Map<String, Object>> rows = List.of(
                row("a", 1, "b", 2, "c", 5, "d", 5, "e", "x", "f", 1), row("a", "2.5", "b", 4, "c", 3, "d", 9, "e", null, "f", 1),
                row("a", null, "b", null, "c", null, "d", null, "e", "z", "f", 1));
        List<BigDecimal> totals = Cells.totals(new Section("", "t", "q", columns, rows, true, null));

        assertThat(totals.get(0)).isEqualByComparingTo("3.5");
        assertThat(totals.get(1)).as("an average ignores absent values").isEqualByComparingTo("3");
        assertThat(totals.get(2)).isEqualByComparingTo("3");
        assertThat(totals.get(3)).isEqualByComparingTo("9");
        assertThat(totals.get(4)).as("count counts what is present").isEqualByComparingTo("2");
        assertThat(totals.get(5)).isNull();
    }

    @Test
    void totalsOnlyShowWhenAskedForAndThereAreRows() {
        List<Column> withTotal = List.of(new Column("a", "A", "number", null, "sum"));
        List<Column> without = List.of(new Column("a", "A", "number", null, "none"));
        var rows = List.of(row("a", 1));
        assertThat(Cells.hasTotals(new Section("", "t", "q", withTotal, rows, true, null))).isTrue();
        assertThat(Cells.hasTotals(new Section("", "t", "q", withTotal, rows, false, null))).isFalse();
        assertThat(Cells.hasTotals(new Section("", "t", "q", without, rows, true, null))).isFalse();
        assertThat(Cells.hasTotals(new Section("", "t", "q", withTotal, List.of(), true, null))).isFalse();
    }
}
