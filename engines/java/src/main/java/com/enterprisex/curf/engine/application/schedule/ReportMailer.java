package com.enterprisex.curf.engine.application.schedule;

import java.util.List;

/** Port. Sends a report file by email, one message per recipient so they do not see each other. */
public interface ReportMailer {

    record Mail(List<String> to, String subject, String text, String attachmentName, String contentType, byte[] attachment) {}

    /** @throws DeliveryException when the message could not be sent */
    void send(Mail mail);

    /** Sending did not work; {@code retriable} says whether trying again later could help (a mail server down) or not (none configured). */
    class DeliveryException extends RuntimeException {

        private final boolean retriable;

        public DeliveryException(String message, boolean retriable, Throwable cause) {
            super(message, cause);
            this.retriable = retriable;
        }

        public boolean retriable() {
            return retriable;
        }
    }
}
