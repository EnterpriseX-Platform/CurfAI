package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.sharing.PublicLink;
import com.enterprisex.curf.engine.application.sharing.PublicLink.Kind;
import com.enterprisex.curf.engine.application.sharing.PublicLinkService;
import com.enterprisex.curf.engine.application.sharing.PublishRequest;
import com.enterprisex.curf.engine.application.sharing.PublishRequest.State;
import com.enterprisex.curf.engine.application.sharing.PublishService;
import com.enterprisex.curf.engine.application.sharing.ShareService;
import com.enterprisex.curf.engine.domain.report.ReportShare;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Shares, publish requests and public links: who may see a report, and how it reaches them. */
@RestController
@RequestMapping("/engine/v1")
public class SharingController {

    public record SharesBody(List<ReportShare> shares) {}

    public record NoteBody(String note) {}

    public record ReasonBody(String reason) {}

    /** {@code expiresInSeconds} is optional (the default for the kind applies); {@code params} fixes parameters whatever the caller sends. */
    public record LinkBody(Long expiresInSeconds, Map<String, Object> params) {}

    public record LinkInfo(
            UUID id, UUID reportId, Kind kind, Instant createdAt, String createdBy, Instant expiresAt, Instant revokedAt, String revokedBy,
            Map<String, Object> params) {

        static LinkInfo of(PublicLink l) {
            return new LinkInfo(l.id(), l.reportId(), l.kind(), l.createdAt(), l.createdBy(), l.expiresAt(), l.revokedAt(), l.revokedBy(),
                    l.lockedParams());
        }
    }

    /** The secret in {@code token} is shown only here. Keep it: it cannot be shown again. */
    public record LinkCreated(LinkInfo link, String token, String url) {}

    private final ShareService shares;
    private final PublishService publishing;
    private final PublicLinkService links;

    public SharingController(ShareService shares, PublishService publishing, PublicLinkService links) {
        this.shares = shares;
        this.publishing = publishing;
        this.links = links;
    }

    // ------------------------------------------------------------------ shares

    @GetMapping("/reports/{id}/shares")
    SharesBody shares(Viewer viewer, @PathVariable UUID id) {
        return new SharesBody(shares.list(viewer, id));
    }

    @PutMapping("/reports/{id}/shares")
    SharesBody replaceShares(Viewer viewer, @PathVariable UUID id, @RequestBody SharesBody body) {
        return new SharesBody(shares.replace(viewer, id, body.shares()));
    }

    // ------------------------------------------------------------------ publishing

    @PostMapping("/reports/{id}/publish-requests")
    @ResponseStatus(HttpStatus.CREATED)
    PublishRequest request(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) NoteBody body) {
        return publishing.request(viewer, id, body == null ? null : body.note());
    }

    @GetMapping("/reports/{id}/publish-requests")
    List<PublishRequest> requestsFor(Viewer viewer, @PathVariable UUID id) {
        return publishing.forReport(viewer, id);
    }

    @GetMapping("/publish-requests")
    PageResult<PublishRequest> requests(
            Viewer viewer, @RequestParam(required = false) State state, @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size) {
        return publishing.byState(viewer, state, page, size);
    }

    @GetMapping("/publish-requests/{id}")
    PublishRequest request(Viewer viewer, @PathVariable UUID id) {
        return publishing.get(viewer, id);
    }

    @PostMapping("/publish-requests/{id}/approve")
    PublishRequest approve(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) NoteBody body) {
        return publishing.approve(viewer, id, body == null ? null : body.note());
    }

    @PostMapping("/publish-requests/{id}/reject")
    PublishRequest reject(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) NoteBody body) {
        return publishing.reject(viewer, id, body == null ? null : body.note());
    }

    @PostMapping("/publish-requests/{id}/cancel")
    PublishRequest cancel(Viewer viewer, @PathVariable UUID id) {
        return publishing.cancel(viewer, id);
    }

    @PostMapping("/reports/{id}/unpublish")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void unpublish(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) ReasonBody body) {
        publishing.unpublish(viewer, id, body == null ? null : body.reason());
    }

    // ------------------------------------------------------------------ public links and embed tokens

    @PostMapping("/reports/{id}/public-links")
    @ResponseStatus(HttpStatus.CREATED)
    LinkCreated createLink(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) LinkBody body) {
        return created(links.create(viewer, id, Kind.PUBLIC, ttl(body), body == null ? null : body.params()));
    }

    @PostMapping("/reports/{id}/embed-tokens")
    @ResponseStatus(HttpStatus.CREATED)
    LinkCreated createEmbed(Viewer viewer, @PathVariable UUID id, @RequestBody(required = false) LinkBody body) {
        return created(links.create(viewer, id, Kind.EMBED, ttl(body), body == null ? null : body.params()));
    }

    @GetMapping("/reports/{id}/public-links")
    List<LinkInfo> listLinks(Viewer viewer, @PathVariable UUID id) {
        return links.list(viewer, id).stream().map(LinkInfo::of).toList();
    }

    @DeleteMapping("/public-links/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void revoke(Viewer viewer, @PathVariable UUID id) {
        links.revoke(viewer, id);
    }

    private static Duration ttl(LinkBody body) {
        return body == null || body.expiresInSeconds() == null ? null : Duration.ofSeconds(body.expiresInSeconds());
    }

    private static LinkCreated created(PublicLinkService.Created c) {
        return new LinkCreated(LinkInfo.of(c.link()), c.token(), "/engine/v1/public/" + c.token());
    }
}
