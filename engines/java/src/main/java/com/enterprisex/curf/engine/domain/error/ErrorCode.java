package com.enterprisex.curf.engine.domain.error;

/** Stable, machine-readable error codes. The HTTP status is the one the REST layer returns. */
public enum ErrorCode {
    CURF_INVALID_INPUT(422),
    CURF_SQL_REJECTED(422),
    CURF_QUERY_TIMEOUT(504),
    CURF_TOO_MANY_QUERIES(429),
    CURF_UNAUTHENTICATED(401),
    CURF_FORBIDDEN(403),
    CURF_SEGREGATION_OF_DUTIES(403),
    CURF_NOT_FOUND(404),
    CURF_STALE_VERSION(409),
    CURF_CONFLICT(409),
    CURF_ROW_LIMIT(422),
    CURF_EXPORT_UNAVAILABLE(503),
    CURF_CONNECTION_FAILED(502),
    CURF_INTERNAL(500);

    private final int httpStatus;

    ErrorCode(int httpStatus) {
        this.httpStatus = httpStatus;
    }

    public int httpStatus() {
        return httpStatus;
    }
}
