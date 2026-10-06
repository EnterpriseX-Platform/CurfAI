package com.enterprisex.curf.engine.domain.connection;

/**
 * Database kinds the engine can reach. For Oracle, the connection's database is the service name; for Trino it is the catalog,
 * or {@code catalog.schema}. Trino reaches many sources through one connection and is optional: nothing needs it.
 */
public enum ConnectionKind {
    POSTGRESQL(5432),
    MYSQL(3306),
    MARIADB(3306),
    ORACLE(1521),
    SQLSERVER(1433),
    TRINO(8080);

    private final int defaultPort;

    ConnectionKind(int defaultPort) {
        this.defaultPort = defaultPort;
    }

    public int defaultPort() {
        return defaultPort;
    }
}
