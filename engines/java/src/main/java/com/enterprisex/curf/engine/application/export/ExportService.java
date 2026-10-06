package com.enterprisex.curf.engine.application.export;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.export.ExportModel.Document;
import com.enterprisex.curf.engine.application.export.ExportModel.Options;
import com.enterprisex.curf.engine.application.export.ExportModel.Section;
import com.enterprisex.curf.engine.application.report.Report;
import com.enterprisex.curf.engine.application.report.ReportRunService;
import com.enterprisex.curf.engine.application.report.ReportService;
import com.enterprisex.curf.engine.application.report.RunResult;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.export.CellFormats;
import com.enterprisex.curf.engine.domain.export.ExportFormat;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.EnumMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

/**
 * Exports a report as a file. It runs the report as the person asking, so they get exactly what they could see on
 * screen (their rows, their masks), refuses a result that was cut short rather than writing a file that looks
 * complete, renders it, and keeps the file with its SHA-256 for a limited time. Only the creator can fetch it.
 */
@Service
public class ExportService {

    private static final Logger LOG = LoggerFactory.getLogger(ExportService.class);

    /** A stored file and its bytes. */
    public record File(Export export, byte[] content) {}

    private final ReportRunService runs;
    private final ExportRepository exports;
    private final AuditService audit;
    private final ExportProperties props;
    private final Clock clock;
    private final Map<ExportFormat, FileRenderer> renderers = new EnumMap<>(ExportFormat.class);

    public ExportService(
            ReportRunService runs, ExportRepository exports, AuditService audit,
            ExportProperties props, Clock clock, List<FileRenderer> fileRenderers) {
        this.runs = runs;
        this.exports = exports;
        this.audit = audit;
        this.props = props;
        this.clock = clock;
        fileRenderers.forEach(r -> renderers.put(r.format(), r));
    }

    public Export create(Viewer viewer, UUID reportId, ExportRequest request) {
        if (request.format() == null) {
            throw invalid("format", "is required (csv, xlsx, docx or pdf)");
        }
        String locale = locale(request.locale());
        ReportRunService.Resolved resolved = runs.resolve(viewer, reportId);
        Report report = resolved.report();
        FileRenderer renderer = renderers.get(request.format());
        if (renderer == null) {
            throw new EngineException(ErrorCode.CURF_EXPORT_UNAVAILABLE, request.format() + " export is not available");
        }

        RunResult run = runs.execute(viewer, resolved, request.params(), props.maxRows());
        run.provenance().forEach((queryId, p) -> {
            if (Boolean.TRUE.equals(p.truncated())) {
                throw new EngineException(ErrorCode.CURF_ROW_LIMIT, "Query '" + p.queryName() + "' has more than "
                        + props.maxRows() + " rows; narrow it with parameters or summarise it before exporting");
            }
        });

        Document doc = ExportSections.build(report.name(), resolved.definition(), run, locale, style(resolved.definition(), locale, request),
                currency(resolved.definition(), request));
        if (request.format() == ExportFormat.CSV) {
            requireCsvSection(doc, request.blockId());
        }

        byte[] bytes = renderer.render(doc, new Options(request.blockId(), props.font()));
        if (bytes.length > props.maxBytes()) {
            throw new EngineException(ErrorCode.CURF_ROW_LIMIT, "The file would be larger than " + props.maxBytes() / (1024 * 1024) + " MB");
        }

        Instant now = clock.instant();
        Export export = new Export(UUID.randomUUID(), viewer.tenantId(), reportId, report.name(), request.format(),
                fileName(report.name(), request.format(), now), bytes.length, sha256(bytes), run.asOf(), now, viewer.subject(),
                now.plus(props.retention()));
        exports.insert(export, bytes);
        audit.record(viewer, "report.export", "export", export.id().toString(), Map.of(
                "reportId", reportId.toString(), "format", request.format().name(), "bytes", bytes.length, "sha256", export.sha256(),
                "rows", doc.sections().stream().mapToInt(s -> s.rows().size()).sum()));
        return export;
    }

    public Export get(Viewer viewer, UUID id) {
        return exports.find(viewer.tenantId(), id)
                .filter(e -> e.createdBy().equals(viewer.subject()))
                .filter(e -> e.expiresAt().isAfter(clock.instant()))
                .orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such export"));
    }

    public File file(Viewer viewer, UUID id) {
        Export export = get(viewer, id);
        byte[] content = exports.content(viewer.tenantId(), id).orElseThrow(() -> new EngineException(ErrorCode.CURF_NOT_FOUND, "No such export"));
        return new File(export, content);
    }

    public PageResult<Export> list(Viewer viewer, int page, int size) {
        if (page < 0 || size < 1 || size > 200) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "page must be >= 0 and size between 1 and 200");
        }
        return exports.listByCreator(viewer.tenantId(), viewer.subject(), page, size);
    }

    public void delete(Viewer viewer, UUID id) {
        get(viewer, id);
        exports.delete(viewer.tenantId(), id);
        audit.record(viewer, "report.export.delete", "export", id.toString(), Map.of());
    }

    /** Removes expired files; safe to run from every replica at once. */
    public int purgeExpired() {
        int removed = exports.purgeExpired(clock.instant());
        if (removed > 0) {
            LOG.info("Removed {} expired exports", removed);
        }
        return removed;
    }

    // ------------------------------------------------------------------ choices

    private String locale(String requested) {
        String locale = requested == null || requested.isBlank() ? props.defaultLocale() : requested.toLowerCase(java.util.Locale.ROOT);
        if (!locale.equals("th") && !locale.equals("en")) {
            throw invalid("locale", "must be th or en");
        }
        return locale;
    }

    /** The report's own date era wins; otherwise the request; otherwise Thai readers get Buddhist-era years. */
    private static CellFormats.Style style(JsonNode definition, String locale, ExportRequest request) {
        String era = definition.path("dateEra").asString("");
        boolean buddhist = switch (era) {
            case "be" -> true;
            case "ce" -> false;
            default -> request.calendar() != null ? request.calendar() == ExportRequest.Calendar.BUDDHIST : locale.equals("th");
        };
        return new CellFormats.Style(locale, buddhist);
    }

    private String currency(JsonNode definition, ExportRequest request) {
        String fixed = definition.path("currency").asString("");
        String chosen = !fixed.isBlank() ? fixed : request.currency() != null && !request.currency().isBlank() ? request.currency() : props.defaultCurrency();
        if (!chosen.matches("[A-Za-z]{3}")) {
            throw invalid("currency", "must be a three-letter currency code");
        }
        return chosen.toUpperCase(java.util.Locale.ROOT);
    }

    /**
     * A CSV holds one table block (not just any query's data), as in Curf's own export. It refuses when that table's data
     * did not load, rather than write an empty file.
     */
    private static void requireCsvSection(Document doc, String blockId) {
        Section section = doc.sections().stream()
                .filter(s -> !s.blockId().isEmpty())
                .filter(s -> blockId == null || blockId.equals(s.blockId()))
                .findFirst().orElse(null);
        if (section == null) {
            throw invalid("blockId", blockId == null ? "this report has no table to export as CSV" : "is not a table in this report");
        }
        if (section.unavailable() != null) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT,
                    "This table's data didn't load, so there is nothing to export: " + section.unavailable());
        }
    }

    // ------------------------------------------------------------------ names and hashes

    static String fileName(String reportName, ExportFormat format, Instant at) {
        String base = reportName.replaceAll("[^\\p{L}\\p{M}\\p{N} _.-]", "_").strip();
        if (base.isEmpty()) {
            base = "report";
        }
        if (base.length() > 80) {
            base = base.substring(0, 80);
        }
        return base + "-" + at.atZone(ZoneOffset.UTC).toLocalDate() + "." + format.extension();
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }
}
