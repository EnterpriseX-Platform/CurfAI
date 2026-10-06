package com.enterprisex.curf.engine.application.report;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The fingerprints Curf records for every query (provenance.ts): a hash of the query definition with
 * the parameters it uses, and a hash of the rows. They are computed by the same rules, so a report run
 * by the engine and by Curf's Node runner over the same data yields the same strings.
 */
public final class CurfHashes {

    private static final Pattern PARAM_REFERENCE = Pattern.compile("[:{]([a-zA-Z_][a-zA-Z0-9_]*)\\}?");
    /** JavaScript's \s, which is wider than Java's: it includes no-break and Unicode spaces. */
    private static final Pattern JS_WHITESPACE =
            Pattern.compile("[\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+");

    private CurfHashes() {}

    /** Hash of the SQL (whitespace collapsed, lower-cased) and the values of the parameters it mentions. */
    public static String queryDefinition(String sql, Map<String, Object> params) {
        Map<String, Object> bound = new LinkedHashMap<>();
        String text = sql == null ? "" : sql;
        Matcher m = PARAM_REFERENCE.matcher(text);
        while (m.find()) {
            String name = m.group(1);
            if (params.containsKey(name)) {
                bound.put(name, params.get(name));
            }
        }
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("sql", JS_WHITESPACE.matcher(text).replaceAll(" ").strip().toLowerCase(java.util.Locale.ROOT));
        canonical.put("method", null);
        canonical.put("path", null);
        canonical.put("body", null);
        canonical.put("jsonPath", null);
        canonical.put("headers", null);
        canonical.put("params", bound);
        return "sha256:" + hex(JsJson.stringify(canonical));
    }

    /** Hash of a row set; each row is written with its keys sorted, one per line. */
    public static String rows(List<? extends Map<String, Object>> rows) {
        MessageDigest digest = digest();
        for (Map<String, Object> row : rows) {
            digest.update(JsJson.stringify(new TreeMap<>(row)).getBytes(StandardCharsets.UTF_8));
            digest.update((byte) '\n');
        }
        return "sha256:" + HexFormat.of().formatHex(digest.digest()).substring(0, 24);
    }

    /** Same shape of string for definitions that have no SQL of their own (a view with a structured request). */
    public static String text(String canonical) {
        return "sha256:" + hex(canonical);
    }

    private static String hex(String text) {
        return HexFormat.of().formatHex(digest().digest(text.getBytes(StandardCharsets.UTF_8))).substring(0, 24);
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
