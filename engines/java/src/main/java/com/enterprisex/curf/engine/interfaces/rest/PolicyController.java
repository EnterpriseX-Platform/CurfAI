package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.view.EntitlementRepository.Entitlement;
import com.enterprisex.curf.engine.application.view.PolicyService;
import com.enterprisex.curf.engine.application.view.PolicyService.Entry;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/engine/v1/policies/entitlements")
public class PolicyController {

    public record ReplaceRequest(List<Entry> entries) {}

    private final PolicyService service;

    public PolicyController(PolicyService service) {
        this.service = service;
    }

    /** Replaces, per subject and attribute, the set of values held. An empty list removes the entry. */
    @PutMapping
    Map<String, Integer> replace(Viewer viewer, @RequestBody ReplaceRequest body) {
        return Map.of("updated", service.replace(viewer, body.entries()));
    }

    @GetMapping
    PageResult<Entitlement> list(
            Viewer viewer,
            @RequestParam(required = false) String subject,
            @RequestParam(required = false) String attribute,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size) {
        return service.list(viewer, subject, attribute, page, size);
    }
}
