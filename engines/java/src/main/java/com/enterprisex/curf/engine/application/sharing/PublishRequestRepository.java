package com.enterprisex.curf.engine.application.sharing;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.sharing.PublishRequest.State;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port. Every method is scoped by tenant. */
public interface PublishRequestRepository {

    void insert(PublishRequest request);

    Optional<PublishRequest> find(String tenantId, UUID id);

    Optional<PublishRequest> pendingFor(String tenantId, UUID reportId);

    List<PublishRequest> forReport(String tenantId, UUID reportId);

    PageResult<PublishRequest> byState(String tenantId, State state, int page, int size);

    /** Decides a request only if it is still pending; returns false when someone else decided first. */
    boolean decide(String tenantId, UUID id, State state, String by, Instant at, String note);
}
