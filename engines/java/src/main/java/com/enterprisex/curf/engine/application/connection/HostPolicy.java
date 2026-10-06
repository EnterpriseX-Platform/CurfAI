package com.enterprisex.curf.engine.application.connection;

/** Port: refuses hosts the engine must never connect to (cloud metadata, link-local, unspecified). */
public interface HostPolicy {

    /** @throws com.enterprisex.curf.engine.domain.error.EngineException when the host is not allowed. */
    void verify(String host);
}
