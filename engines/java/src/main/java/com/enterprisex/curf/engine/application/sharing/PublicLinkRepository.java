package com.enterprisex.curf.engine.application.sharing;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port. Looking a link up by its token's hash is the one lookup that is not tenant-scoped; the link then names its tenant. */
public interface PublicLinkRepository {

    void insert(PublicLink link, String tokenHash);

    Optional<PublicLink> findByTokenHash(String tokenHash);

    Optional<PublicLink> find(String tenantId, UUID id);

    List<PublicLink> forReport(String tenantId, UUID reportId);

    /** Marks the link revoked from now on; false if it was already revoked or does not exist. */
    boolean revoke(String tenantId, UUID id, String by, Instant at);
}
