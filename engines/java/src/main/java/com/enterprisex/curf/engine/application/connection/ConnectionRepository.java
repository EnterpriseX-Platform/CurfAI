package com.enterprisex.curf.engine.application.connection;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.secret.SecretCipher.EncryptedSecret;
import com.enterprisex.curf.engine.domain.connection.Connection;
import java.util.Optional;
import java.util.UUID;

/** Port. Every method is scoped by tenant; there is no way to read another tenant's row. */
public interface ConnectionRepository {

    record Stored(Connection connection, EncryptedSecret secret) {}

    void insert(Connection connection, EncryptedSecret secret);

    Optional<Stored> find(String tenantId, UUID id);

    PageResult<Connection> list(String tenantId, int page, int size);

    /** Updates only if {@code expectedVersion} still matches; returns false when it does not. */
    boolean update(Connection connection, EncryptedSecret secretOrNull, int expectedVersion);

    boolean delete(String tenantId, UUID id);

    void setReadOnlyVerified(String tenantId, UUID id, boolean verified);

    boolean nameTaken(String tenantId, String name, UUID exceptIdOrNull);
}
