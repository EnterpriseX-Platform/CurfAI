package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.application.schedule.Schedule;
import com.enterprisex.curf.engine.application.schedule.ScheduleRun;
import com.enterprisex.curf.engine.application.schedule.ScheduleService;
import com.enterprisex.curf.engine.application.schedule.ScheduleService.Draft;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
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
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/engine/v1/schedules")
public class ScheduleController {

    /** {@code reportId} is fixed once created; a change to it in an update is ignored. */
    public record ScheduleRequest(
            UUID reportId, String name, String cron, String timezone, ExportFormat format, String locale, Map<String, Object> params,
            List<String> recipients, Boolean enabled) {

        Draft toDraft() {
            return new Draft(reportId, name, cron, timezone, format, locale, params, recipients, enabled);
        }
    }

    public record ScheduleResponse(
            UUID id, UUID reportId, String name, String cron, String timezone, ExportFormat format, String locale, Map<String, Object> params,
            List<String> recipients, String runAs, boolean enabled, Instant nextRunAt, Instant createdAt, String createdBy, Instant updatedAt,
            String updatedBy) {

        static ScheduleResponse of(Schedule s) {
            return new ScheduleResponse(s.id(), s.reportId(), s.name(), s.cron(), s.timezone(), s.format(), s.locale(), s.params(), s.recipients(),
                    s.runAs().subject(), s.enabled(), s.nextRunAt(), s.createdAt(), s.createdBy(), s.updatedAt(), s.updatedBy());
        }
    }

    private final ScheduleService service;

    public ScheduleController(ScheduleService service) {
        this.service = service;
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    ScheduleResponse create(Viewer viewer, @RequestBody ScheduleRequest body) {
        return ScheduleResponse.of(service.create(viewer, body.toDraft()));
    }

    @GetMapping
    List<ScheduleResponse> list(Viewer viewer) {
        return service.list(viewer).stream().map(ScheduleResponse::of).toList();
    }

    @GetMapping("/{id}")
    ScheduleResponse get(Viewer viewer, @PathVariable UUID id) {
        return ScheduleResponse.of(service.get(viewer, id));
    }

    @PutMapping("/{id}")
    ScheduleResponse update(Viewer viewer, @PathVariable UUID id, @RequestBody ScheduleRequest body) {
        return ScheduleResponse.of(service.update(viewer, id, body.toDraft()));
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void delete(Viewer viewer, @PathVariable UUID id) {
        service.delete(viewer, id);
    }

    @GetMapping("/{id}/runs")
    List<ScheduleRun> runs(Viewer viewer, @PathVariable UUID id) {
        return service.runs(viewer, id);
    }
}
