package com.enterprisex.curf.engine.domain.query;

import java.util.Locale;
import java.util.regex.Pattern;

/** Suggests, by column name only, which columns probably hold personal data. A person still decides. */
public final class PiiHeuristics {

    public enum Suggestion {
        NONE,
        MASK,
        HIDE
    }

    private static final Pattern HIDE = Pattern.compile("(password|passwd|secret|token|api_?key|private_?key)");
    private static final Pattern MASK = Pattern.compile(
            "(e_?mail|phone|mobile|(^|_)tel(_|$)|national_?id|citizen|id_?card|passport|(^|_)ssn(_|$)|tax_?id|"
                    + "birth|(^|_)dob(_|$)|salary|address|first_?name|last_?name|full_?name|sur_?name|"
                    + "ชื่อ|นามสกุล|เบอร์|โทร|บัตรประชาชน|เลขประจำตัว|ที่อยู่)");

    private PiiHeuristics() {}

    public static Suggestion suggest(String columnName) {
        String name = columnName.toLowerCase(Locale.ROOT);
        if (HIDE.matcher(name).find()) {
            return Suggestion.HIDE;
        }
        return MASK.matcher(name).find() ? Suggestion.MASK : Suggestion.NONE;
    }
}
