package com.enterprisex.curf.engine.application.connection;

import java.util.UUID;

/** Port: lets the service drop pooled sessions when a connection changes or is deleted. */
public interface ConnectionLifecycle {

    void evict(UUID connectionId);
}
