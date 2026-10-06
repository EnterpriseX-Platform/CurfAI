package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.application.common.PageResult;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/** Port. Every method is scoped by tenant; listing and reading are further scoped to the creator by the caller. */
public interface ExportRepository {

    void insert(Export export, byte[] content);

    Optional<Export> find(String tenantId, UUID id);

    Optional<byte[]> content(String tenantId, UUID id);

    PageResult<Export> listByCreator(String tenantId, String creator, int page, int size);

    boolean delete(String tenantId, UUID id);

    /** Removes everything that expired before {@code now}; returns how many files went. */
    int purgeExpired(Instant now);
}
