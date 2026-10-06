package com.enterprisex.curf.engine.application.connection;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.connection.ConnectionProbe.Introspection;
import com.enterprisex.curf.engine.application.connection.ConnectionProbe.TestResult;
import com.enterprisex.curf.engine.application.connection.ConnectionRepository.Stored;
import com.enterprisex.curf.engine.application.secret.SecretCipher;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.connection.TlsMode;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class ConnectionService {

    private static final Pattern HOST = Pattern.compile("[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?");
    private static final Pattern DATABASE = Pattern.compile("[A-Za-z0-9_$.-]{1,128}");

    private final ConnectionRepository repo;
    private final SecretCipher cipher;
    private final HostPolicy hosts;
    private final ConnectionProbe probe;
    private final ConnectionLifecycle lifecycle;
    private final AuditService audit;
    private final Clock clock;

    public ConnectionService(
            ConnectionRepository repo, SecretCipher cipher, HostPolicy hosts, ConnectionProbe probe,
            ConnectionLifecycle lifecycle, AuditService audit, Clock clock) {
        this.repo = repo;
        this.cipher = cipher;
        this.hosts = hosts;
        this.probe = probe;
        this.lifecycle = lifecycle;
        this.audit = audit;
        this.clock = clock;
    }

    public Connection create(Viewer viewer, ConnectionDraft draft) {
        requireManage(viewer);
        List<FieldError> problems = validate(draft, true);
        fail(problems);
        hosts.verify(draft.host());
        if (repo.nameTaken(viewer.tenantId(), draft.name(), null)) {
            throw invalid("name", "A connection with this name already exists");
        }

        Instant now = clock.instant();
        Connection connection = new Connection(
                UUID.randomUUID(), viewer.tenantId(), draft.name(), draft.kind(), draft.host(),
                draft.port() == null ? draft.kind().defaultPort() : draft.port(), draft.database(),
                draft.username(), draft.tlsMode() == null ? TlsMode.VERIFY : draft.tlsMode(),
                Boolean.TRUE.equals(draft.allowRawSql()), false, 1, now, viewer.subject(), now, viewer.subject());
        repo.insert(connection, cipher.encrypt(draft.password() == null ? "" : draft.password()));
        audit.record(viewer, "connection.create", "connection", connection.id().toString(), details(connection));
        return connection;
    }

    public Connection update(Viewer viewer, UUID id, ConnectionDraft draft, int expectedVersion) {
        requireManage(viewer);
        Stored stored = load(viewer, id);
        fail(validate(draft, false));
        Connection old = stored.connection();
        if (!old.host().equalsIgnoreCase(draft.host())) {
            hosts.verify(draft.host());
        }
        if (repo.nameTaken(viewer.tenantId(), draft.name(), id)) {
            throw invalid("name", "A connection with this name already exists");
        }

        int port = draft.port() == null ? (draft.kind() == old.kind() ? old.port() : draft.kind().defaultPort()) : draft.port();
        TlsMode tls = draft.tlsMode() == null ? old.tlsMode() : draft.tlsMode();
        boolean raw = draft.allowRawSql() == null ? old.allowRawSql() : draft.allowRawSql();
        boolean sameTarget = old.kind() == draft.kind() && old.host().equalsIgnoreCase(draft.host())
                && old.port() == port && old.database().equals(draft.database())
                && old.username().equals(draft.username()) && draft.password() == null;

        Connection changed = new Connection(
                id, old.tenantId(), draft.name(), draft.kind(), draft.host(), port, draft.database(),
                draft.username(), tls, raw, sameTarget && old.readOnlyVerified(), old.version() + 1,
                old.createdAt(), old.createdBy(), clock.instant(), viewer.subject());
        if (!repo.update(changed, draft.password() == null ? null : cipher.encrypt(draft.password()), expectedVersion)) {
            throw new EngineException(ErrorCode.CURF_STALE_VERSION,
                    "The connection was changed by someone else; reload it and try again");
        }
        lifecycle.evict(id);
        audit.record(viewer, "connection.update", "connection", id.toString(), details(changed));
        return changed;
    }

    public void delete(Viewer viewer, UUID id) {
        requireManage(viewer);
        if (!repo.delete(viewer.tenantId(), id)) {
            throw notFound();
        }
        lifecycle.evict(id);
        audit.record(viewer, "connection.delete", "connection", id.toString(), Map.of());
    }

    public Connection get(Viewer viewer, UUID id) {
        requireManage(viewer);
        return load(viewer, id).connection();
    }

    public PageResult<Connection> list(Viewer viewer, int page, int size) {
        requireManage(viewer);
        if (page < 0 || size < 1 || size > 200) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "page must be >= 0 and size between 1 and 200");
        }
        return repo.list(viewer.tenantId(), page, size);
    }

    public TestResult test(Viewer viewer, UUID id) {
        requireManage(viewer);
        Stored stored = load(viewer, id);
        TestResult result = probe.test(stored.connection(), cipher.decrypt(stored.secret()));
        if (result.readOnlyVerified() != stored.connection().readOnlyVerified()) {
            repo.setReadOnlyVerified(viewer.tenantId(), id, result.readOnlyVerified());
        }
        audit.record(viewer, "connection.test", "connection", id.toString(),
                Map.of("ok", result.ok(), "readOnlyVerified", result.readOnlyVerified()));
        return result;
    }

    public Introspection introspect(Viewer viewer, UUID id) {
        requireManage(viewer);
        Stored stored = load(viewer, id);
        return probe.introspect(stored.connection(), cipher.decrypt(stored.secret()));
    }

    private Stored load(Viewer viewer, UUID id) {
        return repo.find(viewer.tenantId(), id).orElseThrow(ConnectionService::notFound);
    }

    private static void requireManage(Viewer viewer) {
        if (!viewer.can(Permission.CONNECTION_MANAGE)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Managing connections requires the connection:manage permission");
        }
    }

    private static EngineException notFound() {
        return new EngineException(ErrorCode.CURF_NOT_FOUND, "No such connection");
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }

    private static void fail(List<FieldError> problems) {
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", problems);
        }
    }

    /** Keeps characters that could smuggle extra JDBC URL parameters out of host and database. */
    private static List<FieldError> validate(ConnectionDraft d, boolean passwordRequired) {
        List<FieldError> p = new ArrayList<>();
        if (d.name() == null || d.name().isBlank() || d.name().length() > 100) {
            p.add(new FieldError("name", "must be 1 to 100 characters"));
        }
        if (d.kind() == null) {
            p.add(new FieldError("kind", "is required"));
        }
        if (d.host() == null || !HOST.matcher(d.host()).matches()) {
            p.add(new FieldError("host", "must be a host name or IPv4 address"));
        }
        if (d.port() != null && (d.port() < 1 || d.port() > 65535)) {
            p.add(new FieldError("port", "must be between 1 and 65535"));
        }
        if (d.database() == null || !DATABASE.matcher(d.database()).matches()) {
            p.add(new FieldError("database", "may contain only letters, digits, _ $ . -"));
        }
        if (d.username() == null || d.username().isBlank() || d.username().length() > 128) {
            p.add(new FieldError("username", "must be 1 to 128 characters"));
        }
        if (passwordRequired && d.kind() != ConnectionKind.TRINO && (d.password() == null || d.password().isEmpty())) {
            p.add(new FieldError("password", "is required"));
        }
        return p;
    }

    private static Map<String, Object> details(Connection c) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", c.name());
        m.put("kind", c.kind());
        m.put("host", c.host());
        m.put("port", c.port());
        m.put("database", c.database());
        m.put("tlsMode", c.tlsMode());
        m.put("allowRawSql", c.allowRawSql());
        m.put("version", c.version());
        return m;
    }
}
