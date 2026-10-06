package com.enterprisex.curf.engine.infrastructure.export;

import com.enterprisex.curf.engine.application.export.ExportProperties;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Prints HTML to PDF through a Gotenberg sidecar (headless Chromium behind a small HTTP API). The engine sends it
 * a page it built itself, with everything inline; run the sidecar with no route out of the cluster.
 */
@Component
public class GotenbergClient {

    private static final Logger LOG = LoggerFactory.getLogger(GotenbergClient.class);

    private final ExportProperties props;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public GotenbergClient(ExportProperties props) {
        this.props = props;
    }

    public boolean configured() {
        return !props.gotenbergUrl().isBlank();
    }

    public byte[] print(String html, String footerHtml, boolean landscape) {
        if (!configured()) {
            throw new EngineException(ErrorCode.CURF_EXPORT_UNAVAILABLE,
                    "PDF export needs a Chromium sidecar; set curf.engine.exports.gotenberg-url");
        }
        String boundary = "curf-" + UUID.randomUUID();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        file(body, boundary, "index.html", html);
        file(body, boundary, "footer.html", footerHtml);
        // A4, in inches as Gotenberg takes them; margins leave room for the page footer.
        field(body, boundary, "paperWidth", landscape ? "11.69" : "8.27");
        field(body, boundary, "paperHeight", landscape ? "8.27" : "11.69");
        field(body, boundary, "marginTop", "0.6");
        field(body, boundary, "marginBottom", "0.8");
        field(body, boundary, "marginLeft", "0.45");
        field(body, boundary, "marginRight", "0.45");
        field(body, boundary, "printBackground", "true");
        field(body, boundary, "emulatedMediaType", "print");
        body.writeBytes(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

        HttpRequest request = HttpRequest.newBuilder(URI.create(props.gotenbergUrl() + "/forms/chromium/convert/html"))
                .timeout(props.pdfTimeout())
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray()))
                .build();
        try {
            HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() != 200) {
                LOG.error("PDF service answered {}: {}", response.statusCode(), new String(response.body(), StandardCharsets.UTF_8));
                throw new EngineException(ErrorCode.CURF_EXPORT_UNAVAILABLE, "The PDF service could not render the report");
            }
            return response.body();
        } catch (IOException e) {
            LOG.error("PDF service unreachable", e);
            throw new EngineException(ErrorCode.CURF_EXPORT_UNAVAILABLE, "The PDF service is not reachable");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new EngineException(ErrorCode.CURF_EXPORT_UNAVAILABLE, "The PDF export was interrupted");
        }
    }

    private static void file(ByteArrayOutputStream out, String boundary, String name, String content) {
        out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"" + name
                + "\"\r\nContent-Type: text/html; charset=utf-8\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.writeBytes(content.getBytes(StandardCharsets.UTF_8));
        out.writeBytes("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private static void field(ByteArrayOutputStream out, String boundary, String name, String value) {
        out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n")
                .getBytes(StandardCharsets.UTF_8));
    }
}
