package com.enterprisex.curf.engine.infrastructure.jdbc;

import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.connection.TlsMode;
import java.util.Properties;

/**
 * Builds driver URLs from validated parts only (host and database are checked against a strict
 * pattern before they get here). Credentials are never put in the URL.
 */
final class JdbcUrls {

    private JdbcUrls() {}

    static String of(Connection c) {
        String base = c.host() + ":" + c.port() + "/" + c.database();
        return switch (c.kind()) {
            case POSTGRESQL -> "jdbc:postgresql://" + base
                    + "?sslmode=" + switch (c.tlsMode()) {
                        case VERIFY -> "verify-full";
                        case REQUIRE -> "require";
                        case DISABLE -> "disable";
                    }
                    // Text parameters are sent untyped so the server infers the type, as Curf's own Postgres driver does:
                    // "WHERE sale_date >= :from" with a text date works instead of failing on varchar vs date.
                    + "&stringtype=unspecified"
                    + "&ApplicationName=curf-engine&connectTimeout=10&options=-c%20default_transaction_read_only=on";
            case MYSQL -> "jdbc:mysql://" + base
                    + "?sslMode=" + switch (c.tlsMode()) {
                        case VERIFY -> "VERIFY_IDENTITY";
                        case REQUIRE -> "REQUIRED";
                        case DISABLE -> "DISABLED";
                    }
                    + "&allowMultiQueries=false&allowLoadLocalInfile=false&connectTimeout=10000"
                    + (c.tlsMode() == TlsMode.VERIFY ? "" : "&allowPublicKeyRetrieval=true");
            case MARIADB -> "jdbc:mariadb://" + base
                    + "?sslMode=" + switch (c.tlsMode()) {
                        case VERIFY -> "verify-full";
                        case REQUIRE -> "trust";
                        case DISABLE -> "disable";
                    }
                    + "&allowMultiQueries=false&allowLocalInfile=false&assureReadOnly=true&connectTimeout=10000"
                    + (c.tlsMode() == TlsMode.VERIFY ? "" : "&allowPublicKeyRetrieval=true");
            // The database of an Oracle connection is its service name. TLS uses the tcps protocol.
            case ORACLE -> "jdbc:oracle:thin:@" + (c.tlsMode() == TlsMode.DISABLE ? "//" : "tcps://") + base;
            // Trino: database is the catalog, or catalog.schema. TLS is its https.
            case TRINO -> "jdbc:trino://" + c.host() + ":" + c.port() + "/" + c.database().replace('.', '/')
                    + (c.tlsMode() == TlsMode.DISABLE ? "?SSL=false" : "?SSL=true&SSLVerification=" + (c.tlsMode() == TlsMode.VERIFY ? "FULL" : "NONE"))
                    + "&applicationNamePrefix=curf-engine";
            case SQLSERVER -> "jdbc:sqlserver://" + c.host() + ":" + c.port()
                    + ";databaseName=" + c.database()
                    + ";encrypt=" + (c.tlsMode() == TlsMode.DISABLE ? "false" : "true")
                    + ";trustServerCertificate=" + (c.tlsMode() == TlsMode.VERIFY ? "false" : "true")
                    + ";applicationName=curf-engine;applicationIntent=ReadOnly;loginTimeout=10";
        };
    }

    /** Whether a password goes to the driver. Trino accepts one only over TLS (without it the driver refuses to send it). */
    static boolean sendsPassword(Connection c) {
        return c.kind() != com.enterprisex.curf.engine.domain.connection.ConnectionKind.TRINO || c.tlsMode() != TlsMode.DISABLE;
    }

    /** Driver settings that do not fit in the URL. Credentials are added by the caller. */
    static Properties properties(Connection c) {
        Properties p = new Properties();
        if (c.kind() == com.enterprisex.curf.engine.domain.connection.ConnectionKind.ORACLE) {
            p.setProperty("oracle.net.CONNECT_TIMEOUT", "10000");
            p.setProperty("v$session.program", "curf-engine");
            // A session time zone given as a region name fails on hosts whose Java does not know it.
            p.setProperty("oracle.jdbc.timezoneAsRegion", "false");
            if (c.tlsMode() != TlsMode.DISABLE) {
                p.setProperty("oracle.net.ssl_server_dn_match", c.tlsMode() == TlsMode.VERIFY ? "true" : "false");
            }
        }
        return p;
    }
}
