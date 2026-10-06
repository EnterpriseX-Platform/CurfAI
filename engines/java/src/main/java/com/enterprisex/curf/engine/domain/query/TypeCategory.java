package com.enterprisex.curf.engine.domain.query;

import java.util.Locale;
import java.util.regex.Pattern;

/** Coarse class of a database type, enough to bind values and choose a mask. */
public enum TypeCategory {
    TEXT,
    NUMBER,
    DATE,
    TIMESTAMP,
    BOOLEAN,
    OTHER;

    private static final Pattern TEXT_TYPE = Pattern.compile(".*(char|text|string|clob|uuid|uniqueidentifier|enum|json|xml).*");
    private static final Pattern NUMBER_TYPE = Pattern.compile(
            "(tiny|small|medium|big)?int(eger)?[0-9]*|serial[0-9]*|bigserial|smallserial|decimal|numeric|dec|fixed|"
                    + "float[0-9]*|double( precision)?|real|number|binary_float|binary_double|money|smallmoney|year");
    private static final Pattern SAFE_TYPE_NAME = Pattern.compile("[A-Za-z][A-Za-z0-9_ ]{0,40}");

    public static TypeCategory of(String typeName) {
        if (typeName == null) {
            return OTHER;
        }
        String t = typeName.toLowerCase(Locale.ROOT).replaceAll("\\(.*?\\)", "").replace("unsigned", "").replace("zerofill", "").trim();
        if (t.equals("bool") || t.equals("boolean") || t.equals("bit")) {
            return BOOLEAN;
        }
        if (t.contains("interval")) {
            return OTHER;
        }
        if (t.startsWith("timestamp") || t.startsWith("datetime") || t.equals("smalldatetime")) {
            return TIMESTAMP;
        }
        if (t.equals("date")) {
            return DATE;
        }
        if (NUMBER_TYPE.matcher(t).matches()) {
            return NUMBER;
        }
        if (TEXT_TYPE.matcher(t).matches()) {
            return TEXT;
        }
        return OTHER;
    }

    /** A type name that is safe to place in a CAST, or null when it is not. */
    public static String safeTypeName(String typeName) {
        return typeName != null && SAFE_TYPE_NAME.matcher(typeName).matches() ? typeName : null;
    }
}
