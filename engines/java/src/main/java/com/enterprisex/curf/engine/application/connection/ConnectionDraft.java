package com.enterprisex.curf.engine.application.connection;

import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.connection.TlsMode;

/**
 * What a caller supplies to create or change a connection. On update, a null {@code password} keeps
 * the stored one; null {@code port}, {@code tlsMode} and {@code allowRawSql} take their defaults.
 */
public record ConnectionDraft(
        String name,
        ConnectionKind kind,
        String host,
        Integer port,
        String database,
        String username,
        String password,
        TlsMode tlsMode,
        Boolean allowRawSql) {}
