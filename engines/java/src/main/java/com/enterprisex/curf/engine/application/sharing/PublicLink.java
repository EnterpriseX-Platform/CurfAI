package com.enterprisex.curf.engine.application.sharing;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * A way for someone without an account to run a published report: a long-lived PUBLIC link or a short-lived EMBED
 * token for a page that shows it. Only a hash of the secret is kept. {@code lockedParams} fix some parameters so the
 * link shows one period or region whatever the caller sends.
 */
public record PublicLink(
        UUID id,
        String tenantId,
        UUID reportId,
        Kind kind,
        Instant createdAt,
        String createdBy,
        Instant expiresAt,
        Instant revokedAt,
        String revokedBy,
        Map<String, Object> lockedParams) {

    public enum Kind {
        PUBLIC,
        EMBED
    }

    public PublicLink {
        lockedParams = lockedParams == null ? Map.of() : Map.copyOf(lockedParams);
    }

    public boolean usable(Instant now) {
        return revokedAt == null && expiresAt.isAfter(now);
    }
}
