package com.enterprisex.curf.engine.application.connection;

import com.enterprisex.curf.engine.domain.connection.Connection;
import java.util.List;

/** Port: what the engine can ask a database without running user SQL. */
public interface ConnectionProbe {

    record TestResult(boolean ok, long latencyMs, String serverVersion, boolean readOnlyVerified, List<String> warnings) {}

    record ColumnInfo(String name, String type, boolean nullable, String piiSuggestion) {}

    record TableInfo(String name, String type, List<ColumnInfo> columns) {}

    record SchemaInfo(String name, List<TableInfo> tables) {}

    record Introspection(List<SchemaInfo> schemas, boolean truncated) {}

    /** Connects with the stored credentials and reports health, version and account privileges. */
    TestResult test(Connection connection, String password);

    Introspection introspect(Connection connection, String password);
}
