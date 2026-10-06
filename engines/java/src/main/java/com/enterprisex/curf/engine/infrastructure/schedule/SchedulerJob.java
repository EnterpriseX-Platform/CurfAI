package com.enterprisex.curf.engine.infrastructure.schedule;

import com.enterprisex.curf.engine.application.schedule.SchedulerService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/** Calls the scheduler on a timer. Switch off with {@code curf.engine.schedules.enabled=false} to leave the work to other instances. */
@Component
@ConditionalOnProperty(prefix = "curf.engine.schedules", name = "enabled", havingValue = "true", matchIfMissing = true)
public class SchedulerJob {

    private static final Logger LOG = LoggerFactory.getLogger(SchedulerJob.class);

    private final SchedulerService scheduler;

    public SchedulerJob(SchedulerService scheduler) {
        this.scheduler = scheduler;
    }

    @Scheduled(fixedDelayString = "${curf.engine.schedules.tick-interval:PT30S}", initialDelayString = "PT10S")
    void tick() {
        try {
            scheduler.tick();
        } catch (RuntimeException e) {
            LOG.error("Scheduler pass failed", e);
        }
    }
}
