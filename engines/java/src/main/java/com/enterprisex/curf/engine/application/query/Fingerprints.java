package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.application.query.QueryBackend.RawResult;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/** Deterministic hashes for provenance, the query log and the cache key. */
final class Fingerprints {

    private static final char FIELD = '\u001f';
    private static final char ROW = '\u001e';

    private Fingerprints() {}

    static String sha256(String text) {
        return HexFormat.of().formatHex(digest().digest(text.getBytes(StandardCharsets.UTF_8)));
    }

    /** Covers the executed SQL, the bound parameter values and the full result, so any change shows. */
    static String provenance(String sql, Map<String, Object> params, RawResult result) {
        MessageDigest md = digest();
        update(md, "sql");
        update(md, sql);
        update(md, "params");
        update(md, canonical(params));
        update(md, "columns");
        result.columns().forEach(c -> update(md, c.name() + FIELD + c.type()));
        update(md, "rows");
        for (List<Object> row : result.rows()) {
            StringBuilder line = new StringBuilder();
            for (Object cell : row) {
                line.append(value(cell)).append(FIELD);
            }
            update(md, line.append(ROW).toString());
        }
        update(md, result.truncated() ? "truncated" : "complete");
        return HexFormat.of().formatHex(md.digest());
    }

    static String canonical(Map<String, Object> params) {
        StringBuilder sb = new StringBuilder();
        new TreeMap<>(params).forEach((k, v) -> sb.append(k).append('=').append(value(v)).append(FIELD));
        return sb.toString();
    }

    /** Two viewers share a cached result only if everything that can change what they see is identical. */
    static String viewerScope(Viewer viewer) {
        StringBuilder sb = new StringBuilder(viewer.tenantId()).append(FIELD);
        sb.append(new TreeSet<>(viewer.roles())).append(FIELD).append(new TreeSet<>(viewer.groups())).append(FIELD);
        new TreeMap<>(viewer.attributes()).forEach((k, v) -> sb.append(k).append('=').append(new TreeSet<>(v)).append(FIELD));
        return sb.toString();
    }

    private static String value(Object v) {
        if (v == null) {
            return "~";
        }
        if (v instanceof List<?> list) {
            StringBuilder sb = new StringBuilder("[");
            list.forEach(x -> sb.append(value(x)).append(','));
            return sb.append(']').toString();
        }
        return v.getClass().getSimpleName() + ':' + v;
    }

    private static void update(MessageDigest md, String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        md.update(Integer.toString(bytes.length).getBytes(StandardCharsets.UTF_8));
        md.update((byte) ':');
        md.update(bytes);
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
