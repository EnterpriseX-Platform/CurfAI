package com.enterprisex.curf.engine.domain.view;

import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * Decides, for one viewer and one view, which columns are visible (and whether masked) and which rows.
 * Pure logic with no database in it, so every combination can be tested exhaustively.
 */
public final class ViewPolicy {

    private ViewPolicy() {}

    public record ColumnAccess(ViewColumn column, boolean masked) {}

    /** A rule with the viewer's values for its attribute. */
    public record ResolvedRule(RlsRule rule, Set<String> values) {}

    public sealed interface RowAccess permits Unrestricted, Restricted, Denied {}

    /** Every row. */
    public record Unrestricted() implements RowAccess {}

    /** Only rows matching all rules. */
    public record Restricted(List<ResolvedRule> rules) implements RowAccess {}

    /** No rows at all: a rule applies and the viewer holds no value for its attribute. */
    public record Denied(String reason) implements RowAccess {}

    public record Access(List<ColumnAccess> columns, RowAccess rows, boolean seesPii) {

        /** Hash input that changes whenever what this viewer sees changes. Used to scope cache entries. */
        public String profile() {
            StringBuilder sb = new StringBuilder(seesPii ? "pii;" : "masked;");
            if (rows instanceof Restricted r) {
                r.rules().forEach(x -> sb.append(x.rule().column()).append('=').append(new java.util.TreeSet<>(x.values())).append(';'));
            } else {
                sb.append(rows.getClass().getSimpleName()).append(';');
            }
            return sb.toString();
        }
    }

    /** May this viewer query the view at all? Managers always may; others need an allowed role. */
    public static boolean mayQuery(View view, Viewer viewer) {
        if (viewer.can(Permission.VIEW_MANAGE)) {
            return true;
        }
        return !Collections.disjoint(view.allowedRoles(), viewer.roles());
    }

    /**
     * @param attributeValues the viewer's values for an attribute: from the token, else the entitlement table.
     */
    public static Access resolve(View view, Viewer viewer, Function<String, Set<String>> attributeValues) {
        boolean seesPii = !viewer.isAnonymous() && !Collections.disjoint(view.piiRoles(), viewer.roles());

        List<ColumnAccess> visible = new ArrayList<>();
        for (ViewColumn column : view.columns()) {
            switch (column.pii()) {
                case NONE -> visible.add(new ColumnAccess(column, false));
                case MASK -> visible.add(new ColumnAccess(column, !seesPii));
                case HIDE -> {
                    if (seesPii) {
                        visible.add(new ColumnAccess(column, false));
                    }
                }
            }
        }
        return new Access(List.copyOf(visible), rows(view, viewer, attributeValues), seesPii);
    }

    private static RowAccess rows(View view, Viewer viewer, Function<String, Set<String>> attributeValues) {
        if (view.rlsRules().isEmpty() || !Collections.disjoint(view.bypassRoles(), viewer.roles())) {
            return new Unrestricted();
        }
        List<ResolvedRule> resolved = new ArrayList<>();
        for (RlsRule rule : view.rlsRules()) {
            Set<String> values = viewer.isAnonymous() ? Set.of() : new LinkedHashSet<>(attributeValues.apply(rule.attribute()));
            if (values.isEmpty()) {
                return new Denied("no value for attribute " + rule.attribute());
            }
            resolved.add(new ResolvedRule(rule, values));
        }
        return new Restricted(List.copyOf(resolved));
    }
}
