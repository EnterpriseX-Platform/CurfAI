package com.enterprisex.curf.engine.domain.view;

import com.enterprisex.curf.engine.domain.query.PiiHeuristics;
import java.util.ArrayList;
import java.util.List;

/**
 * Whether a view is safe to show to the public. A view is offered to the public by listing the reserved role
 * {@code public} in its allowed roles; this checks that doing so cannot leak: no row rules (a public viewer holds no
 * attributes, so they would show nothing), no role exemptions or personal-data access for {@code public}, and no column that
 * looks like personal data yet is shown unmasked. Masked and hidden columns are fine: the public never sees them.
 */
public final class PublicExposure {

    public static final String PUBLIC_ROLE = "public";

    private PublicExposure() {}

    /** Why this view cannot be public. Empty means it can. Call only for a view that lists the public role. */
    public static List<String> problems(View view) {
        List<String> out = new ArrayList<>();
        if (!view.rlsRules().isEmpty()) {
            out.add("has row rules, which would show a public viewer nothing; use a view without them");
        }
        if (view.piiRoles().contains(PUBLIC_ROLE)) {
            out.add("lets the public role see personal data");
        }
        if (view.bypassRoles().contains(PUBLIC_ROLE)) {
            out.add("lets the public role skip the row rules");
        }
        for (ViewColumn column : view.columns()) {
            if (column.pii() == PiiMode.NONE && PiiHeuristics.suggest(column.name()) != PiiHeuristics.Suggestion.NONE) {
                out.add("column '" + column.name() + "' looks like personal data but is shown unmasked; mask or hide it");
            }
        }
        return out;
    }

    public static boolean offeredToPublic(View view) {
        return view.allowedRoles().contains(PUBLIC_ROLE);
    }
}
