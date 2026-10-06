package com.enterprisex.curf.engine.application.schedule;

import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Limits and switches for scheduled delivery.
 *
 * <p>{@code allowedRecipientDomains} fails closed: while it is empty no schedule can name a recipient, so reports cannot
 * be mailed outside the organisation by accident. {@code enabled=false} stops this instance from picking up work
 * (another instance may still); schedules can still be managed.
 */
@ConfigurationProperties(prefix = "curf.engine.schedules")
public record ScheduleProperties(
        Boolean enabled,
        Duration tickInterval,
        Integer maxAttempts,
        Duration retryBackoff,
        Duration lease,
        Duration minInterval,
        List<String> allowedRecipientDomains,
        Integer maxRecipients,
        Long maxAttachmentBytes,
        String mailFrom) {

    public ScheduleProperties {
        enabled = enabled == null || enabled;
        tickInterval = tickInterval == null ? Duration.ofSeconds(30) : tickInterval;
        maxAttempts = maxAttempts == null ? 3 : maxAttempts;
        retryBackoff = retryBackoff == null ? Duration.ofMinutes(2) : retryBackoff;
        lease = lease == null ? Duration.ofMinutes(15) : lease;
        minInterval = minInterval == null ? Duration.ofMinutes(5) : minInterval;
        allowedRecipientDomains = allowedRecipientDomains == null ? List.of() : allowedRecipientDomains.stream().map(String::toLowerCase).toList();
        maxRecipients = maxRecipients == null ? 20 : maxRecipients;
        maxAttachmentBytes = maxAttachmentBytes == null ? 20L * 1024 * 1024 : maxAttachmentBytes;
        mailFrom = mailFrom == null || mailFrom.isBlank() ? "curf-engine@localhost" : mailFrom;
    }
}
