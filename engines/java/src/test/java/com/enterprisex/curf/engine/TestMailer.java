package com.enterprisex.curf.engine;

import com.enterprisex.curf.engine.application.schedule.ReportMailer;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** Replaces SMTP in tests: remembers what would have been sent, and fails on demand for a given recipient. */
@TestConfiguration
public class TestMailer {

    public static class Recording implements ReportMailer {

        private final List<Mail> sent = new CopyOnWriteArrayList<>();
        private final Map<String, Failure> failures = new ConcurrentHashMap<>();

        private record Failure(int times, boolean retriable) {}

        /** The next {@code times} messages to {@code recipient} fail. */
        public void failFor(String recipient, int times, boolean retriable) {
            failures.put(recipient, new Failure(times, retriable));
        }

        public List<Mail> sentTo(String recipient) {
            return sent.stream().filter(m -> m.to().contains(recipient)).toList();
        }

        @Override
        public void send(Mail mail) {
            for (String to : mail.to()) {
                Failure failure = failures.get(to);
                if (failure != null && failure.times() > 0) {
                    failures.put(to, new Failure(failure.times() - 1, failure.retriable()));
                    throw new DeliveryException("the mail server refused the message", failure.retriable(), null);
                }
            }
            sent.add(mail);
        }
    }

    @Bean
    @Primary
    Recording recordingMailer() {
        return new Recording();
    }
}
