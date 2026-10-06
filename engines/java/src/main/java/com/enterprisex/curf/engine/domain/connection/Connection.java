package com.enterprisex.curf.engine.domain.connection;

import java.time.Instant;
import java.util.UUID;

/** A data source the engine may query. The password is stored separately, encrypted, and never appears here. */
public record Connection(
        UUID id,
        String tenantId,
        String name,
        ConnectionKind kind,
        String host,
        int port,
        String database,
        String username,
        TlsMode tlsMode,
        boolean allowRawSql,
        boolean readOnlyVerified,
        int version,
        Instant createdAt,
        String createdBy,
        Instant updatedAt,
        String updatedBy) {

    /** Stable id of the server this points at, with no credentials. Goes into provenance records. */
    public String fingerprintSource() {
        return kind + "|" + host.toLowerCase() + "|" + port + "|" + database;
    }
}
