package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.export.Export;
import com.enterprisex.curf.engine.application.export.ExportRequest;
import com.enterprisex.curf.engine.application.export.ExportService;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/engine/v1")
public class ExportController {

    /** Anything omitted takes the engine's default, or the report's own setting where it fixes one. */
    public record ExportBody(
            ExportFormat format, Map<String, Object> params, String locale, ExportRequest.Calendar calendar, String currency,
            String blockId) {

        ExportRequest toRequest() {
            return new ExportRequest(format, params, locale, calendar, currency, blockId);
        }
    }

    public record ExportInfo(
            UUID id, UUID reportId, String reportName, ExportFormat format, String fileName, long sizeBytes, String sha256, String asOf,
            Instant createdAt, Instant expiresAt, String downloadUrl) {

        static ExportInfo of(Export e) {
            return new ExportInfo(e.id(), e.reportId(), e.reportName(), e.format(), e.fileName(), e.sizeBytes(), e.sha256(), e.asOf(),
                    e.createdAt(), e.expiresAt(), "/engine/v1/exports/" + e.id() + "/file");
        }
    }

    private final ExportService service;

    public ExportController(ExportService service) {
        this.service = service;
    }

    @PostMapping("/reports/{id}/exports")
    @ResponseStatus(HttpStatus.CREATED)
    ExportInfo create(Viewer viewer, @PathVariable UUID id, @RequestBody ExportBody body) {
        return ExportInfo.of(service.create(viewer, id, body.toRequest()));
    }

    @GetMapping("/exports")
    PageResult<ExportInfo> list(Viewer viewer, @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "50") int size) {
        PageResult<Export> result = service.list(viewer, page, size);
        return new PageResult<>(result.content().stream().map(ExportInfo::of).toList(), result.page(), result.size(), result.totalElements());
    }

    @GetMapping("/exports/{id}")
    ExportInfo get(Viewer viewer, @PathVariable UUID id) {
        return ExportInfo.of(service.get(viewer, id));
    }

    @GetMapping("/exports/{id}/file")
    ResponseEntity<byte[]> file(Viewer viewer, @PathVariable UUID id) {
        ExportService.File file = service.file(viewer, id);
        Export e = file.export();
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(e.format().contentType()))
                .contentLength(e.sizeBytes())
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition(e.fileName()))
                .header("X-Content-SHA256", e.sha256())
                .header("X-Curf-As-Of", e.asOf())
                .cacheControl(CacheControl.noStore())
                .body(file.content());
    }

    @DeleteMapping("/exports/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void delete(Viewer viewer, @PathVariable UUID id) {
        service.delete(viewer, id);
    }

    /** RFC 6266: a plain ASCII fallback plus the real (possibly Thai) name percent-encoded as UTF-8. */
    static String disposition(String fileName) {
        String ascii = fileName.replaceAll("[^A-Za-z0-9._ -]", "_");
        String encoded = URLEncoder.encode(fileName, StandardCharsets.UTF_8).replace("+", "%20");
        return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encoded;
    }
}
