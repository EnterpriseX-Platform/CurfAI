package com.enterprisex.curf.engine.application.view;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.domain.view.View;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Port. Every method is scoped by tenant. Working copies are editable; published snapshots are frozen. */
public interface ViewRepository {

    record VersionInfo(int version, Instant publishedAt, String publishedBy) {}

    void insert(View view);

    Optional<View> find(String tenantId, UUID id);

    /** The frozen copy viewers query, if the view has been published. */
    Optional<View> findPublished(String tenantId, UUID id);

    PageResult<View> list(String tenantId, int page, int size);

    /** Every published snapshot of the tenant (bounded), for building a viewer's catalogue. */
    List<View> listPublished(String tenantId);

    boolean update(View view, int expectedVersion);

    boolean delete(String tenantId, UUID id);

    void publish(String tenantId, UUID id, View snapshot, String by, Instant at);

    boolean unpublish(String tenantId, UUID id);

    List<VersionInfo> versions(String tenantId, UUID id);

    boolean nameTaken(String tenantId, String name, UUID exceptIdOrNull);
}
