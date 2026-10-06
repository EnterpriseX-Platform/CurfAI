package com.enterprisex.curf.engine.application.view;

import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * A viewer's values for an attribute: from the access token when it carries the claim, otherwise from
 * the engine's entitlement table. (Many identity providers cannot supply custom attributes, so the table
 * is the dependable source.)
 */
@Component
public class AttributeResolver {

    private final EntitlementRepository entitlements;

    public AttributeResolver(EntitlementRepository entitlements) {
        this.entitlements = entitlements;
    }

    public Set<String> values(Viewer viewer, String attribute) {
        Set<String> fromToken = viewer.attribute(attribute);
        if (!fromToken.isEmpty()) {
            return fromToken;
        }
        return entitlements.values(viewer.tenantId(), viewer.subject(), attribute);
    }
}
