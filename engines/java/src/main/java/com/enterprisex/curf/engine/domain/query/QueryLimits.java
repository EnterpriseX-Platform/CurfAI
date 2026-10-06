package com.enterprisex.curf.engine.domain.query;

import java.time.Duration;

/** Hard ceilings for one statement. {@code maxRows} rows are returned; one more is read to detect truncation. */
public record QueryLimits(int maxRows, Duration timeout, long maxBytes) {}
