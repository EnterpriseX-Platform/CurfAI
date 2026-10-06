package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/engine/v1/me")
public class MeController {

    public record MeResponse(
            String tenantId,
            String subject,
            String username,
            Set<String> roles,
            Set<String> groups,
            Map<String, Set<String>> attributes,
            Set<String> permissions) {}

    @GetMapping
    MeResponse me(Viewer viewer) {
        Map<String, Set<String>> attributes = new TreeMap<>();
        viewer.attributes().forEach((name, values) -> attributes.put(name, new TreeSet<>(values)));
        Set<String> permissions = new TreeSet<>();
        for (Permission permission : viewer.permissions()) {
            permissions.add(permission.key());
        }
        return new MeResponse(
                viewer.tenantId(), viewer.subject(), viewer.username(),
                new TreeSet<>(viewer.roles()), new TreeSet<>(viewer.groups()), attributes, permissions);
    }
}
