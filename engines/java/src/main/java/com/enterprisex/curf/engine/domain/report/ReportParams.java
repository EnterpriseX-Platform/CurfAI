package com.enterprisex.curf.engine.domain.report;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Turns what a caller supplies into the typed value of every declared parameter, the way Curf does:
 * every declared parameter is always bound; absent or empty means its default, or an empty string. Unlike
 * Curf's runner, which binds whatever it is given, the engine refuses values that cannot be what the
 * parameter says (a number that is not a number, a date that is not a date, a select value that is not an
 * option, a required value that is missing) so a mistake is a clear 422 rather than a database error.
 */
public final class ReportParams {

    private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    private static final int MAX_TEXT = 2000;

    private ReportParams() {}

    public static Map<String, Object> resolve(List<ReportParameter> declared, Map<String, Object> supplied) {
        List<FieldError> problems = new ArrayList<>();
        Map<String, Object> out = new LinkedHashMap<>();

        for (String name : supplied.keySet()) {
            if (declared.stream().noneMatch(p -> p.name().equals(name))) {
                problems.add(new FieldError("params." + name, "is not a parameter of this report"));
            }
        }

        for (ReportParameter p : declared) {
            Object raw = supplied.get(p.name());
            if (raw == null || "".equals(raw)) {
                Object fallback = p.defaultValue() == null ? "" : p.defaultValue();
                if (p.required() && "".equals(fallback)) {
                    problems.add(new FieldError("params." + p.name(), "is required"));
                }
                out.put(p.name(), fallback);
                continue;
            }
            try {
                out.put(p.name(), convert(p, raw));
            } catch (IllegalArgumentException e) {
                problems.add(new FieldError("params." + p.name(), e.getMessage()));
            }
        }
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", problems);
        }
        return out;
    }

    private static Object convert(ReportParameter p, Object raw) {
        return switch (p.type()) {
            case NUMBER -> number(raw);
            case BOOLEAN -> bool(raw);
            case DATE -> date(raw);
            case SELECT -> select(p, text(raw));
            case DATE_RANGE, STRING -> text(raw);
        };
    }

    private static Object number(Object raw) {
        BigDecimal value;
        try {
            value = raw instanceof Number n ? new BigDecimal(n.toString()) : new BigDecimal(String.valueOf(raw).trim());
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("must be a number");
        }
        // A JavaScript number: an integer stays whole, anything else is a double.
        if (value.stripTrailingZeros().scale() <= 0 && value.abs().compareTo(BigDecimal.valueOf(9_007_199_254_740_991L)) <= 0) {
            return value.longValueExact();
        }
        double d = value.doubleValue();
        if (Double.isInfinite(d)) {
            throw new IllegalArgumentException("must be a number");
        }
        return d;
    }

    private static Object bool(Object raw) {
        if (raw instanceof Boolean b) {
            return b;
        }
        String s = String.valueOf(raw);
        if (s.equals("true") || s.equals("false")) {
            return Boolean.parseBoolean(s);
        }
        throw new IllegalArgumentException("must be true or false");
    }

    private static Object date(Object raw) {
        String s = String.valueOf(raw);
        if (!DATE.matcher(s).matches()) {
            throw new IllegalArgumentException("must be a date, yyyy-MM-dd");
        }
        try {
            LocalDate.parse(s);
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException("must be a real date, yyyy-MM-dd");
        }
        return s;
    }

    private static String text(Object raw) {
        if (!(raw instanceof String || raw instanceof Number || raw instanceof Boolean)) {
            throw new IllegalArgumentException("must be text, a number or a boolean");
        }
        String s = String.valueOf(raw);
        if (s.length() > MAX_TEXT) {
            throw new IllegalArgumentException("is longer than " + MAX_TEXT + " characters");
        }
        return s;
    }

    private static Object select(ReportParameter p, String value) {
        if (!p.options().isEmpty() && !p.options().contains(value)) {
            throw new IllegalArgumentException("must be one of the declared options");
        }
        return value;
    }
}
