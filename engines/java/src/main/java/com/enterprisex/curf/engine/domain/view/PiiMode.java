package com.enterprisex.curf.engine.domain.view;

/** How a column is treated for viewers who hold none of the view's PII roles. */
public enum PiiMode {
    /** Shown as is. */
    NONE,
    /** Shown as a mask: text becomes a constant, everything else NULL. */
    MASK,
    /** Not offered at all. */
    HIDE
}
