package com.enterprisex.curf.engine.application.view;

import com.enterprisex.curf.engine.application.common.PageResult;
import java.util.Set;

/** Port: which values of an attribute (for example agency codes) a person holds, kept by the engine. */
public interface EntitlementRepository {

    record Entitlement(String subject, String attribute, String value) {}

    Set<String> values(String tenantId, String subject, String attribute);

    /** Replaces everything held for this subject and attribute. An empty set removes it. */
    void replace(String tenantId, String subject, String attribute, Set<String> values);

    PageResult<Entitlement> list(String tenantId, String subjectOrNull, String attributeOrNull, int page, int size);
}
