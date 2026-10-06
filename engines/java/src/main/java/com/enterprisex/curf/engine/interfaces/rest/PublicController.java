package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.report.ReportService.RunnableView;
import com.enterprisex.curf.engine.application.report.RunResult;
import com.enterprisex.curf.engine.application.sharing.PublicLinkService;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The only endpoints that need no sign-in: the secret in the path is the credential. Nothing here is cached, and every
 * failure (unknown, expired, revoked, unpublished) answers with the same 404.
 */
@RestController
@RequestMapping("/engine/v1/public")
public class PublicController {

    public record PublicRunRequest(Map<String, Object> params) {}

    private final PublicLinkService links;

    public PublicController(PublicLinkService links) {
        this.links = links;
    }

    @GetMapping("/{token}")
    ResponseEntity<RunnableView> open(@PathVariable String token) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(links.open(token));
    }

    @PostMapping("/{token}/run")
    ResponseEntity<RunResult> run(@PathVariable String token, @RequestBody(required = false) PublicRunRequest body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(links.run(token, body == null ? null : body.params()));
    }
}
