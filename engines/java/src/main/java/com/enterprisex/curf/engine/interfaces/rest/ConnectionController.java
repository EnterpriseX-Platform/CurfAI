package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.connection.ConnectionDraft;
import com.enterprisex.curf.engine.application.connection.ConnectionProbe.Introspection;
import com.enterprisex.curf.engine.application.connection.ConnectionProbe.TestResult;
import com.enterprisex.curf.engine.application.connection.ConnectionService;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.connection.TlsMode;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/engine/v1/connections")
public class ConnectionController {

    /** The password is write-only: accepted here, never returned by any endpoint. */
    public record ConnectionRequest(
            String name, ConnectionKind kind, String host, Integer port, String database, String username,
            String password, TlsMode tlsMode, Boolean allowRawSql, Integer version) {

        ConnectionDraft toDraft() {
            return new ConnectionDraft(name, kind, host, port, database, username, password, tlsMode, allowRawSql);
        }
    }

    public record ConnectionResponse(
            UUID id, String name, ConnectionKind kind, String host, int port, String database, String username,
            TlsMode tlsMode, boolean allowRawSql, boolean readOnlyVerified, boolean hasPassword, int version,
            Instant createdAt, String createdBy, Instant updatedAt, String updatedBy) {

        static ConnectionResponse of(Connection c) {
            return new ConnectionResponse(c.id(), c.name(), c.kind(), c.host(), c.port(), c.database(), c.username(),
                    c.tlsMode(), c.allowRawSql(), c.readOnlyVerified(), true, c.version(), c.createdAt(),
                    c.createdBy(), c.updatedAt(), c.updatedBy());
        }
    }

    private final ConnectionService service;

    public ConnectionController(ConnectionService service) {
        this.service = service;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    ConnectionResponse create(Viewer viewer, @RequestBody ConnectionRequest body) {
        return ConnectionResponse.of(service.create(viewer, body.toDraft()));
    }

    @GetMapping
    PageResult<ConnectionResponse> list(
            Viewer viewer, @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "50") int size) {
        PageResult<Connection> result = service.list(viewer, page, size);
        return new PageResult<>(result.content().stream().map(ConnectionResponse::of).toList(),
                result.page(), result.size(), result.totalElements());
    }

    @GetMapping("/{id}")
    ConnectionResponse get(Viewer viewer, @PathVariable UUID id) {
        return ConnectionResponse.of(service.get(viewer, id));
    }

    @PutMapping("/{id}")
    ConnectionResponse update(Viewer viewer, @PathVariable UUID id, @RequestBody ConnectionRequest body) {
        if (body.version() == null) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                    List.of(new FieldError("version", "is required so concurrent edits are detected")));
        }
        return ConnectionResponse.of(service.update(viewer, id, body.toDraft(), body.version()));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void delete(Viewer viewer, @PathVariable UUID id) {
        service.delete(viewer, id);
    }

    @PostMapping("/{id}/test")
    TestResult test(Viewer viewer, @PathVariable UUID id) {
        return service.test(viewer, id);
    }

    @PostMapping("/{id}/introspect")
    Introspection introspect(Viewer viewer, @PathVariable UUID id) {
        return service.introspect(viewer, id);
    }
}
