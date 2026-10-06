package com.enterprisex.curf.engine.infrastructure.schedule;

import com.enterprisex.curf.engine.application.schedule.ReportMailer;
import com.enterprisex.curf.engine.application.schedule.ScheduleProperties;
import jakarta.mail.internet.MimeMessage;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.mail.MailException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Component;

/**
 * Sends through the SMTP server named in {@code spring.mail.*}. Without one, sending fails and is not retried: waiting
 * does not install a mail server. A failure talking to a configured server is retried.
 */
@Component
public class SmtpReportMailer implements ReportMailer {

    private final ObjectProvider<JavaMailSender> sender;
    private final ScheduleProperties props;

    public SmtpReportMailer(ObjectProvider<JavaMailSender> sender, ScheduleProperties props) {
        this.sender = sender;
        this.props = props;
    }

    @Override
    public void send(Mail mail) {
        JavaMailSender mailSender = sender.getIfAvailable();
        if (mailSender == null) {
            throw new DeliveryException("No mail server is configured (spring.mail.host)", false, null);
        }
        try {
            for (String to : mail.to()) {
                MimeMessage message = mailSender.createMimeMessage();
                MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
                helper.setFrom(props.mailFrom());
                helper.setTo(to);
                helper.setSubject(mail.subject());
                helper.setText(mail.text(), false);
                helper.addAttachment(mail.attachmentName(), new ByteArrayResource(mail.attachment()), mail.contentType());
                mailSender.send(message);
            }
        } catch (MailException | jakarta.mail.MessagingException e) {
            throw new DeliveryException("The mail server did not accept the message", true, e);
        }
    }
}
