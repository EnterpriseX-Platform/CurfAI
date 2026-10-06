package com.enterprisex.curf.engine.infrastructure.jdbc;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.List;

/** Maps driver failures to stable engine errors without leaking credentials or stack traces. */
final class JdbcErrors {

    private JdbcErrors() {}

    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(JdbcErrors.class);

    static EngineException translate(SQLException e) {
        // Codes only: the message may carry host names or fragments of the statement.
        LOG.debug("Database call failed: {} state={} code={}", e.getClass().getSimpleName(), e.getSQLState(), e.getErrorCode());
        if (isTimeout(e)) {
            return new EngineException(ErrorCode.CURF_QUERY_TIMEOUT, "The query ran past its time limit and was cancelled");
        }
        if (isConnectionFailure(e)) {
            return new EngineException(ErrorCode.CURF_CONNECTION_FAILED, "Could not connect to the database");
        }
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "The database rejected the statement",
                List.of(new FieldError("sql", firstLine(e.getMessage()))));
    }

    static boolean isTimeout(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLTimeoutException) {
                return true;
            }
            if (t instanceof SQLException s) {
                String state = s.getSQLState();
                // 57014: PostgreSQL query_canceled. 70100: MySQL query interrupted. 1969/3024: MariaDB / MySQL limits.
                // 131075: Trino's EXCEEDED_TIME_LIMIT, which arrives with no SQLSTATE.
                if ("57014".equals(state) || "70100".equals(state) || s.getErrorCode() == 1969 || s.getErrorCode() == 3024
                        || s.getErrorCode() == 131075
                        || s.getErrorCode() == 1013 && "72000".equals(state) || "HY008".equals(state)) {
                    return true;
                }
            }
        }
        return false;
    }

    static boolean isConnectionFailure(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof java.sql.SQLTransientConnectionException
                    || t instanceof java.sql.SQLNonTransientConnectionException) {
                return true;
            }
            if (t instanceof SQLException s && s.getSQLState() != null && s.getSQLState().startsWith("08")) {
                return true;
            }
        }
        return false;
    }

    private static String firstLine(String message) {
        if (message == null) {
            return "statement failed";
        }
        String line = message.lines().findFirst().orElse("statement failed");
        return line.length() > 300 ? line.substring(0, 300) : line;
    }
}
