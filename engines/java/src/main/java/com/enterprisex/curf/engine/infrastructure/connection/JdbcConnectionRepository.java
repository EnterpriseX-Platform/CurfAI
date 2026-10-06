package com.enterprisex.curf.engine.infrastructure.connection;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.connection.ConnectionRepository;
import com.enterprisex.curf.engine.application.secret.SecretCipher.EncryptedSecret;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.connection.TlsMode;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class JdbcConnectionRepository implements ConnectionRepository {

    private static final String COLUMNS = """
            id, tenant_id, name, kind, host, port, database_name, username, tls_mode, allow_raw_sql,
            read_only_verified, version, created_at, created_by, updated_at, updated_by""";

    private final JdbcClient jdbc;

    public JdbcConnectionRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insert(Connection c, EncryptedSecret secret) {
        try {
            jdbc.sql("""
                    insert into engine_connection
                      (id, tenant_id, name, kind, host, port, database_name, username, secret_ciphertext, key_id,
                       tls_mode, allow_raw_sql, read_only_verified, version, created_at, created_by, updated_at, updated_by)
                    values (:id, :tenant, :name, :kind, :host, :port, :db, :user, :secret, :keyId,
                       :tls, :raw, :ro, :version, :createdAt, :createdBy, :updatedAt, :updatedBy)
                    """)
                    .param("id", c.id()).param("tenant", c.tenantId()).param("name", c.name())
                    .param("kind", c.kind().name()).param("host", c.host()).param("port", c.port())
                    .param("db", c.database()).param("user", c.username())
                    .param("secret", secret.ciphertext()).param("keyId", secret.keyId())
                    .param("tls", c.tlsMode().name()).param("raw", c.allowRawSql())
                    .param("ro", c.readOnlyVerified()).param("version", c.version())
                    .param("createdAt", Timestamp.from(c.createdAt())).param("createdBy", c.createdBy())
                    .param("updatedAt", Timestamp.from(c.updatedAt())).param("updatedBy", c.updatedBy())
                    .update();
        } catch (DuplicateKeyException e) {
            throw nameTaken();
        }
    }

    @Override
    public Optional<Stored> find(String tenantId, UUID id) {
        return jdbc.sql("select " + COLUMNS + ", secret_ciphertext, key_id from engine_connection where tenant_id = :t and id = :id")
                .param("t", tenantId).param("id", id)
                .query((rs, n) -> new Stored(map(rs), new EncryptedSecret(rs.getString("key_id"), rs.getString("secret_ciphertext"))))
                .optional();
    }

    @Override
    public PageResult<Connection> list(String tenantId, int page, int size) {
        long total = jdbc.sql("select count(*) from engine_connection where tenant_id = :t")
                .param("t", tenantId).query(Long.class).single();
        List<Connection> content = jdbc.sql("select " + COLUMNS
                        + " from engine_connection where tenant_id = :t order by name limit :limit offset :offset")
                .param("t", tenantId).param("limit", size).param("offset", (long) page * size)
                .query((rs, n) -> map(rs)).list();
        return new PageResult<>(content, page, size, total);
    }

    @Override
    public boolean update(Connection c, EncryptedSecret secretOrNull, int expectedVersion) {
        try {
            var statement = jdbc.sql("""
                    update engine_connection set
                      name = :name, kind = :kind, host = :host, port = :port, database_name = :db, username = :user,
                      tls_mode = :tls, allow_raw_sql = :raw, read_only_verified = :ro, version = :version,
                      updated_at = :updatedAt, updated_by = :updatedBy
                      %s
                    where tenant_id = :tenant and id = :id and version = :expected
                    """.formatted(secretOrNull == null ? "" : ", secret_ciphertext = :secret, key_id = :keyId"))
                    .param("name", c.name()).param("kind", c.kind().name()).param("host", c.host())
                    .param("port", c.port()).param("db", c.database()).param("user", c.username())
                    .param("tls", c.tlsMode().name()).param("raw", c.allowRawSql())
                    .param("ro", c.readOnlyVerified()).param("version", c.version())
                    .param("updatedAt", Timestamp.from(c.updatedAt())).param("updatedBy", c.updatedBy())
                    .param("tenant", c.tenantId()).param("id", c.id()).param("expected", expectedVersion);
            if (secretOrNull != null) {
                statement = statement.param("secret", secretOrNull.ciphertext()).param("keyId", secretOrNull.keyId());
            }
            return statement.update() == 1;
        } catch (DuplicateKeyException e) {
            throw nameTaken();
        }
    }

    @Override
    public boolean delete(String tenantId, UUID id) {
        try {
            return jdbc.sql("delete from engine_connection where tenant_id = :t and id = :id")
                    .param("t", tenantId).param("id", id).update() == 1;
        } catch (DataIntegrityViolationException e) {
            throw new EngineException(ErrorCode.CURF_CONFLICT, "Views still use this connection; delete or move them first");
        }
    }

    @Override
    public void setReadOnlyVerified(String tenantId, UUID id, boolean verified) {
        jdbc.sql("update engine_connection set read_only_verified = :v where tenant_id = :t and id = :id")
                .param("v", verified).param("t", tenantId).param("id", id).update();
    }

    @Override
    public boolean nameTaken(String tenantId, String name, UUID exceptIdOrNull) {
        return jdbc.sql("select count(*) from engine_connection where tenant_id = :t and lower(name) = lower(:n)"
                        + (exceptIdOrNull == null ? "" : " and id <> :except"))
                .param("t", tenantId).param("n", name)
                .params(exceptIdOrNull == null ? java.util.Map.of() : java.util.Map.of("except", exceptIdOrNull))
                .query(Long.class).single() > 0;
    }

    private static EngineException nameTaken() {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                List.of(new FieldError("name", "A connection with this name already exists")));
    }

    private static Connection map(ResultSet rs) throws SQLException {
        return new Connection(
                rs.getObject("id", UUID.class), rs.getString("tenant_id"), rs.getString("name"),
                ConnectionKind.valueOf(rs.getString("kind")), rs.getString("host"), rs.getInt("port"),
                rs.getString("database_name"), rs.getString("username"), TlsMode.valueOf(rs.getString("tls_mode")),
                rs.getBoolean("allow_raw_sql"), rs.getBoolean("read_only_verified"), rs.getInt("version"),
                rs.getTimestamp("created_at").toInstant(), rs.getString("created_by"),
                rs.getTimestamp("updated_at").toInstant(), rs.getString("updated_by"));
    }
}
