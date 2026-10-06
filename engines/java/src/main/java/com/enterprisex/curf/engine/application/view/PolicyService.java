package com.enterprisex.curf.engine.application.view;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.view.EntitlementRepository.Entitlement;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/** Who holds which values of an attribute, for identity providers that cannot carry them in the token. */
@Service
public class PolicyService {

    public record Entry(String subject, String attribute, Set<String> values) {}

    private static final Pattern ATTRIBUTE = Pattern.compile("[A-Za-z][A-Za-z0-9_]{0,63}");
    private static final int MAX_ENTRIES = 500;
    private static final int MAX_VALUES = 1000;

    private final EntitlementRepository entitlements;
    private final AuditService audit;

    public PolicyService(EntitlementRepository entitlements, AuditService audit) {
        this.entitlements = entitlements;
        this.audit = audit;
    }

    /** All-or-nothing: if any entry is invalid, nothing is changed. */
    public int replace(Viewer viewer, List<Entry> entries) {
        require(viewer);
        List<FieldError> problems = new ArrayList<>();
        if (entries == null || entries.isEmpty() || entries.size() > MAX_ENTRIES) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Send between 1 and " + MAX_ENTRIES + " entries");
        }
        for (int i = 0; i < entries.size(); i++) {
            Entry e = entries.get(i);
            if (e == null || e.subject() == null || e.subject().isBlank() || e.subject().length() > 255) {
                problems.add(new FieldError("entries[" + i + "].subject", "must be 1 to 255 characters"));
            }
            if (e == null || e.attribute() == null || !ATTRIBUTE.matcher(e.attribute()).matches()) {
                problems.add(new FieldError("entries[" + i + "].attribute", "must be a plain attribute name"));
            }
            if (e == null || e.values() == null || e.values().size() > MAX_VALUES
                    || e.values().stream().anyMatch(v -> v == null || v.isBlank() || v.length() > 200)) {
                problems.add(new FieldError("entries[" + i + "].values", "up to " + MAX_VALUES + " values of 1 to 200 characters"));
            }
        }
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", problems);
        }

        Map<String, Integer> counts = new LinkedHashMap<>();
        for (Entry e : entries) {
            entitlements.replace(viewer.tenantId(), e.subject(), e.attribute(), e.values());
            counts.merge(e.attribute(), e.values().size(), Integer::sum);
        }
        // Values are not written to the audit trail; they can identify who may see what.
        audit.record(viewer, "policy.entitlements.replace", "entitlement", null,
                Map.of("entries", entries.size(), "valuesByAttribute", counts));
        return entries.size();
    }

    public PageResult<Entitlement> list(Viewer viewer, String subject, String attribute, int page, int size) {
        require(viewer);
        if (page < 0 || size < 1 || size > 200) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "page must be >= 0 and size between 1 and 200");
        }
        return entitlements.list(viewer.tenantId(), subject, attribute, page, size);
    }

    private static void require(Viewer viewer) {
        if (!viewer.can(Permission.POLICY_MANAGE)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Managing entitlements requires the policy:manage permission");
        }
    }
}
