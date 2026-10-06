package com.enterprisex.curf.engine.application.view;

import java.util.List;
import java.util.UUID;

/**
 * What an ordinary viewer learns about a published view: its name and the columns they can see, and
 * whether each is masked for them. No SQL, no row rules, no roles.
 */
public record ViewSummary(UUID id, String name, String description, int version, Integer refreshSeconds, List<Column> columns) {

    public record Column(String name, String label, String description, String type, boolean masked) {}
}
