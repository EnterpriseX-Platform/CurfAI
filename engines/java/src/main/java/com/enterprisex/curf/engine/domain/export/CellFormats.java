package com.enterprisex.curf.engine.domain.export;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.TextStyle;
import java.time.temporal.TemporalAccessor;
import java.util.Locale;
import java.util.Map;

/**
 * How a value is shown as text in a file: numbers, money, percentages and dates, the way Curf's own viewer shows
 * them. A Thai reader gets Thai month names and, unless the report or reader chose Gregorian, Buddhist-era years
 * (the Gregorian year plus 543). Pure and locale-independent: it never reads the machine's locale.
 */
public final class CellFormats {

    /** Who a date is shown to. {@code buddhist} replaces the year by year + 543. */
    public record Style(String locale, boolean buddhist) {

        public boolean thai() {
            return "th".equalsIgnoreCase(locale);
        }
    }

    private static final String[] THAI_SHORT = {"ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."};
    private static final String[] THAI_LONG = {
        "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
    };
    private static final Map<String, String> SYMBOLS = Map.of(
            "THB", "฿", "USD", "$", "EUR", "€", "GBP", "£", "JPY", "¥", "CNY", "¥", "KRW", "₩", "INR", "₹");
    private static final DecimalFormatSymbols SYMBOLS_ROOT = DecimalFormatSymbols.getInstance(Locale.ROOT);

    private CellFormats() {}

    // ------------------------------------------------------------------ numbers

    /** Up to four decimals, thousands separators, no trailing zeros. */
    public static String number(BigDecimal value) {
        return decimal("#,##0.####", value);
    }

    public static String currency(BigDecimal value, String code) {
        String symbol = symbol(code);
        String body = decimal("#,##0.00", value.abs());
        return (value.signum() < 0 ? "-" : "") + symbol + body;
    }

    /** A fraction as a percentage: 0.153 is "15.3%". */
    public static String percent(BigDecimal fraction, int decimals) {
        return fraction.multiply(BigDecimal.valueOf(100)).setScale(decimals, RoundingMode.HALF_UP).toPlainString() + "%";
    }

    public static String symbol(String code) {
        String upper = code == null ? "" : code.toUpperCase(Locale.ROOT);
        return SYMBOLS.getOrDefault(upper, upper.isEmpty() ? "" : upper + " ");
    }

    private static String decimal(String pattern, BigDecimal value) {
        DecimalFormat f = new DecimalFormat(pattern, SYMBOLS_ROOT);
        f.setRoundingMode(RoundingMode.HALF_UP);
        f.setParseBigDecimal(true);
        return f.format(value);
    }

    // ------------------------------------------------------------------ dates

    /** A date, or a date with time, in the default pattern for the style or the author's date-fns style pattern. */
    public static String date(TemporalAccessor value, String pattern, Style style, boolean withTime) {
        String p = pattern != null && !pattern.isBlank() ? pattern : defaultPattern(style, withTime);
        return apply(p, value, style);
    }

    private static String defaultPattern(Style style, boolean withTime) {
        String day = style.thai() ? "d MMM yyyy" : "yyyy-MM-dd";
        return withTime ? day + " HH:mm" : day;
    }

    /** The subset of date-fns patterns Curf authors use: y M d H m s, MMM and MMMM, and quoted literals. */
    private static String apply(String pattern, TemporalAccessor t, Style style) {
        int year = field(t, java.time.temporal.ChronoField.YEAR);
        int month = field(t, java.time.temporal.ChronoField.MONTH_OF_YEAR);
        int day = field(t, java.time.temporal.ChronoField.DAY_OF_MONTH);
        int shownYear = style.buddhist() ? year + 543 : year;

        StringBuilder out = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < pattern.length(); i++) {
            char c = pattern.charAt(i);
            if (c == '\'') {
                quoted = !quoted;
                continue;
            }
            if (quoted || "yMdHms".indexOf(c) < 0) {
                out.append(c);
                continue;
            }
            int n = 1;
            while (i + n < pattern.length() && pattern.charAt(i + n) == c) {
                n++;
            }
            i += n - 1;
            switch (c) {
                case 'y' -> out.append(n == 2 ? pad(shownYear % 100, 2) : String.valueOf(shownYear));
                case 'M' -> out.append(monthText(month, n, style));
                case 'd' -> out.append(pad(day, n));
                case 'H' -> out.append(pad(field(t, java.time.temporal.ChronoField.HOUR_OF_DAY), n));
                case 'm' -> out.append(pad(field(t, java.time.temporal.ChronoField.MINUTE_OF_HOUR), n));
                default -> out.append(pad(field(t, java.time.temporal.ChronoField.SECOND_OF_MINUTE), n));
            }
        }
        return out.toString();
    }

    private static String monthText(int month, int width, Style style) {
        if (width >= 4) {
            return style.thai() ? THAI_LONG[month - 1] : java.time.Month.of(month).getDisplayName(TextStyle.FULL, Locale.ENGLISH);
        }
        if (width == 3) {
            return style.thai() ? THAI_SHORT[month - 1] : java.time.Month.of(month).getDisplayName(TextStyle.SHORT, Locale.ENGLISH);
        }
        return pad(month, width);
    }

    private static int field(TemporalAccessor t, java.time.temporal.ChronoField f) {
        return t.isSupported(f) ? t.get(f) : 0;
    }

    private static String pad(int value, int width) {
        String s = String.valueOf(value);
        return s.length() >= width ? s : "0".repeat(width - s.length()) + s;
    }

    /** Reads the date strings the engine returns: yyyy-MM-dd, ISO timestamps with milliseconds and Z, and "yyyy-MM-dd HH:mm[:ss]". */
    public static LocalDateTime parseDateTime(String text) {
        String s = text.trim();
        try {
            if (s.length() == 10) {
                return LocalDate.parse(s).atStartOfDay();
            }
            if (s.endsWith("Z") || s.matches(".*[+-]\\d{2}:?\\d{2}$")) {
                return java.time.OffsetDateTime.parse(s).withOffsetSameInstant(java.time.ZoneOffset.UTC).toLocalDateTime();
            }
            return LocalDateTime.parse(s.replace(' ', 'T'));
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }
}
