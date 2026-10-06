package com.enterprisex.curf.engine.application.report;

import java.math.BigDecimal;
import java.util.Collection;
import java.util.Map;

/**
 * Writes values exactly as JavaScript's {@code JSON.stringify} does, so a hash computed here equals one
 * computed by Curf's Node runner over the same data. Covers what rows and parameters can hold: null,
 * booleans, numbers, strings, lists and maps (keys in insertion order, as JavaScript objects keep them).
 */
final class JsJson {

    private JsJson() {}

    static String stringify(Object value) {
        StringBuilder sb = new StringBuilder();
        write(sb, value);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object value) {
        switch (value) {
            case null -> sb.append("null");
            case Boolean b -> sb.append(b ? "true" : "false");
            case Double d -> sb.append(number(d));
            case Float f -> sb.append(number(f.doubleValue()));
            case Number n -> sb.append(n instanceof BigDecimal bd ? bd.toPlainString() : n.toString());
            case CharSequence s -> string(sb, s.toString());
            case Map<?, ?> map -> {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : map.entrySet()) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    string(sb, String.valueOf(e.getKey()));
                    sb.append(':');
                    write(sb, e.getValue());
                }
                sb.append('}');
            }
            case Collection<?> list -> {
                sb.append('[');
                boolean first = true;
                for (Object item : list) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    write(sb, item);
                }
                sb.append(']');
            }
            default -> string(sb, value.toString());
        }
    }

    /** JavaScript's Number::toString for finite doubles; NaN and infinities become null, as in JSON. */
    static String number(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) {
            return "null";
        }
        if (v == 0) {
            return "0";
        }
        String sign = v < 0 ? "-" : "";
        BigDecimal bd = new BigDecimal(Double.toString(Math.abs(v))).stripTrailingZeros();
        String digits = bd.unscaledValue().toString();
        int k = digits.length();
        int n = k - bd.scale(); // value = 0.DIGITS x 10^n

        StringBuilder out = new StringBuilder(sign);
        if (k <= n && n <= 21) {
            out.append(digits).append("0".repeat(n - k));
        } else if (0 < n && n <= 21) {
            out.append(digits, 0, n).append('.').append(digits.substring(n));
        } else if (-6 < n && n <= 0) {
            out.append("0.").append("0".repeat(-n)).append(digits);
        } else {
            int exponent = n - 1;
            out.append(digits.charAt(0));
            if (k > 1) {
                out.append('.').append(digits.substring(1));
            }
            out.append('e').append(exponent < 0 ? '-' : '+').append(Math.abs(exponent));
        }
        return out.toString();
    }

    /** Quotes and escapes as JSON.stringify does: well-formed, lone surrogates escaped, U+2028 left alone. */
    private static void string(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                        sb.append(c).append(s.charAt(++i));
                    } else if (Character.isSurrogate(c)) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }
}
