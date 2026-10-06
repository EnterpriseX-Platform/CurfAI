package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.query.QueryLimits;
import java.util.List;

/**
 * Port: runs one already-guarded statement on a customer database. Implementations must run it in a
 * read-only transaction that is always rolled back, with the timeout and row and byte caps applied.
 */
public interface QueryBackend {

    record Column(String name, String type) {}

    record RawResult(List<Column> columns, List<List<Object>> rows, boolean truncated) {}

    RawResult execute(Connection connection, String password, String sql, List<Object> params, QueryLimits limits);
}
