package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.application.export.ExportModel.Column;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads a raw value into a typed cell and says how each format shows it. Numbers stay numbers (never text that
 * a spreadsheet might misread), dates are real dates until a Buddhist-era year forces text, and anything else is
 * text. Absent is empty, never zero.
 */
public final class Cells {

    public sealed interface Cell permits Empty, Num, Date, Bool, Text {}

    public record Empty() implements Cell {}

    public record Num(BigDecimal value) implements Cell {}

    public record Date(LocalDateTime value, boolean withTime) implements Cell {}

    public record Bool(boolean value) implements Cell {}

    public record Text(String value) implements Cell {}

    private static final Empty EMPTY = new Empty();

    private Cells() {}

    public static Cell of(Column column, Object raw) {
        if (raw == null || "".equals(raw)) {
            return EMPTY;
        }
        if (raw instanceof Boolean b) {
            return new Bool(b);
        }
        String type = column.type() == null ? "string" : column.type();
        switch (type) {
            case "number", "currency", "percent" -> {
                BigDecimal n = numeric(raw);
                return n == null ? new Text(String.valueOf(raw)) : new Num(n);
            }
            case "date", "datetime" -> {
                LocalDateTime d = raw instanceof String s ? CellFormats.parseDateTime(s) : null;
                return d == null ? new Text(String.valueOf(raw)) : new Date(d, type.equals("datetime"));
            }
            default -> {
                return raw instanceof Number n ? new Text(plain(n)) : new Text(String.valueOf(raw));
            }
        }
    }

    /** How a person reads the cell: formatted numbers and money, dates in the reader's calendar. */
    public static String display(Cell cell, Column column, Document doc) {
        return switch (cell) {
            case Empty e -> "";
            case Bool b -> String.valueOf(b.value());
            case Text t -> t.value();
            case Date d -> CellFormats.date(d.value(), column.format(), doc.style(), d.withTime());
            case Num n -> switch (column.type() == null ? "" : column.type()) {
                case "currency" -> CellFormats.currency(n.value(), doc.currency());
                case "percent" -> CellFormats.percent(n.value(), 1);
                default -> CellFormats.number(n.value());
            };
        };
    }

    /** How a script reads the cell: plain numbers at full precision, ISO dates, true/false. */
    public static String machine(Cell cell) {
        return switch (cell) {
            case Empty e -> "";
            case Bool b -> String.valueOf(b.value());
            case Text t -> t.value();
            case Date d -> d.withTime()
                    ? d.value().toLocalDate() + " " + String.format("%02d:%02d:%02d", d.value().getHour(), d.value().getMinute(), d.value().getSecond())
                    : d.value().toLocalDate().toString();
            case Num n -> n.value().toPlainString();
        };
    }

    /** The totals row of a section: a value for each column that asks for one, null for the rest. */
    public static List<BigDecimal> totals(Section section) {
        List<BigDecimal> out = new ArrayList<>();
        for (Column column : section.columns()) {
            String op = column.total() == null ? "none" : column.total().toLowerCase(Locale.ROOT);
            if (op.equals("none")) {
                out.add(null);
                continue;
            }
            List<BigDecimal> values = new ArrayList<>();
            long present = 0;
            for (Map<String, Object> row : section.rows()) {
                Cell cell = of(column, row.get(column.key()));
                if (!(cell instanceof Empty)) {
                    present++;
                }
                if (cell instanceof Num n) {
                    values.add(n.value());
                }
            }
            out.add(switch (op) {
                case "count" -> BigDecimal.valueOf(present);
                case "sum" -> values.stream().reduce(BigDecimal.ZERO, BigDecimal::add);
                case "avg" -> values.isEmpty() ? null
                        : values.stream().reduce(BigDecimal.ZERO, BigDecimal::add).divide(BigDecimal.valueOf(values.size()), 10, java.math.RoundingMode.HALF_UP).stripTrailingZeros();
                case "min" -> values.stream().min(BigDecimal::compareTo).orElse(null);
                case "max" -> values.stream().max(BigDecimal::compareTo).orElse(null);
                default -> null;
            });
        }
        return out;
    }

    public static boolean hasTotals(Section section) {
        return section.showTotals() && !section.rows().isEmpty()
                && section.columns().stream().anyMatch(c -> c.total() != null && !c.total().equalsIgnoreCase("none"));
    }

    private static BigDecimal numeric(Object raw) {
        try {
            return raw instanceof Number n ? new BigDecimal(n.toString()) : new BigDecimal(String.valueOf(raw).trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String plain(Number n) {
        return n instanceof Double || n instanceof Float ? new BigDecimal(n.toString()).stripTrailingZeros().toPlainString() : n.toString();
    }
}
