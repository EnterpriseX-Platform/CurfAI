package com.enterprisex.curf.engine.domain.export;

import static org.assertj.core.api.Assertions.assertThat;

import com.enterprisex.curf.engine.domain.export.CellFormats.Style;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import org.junit.jupiter.api.Test;

class CellFormatsTest {

    private static final Style THAI_BE = new Style("th", true);
    private static final Style THAI_CE = new Style("th", false);
    private static final Style ENGLISH = new Style("en", false);
    private static final Style ENGLISH_BE = new Style("en", true);
    private static final LocalDateTime D = LocalDateTime.of(2026, 1, 10, 14, 5, 9);

    @Test
    void numbersMoneyAndPercentages() {
        assertThat(CellFormats.number(new BigDecimal("1234567.891"))).isEqualTo("1,234,567.891");
        assertThat(CellFormats.number(new BigDecimal("100.5000"))).isEqualTo("100.5");
        assertThat(CellFormats.number(new BigDecimal("0.00005"))).isEqualTo("0.0001");
        assertThat(CellFormats.number(new BigDecimal("-42"))).isEqualTo("-42");
        assertThat(CellFormats.currency(new BigDecimal("48500000"), "THB")).isEqualTo("฿48,500,000.00");
        assertThat(CellFormats.currency(new BigDecimal("-1234.5"), "THB")).isEqualTo("-฿1,234.50");
        assertThat(CellFormats.currency(new BigDecimal("9.99"), "usd")).isEqualTo("$9.99");
        assertThat(CellFormats.currency(new BigDecimal("5"), "CHF")).isEqualTo("CHF 5.00");
        assertThat(CellFormats.percent(new BigDecimal("0.153"), 1)).isEqualTo("15.3%");
        assertThat(CellFormats.percent(new BigDecimal("1"), 1)).isEqualTo("100.0%");
    }

    @Test
    void thaiReadersGetThaiMonthsAndBuddhistYears() {
        assertThat(CellFormats.date(D, null, THAI_BE, false)).isEqualTo("10 ม.ค. 2569");
        assertThat(CellFormats.date(D, null, THAI_BE, true)).isEqualTo("10 ม.ค. 2569 14:05");
        assertThat(CellFormats.date(D, null, THAI_CE, false)).isEqualTo("10 ม.ค. 2026");
        assertThat(CellFormats.date(D.withMonth(9), null, THAI_BE, false)).isEqualTo("10 ก.ย. 2569");
        assertThat(CellFormats.date(D.withMonth(12), null, THAI_BE, false)).isEqualTo("10 ธ.ค. 2569");
    }

    @Test
    void otherReadersGetIsoDatesAndTheEraIsStillHonoured() {
        assertThat(CellFormats.date(D, null, ENGLISH, false)).isEqualTo("2026-01-10");
        assertThat(CellFormats.date(D, null, ENGLISH, true)).isEqualTo("2026-01-10 14:05");
        assertThat(CellFormats.date(D, null, ENGLISH_BE, false)).isEqualTo("2569-01-10");
    }

    @Test
    void authorPatternsFollowDateFns() {
        assertThat(CellFormats.date(D, "dd/MM/yyyy", THAI_BE, false)).isEqualTo("10/01/2569");
        assertThat(CellFormats.date(D, "d MMMM yyyy", THAI_BE, false)).isEqualTo("10 มกราคม 2569");
        assertThat(CellFormats.date(D, "d MMMM yyyy", ENGLISH, false)).isEqualTo("10 January 2026");
        assertThat(CellFormats.date(D, "MMM yy", THAI_BE, false)).isEqualTo("ม.ค. 69");
        assertThat(CellFormats.date(D, "yyyy-MM-dd HH:mm:ss", ENGLISH, false)).isEqualTo("2026-01-10 14:05:09");
        assertThat(CellFormats.date(D, "'ปี' yyyy", THAI_BE, false)).as("quoted text is kept as it is").isEqualTo("ปี 2569");
        assertThat(CellFormats.date(LocalDate.of(2026, 3, 1).atStartOfDay(), "M/d/yy", ENGLISH, false)).isEqualTo("3/1/26");
    }

    @Test
    void readsTheDateStringsTheEngineReturns() {
        assertThat(CellFormats.parseDateTime("2026-01-10")).isEqualTo(LocalDateTime.of(2026, 1, 10, 0, 0));
        assertThat(CellFormats.parseDateTime("2026-01-10T14:05:09.000Z")).isEqualTo(LocalDateTime.of(2026, 1, 10, 14, 5, 9));
        assertThat(CellFormats.parseDateTime("2026-01-10 14:05:09")).isEqualTo(LocalDateTime.of(2026, 1, 10, 14, 5, 9));
        assertThat(CellFormats.parseDateTime("2026-01-10T21:05:09+07:00")).isEqualTo(LocalDateTime.of(2026, 1, 10, 14, 5, 9));
        assertThat(CellFormats.parseDateTime("not a date")).isNull();
        assertThat(CellFormats.parseDateTime("2026-13-45")).isNull();
    }
}
