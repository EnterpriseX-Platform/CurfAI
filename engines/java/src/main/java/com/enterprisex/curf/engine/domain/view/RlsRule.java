package com.enterprisex.curf.engine.domain.view;

/**
 * Row-level rule: only rows whose {@code column} matches one of the viewer's values for
 * {@code attribute}. {@code EQ} and {@code IN} behave the same (a viewer may hold several values, for
 * example two agencies); both are kept so a definition reads the way its author meant it.
 */
public record RlsRule(String column, Operator operator, String attribute) {

    public enum Operator {
        EQ,
        IN
    }
}
