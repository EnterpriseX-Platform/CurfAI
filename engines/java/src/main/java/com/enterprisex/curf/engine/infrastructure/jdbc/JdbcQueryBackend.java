package com.enterprisex.curf.engine.infrastructure.jdbc;

import com.enterprisex.curf.engine.application.query.QueryBackend;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.QueryLimits;
import java.math.BigDecimal;
import java.sql.Clob;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

/**
 * Runs a guarded statement inside a read-only transaction that is always rolled back, with a server
 * side timeout, a driver timeout, a row cap and a byte cap. Even if the guard and the account were
 * both wrong, the transaction is read-only and nothing is ever committed.
 */
@Component
public class JdbcQueryBackend implements QueryBackend {

    private final JdbcPools pools;

    public JdbcQueryBackend(JdbcPools pools) {
        this.pools = pools;
    }

    @Override
    public RawResult execute(Connection c, String password, String sql, List<Object> params, QueryLimits limits) {
        try (java.sql.Connection conn = pools.pool(c, password).getConnection()) {
            try {
                conn.setReadOnly(true);
                conn.setAutoCommit(false);
                prepareSession(c.kind(), conn, limits);
                return run(conn, c.kind(), sql, params, limits);
            } finally {
                conn.rollback();
            }
        } catch (SQLException e) {
            throw JdbcErrors.translate(e);
        }
    }

    private static void prepareSession(ConnectionKind kind, java.sql.Connection conn, QueryLimits limits) throws SQLException {
        long ms = Math.max(1, limits.timeout().toMillis());
        try (Statement st = conn.createStatement()) {
            switch (kind) {
                case POSTGRESQL -> {
                    st.execute("SET TRANSACTION READ ONLY");
                    st.execute("SET LOCAL statement_timeout = " + ms);
                }
                case MYSQL -> st.execute("SET SESSION max_execution_time = " + ms);
                case MARIADB -> st.execute("SET SESSION max_statement_time = " + (ms / 1000.0));
                // Oracle: setReadOnly(true) already began the transaction as READ ONLY; the driver timeout bounds the rest.
                // Trino: setReadOnly(true) starts a READ ONLY transaction, which refuses every write statement.
                case ORACLE, TRINO -> { }
                // SQL Server has no read-only transaction: the account's rights and the guard are the control there.
                // A lock wait is bounded like everything else, so a blocked read cannot hold a connection past its limit.
                case SQLSERVER -> st.execute("SET LOCK_TIMEOUT " + ms);
            }
        }
    }

    private RawResult run(java.sql.Connection conn, ConnectionKind kind, String sql, List<Object> params, QueryLimits limits) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql, ResultSet.TYPE_FORWARD_ONLY, ResultSet.CONCUR_READ_ONLY)) {
            ps.setQueryTimeout((int) Math.max(1, (limits.timeout().toMillis() + 999) / 1000));
            ps.setMaxRows(limits.maxRows() + 1);
            ps.setFetchSize(Math.min(1000, limits.maxRows() + 1));
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            if (!ps.execute()) {
                throw new EngineException(ErrorCode.CURF_SQL_REJECTED, "The statement did not return rows");
            }
            try (ResultSet rs = ps.getResultSet()) {
                ResultSetMetaData meta = rs.getMetaData();
                int width = meta.getColumnCount();
                List<Column> columns = new ArrayList<>(width);
                int[] scales = new int[width + 1];
                for (int i = 1; i <= width; i++) {
                    columns.add(new Column(meta.getColumnLabel(i), meta.getColumnTypeName(i)));
                    scales[i] = kind == ConnectionKind.ORACLE ? meta.getScale(i) : 0;
                }

                List<List<Object>> rows = new ArrayList<>();
                long bytes = 0;
                boolean truncated = false;
                while (rs.next()) {
                    if (rows.size() >= limits.maxRows()) {
                        truncated = true;
                        break;
                    }
                    List<Object> row = new ArrayList<>(width);
                    for (int i = 1; i <= width; i++) {
                        Object raw = rs.getObject(i);
                        if (raw instanceof BigDecimal d && scales[i] > 0 && d.scale() < scales[i]) {
                            raw = d.setScale(scales[i]);
                        }
                        Object value = normalise(raw, kind);
                        bytes += size(value);
                        row.add(value);
                    }
                    if (bytes > limits.maxBytes()) {
                        truncated = true;
                        break;
                    }
                    rows.add(row);
                }
                return new RawResult(columns, rows, truncated);
            }
        }
    }

    private static final long JS_SAFE_INTEGER = 9_007_199_254_740_991L;
    private static final java.time.format.DateTimeFormatter ISO_MILLIS =
            java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC);

    /**
     * Keeps JSON-friendly values, following what Curf's drivers hand its UI: exact numerics become text so no
     * precision is lost, bigint is text on PostgreSQL (and beyond what JavaScript holds exactly elsewhere), timestamps are ISO
     * UTC with milliseconds, and non-finite floats (which JSON cannot carry) become null. Dates are the plain
     * {@code yyyy-MM-dd}, not a midnight timestamp.
     */
    static Object normalise(Object value, ConnectionKind kind) throws SQLException {
        return switch (value) {
            case null -> null;
            case BigDecimal d -> d.toPlainString();
            // node-postgres hands int8 (so COUNT(*) and SUM of integers) over as text; mysql2 gives a number.
            case Long l -> kind == ConnectionKind.POSTGRESQL || Math.abs(l) > JS_SAFE_INTEGER ? (Object) l.toString() : l;
            case java.math.BigInteger b -> b.abs().compareTo(java.math.BigInteger.valueOf(JS_SAFE_INTEGER)) > 0 ? (Object) b.toString() : (Object) b.longValue();
            case Double d -> Double.isFinite(d) ? d : null;
            case Float f -> Float.isFinite(f) ? f : null;
            case Timestamp t -> ISO_MILLIS.format(t.toInstant());
            case java.sql.Date d -> d.toLocalDate().toString();
            case Time t -> t.toString();
            case byte[] b -> "[binary " + b.length + " bytes]";
            case Clob clob -> clob.getSubString(1, (int) Math.min(clob.length(), 1_000_000));
            case java.sql.Array array -> String.valueOf(array.getArray() instanceof Object[] items ? List.of(items) : array.getArray());
            case Number n -> n;
            case Boolean b -> b;
            case String s -> s;
            default -> value.toString();
        };
    }

    private static long size(Object value) {
        return value instanceof String s ? 2L * s.length() : 16;
    }
}
