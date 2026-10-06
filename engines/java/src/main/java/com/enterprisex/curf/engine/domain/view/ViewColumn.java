package com.enterprisex.curf.engine.domain.view;

/** A column a view offers. {@code type} is the database's own type name from the result metadata. */
public record ViewColumn(String name, String type, String label, String description, PiiMode pii) {

    public ViewColumn {
        pii = pii == null ? PiiMode.NONE : pii;
        label = label == null || label.isBlank() ? name : label;
    }
}
