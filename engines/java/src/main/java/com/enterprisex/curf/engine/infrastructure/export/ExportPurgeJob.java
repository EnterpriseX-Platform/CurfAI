package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.export.ExportService;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Deletes files past their retention. Every replica may run it; deleting twice is harmless. */
@Component
public class ExportPurgeJob {

    private final ExportService exports;

    public ExportPurgeJob(ExportService exports) {
        this.exports = exports;
    }

    @Scheduled(fixedDelayString = "PT1H", initialDelayString = "PT5M")
    void purge() {
        exports.purgeExpired();
    }
}
