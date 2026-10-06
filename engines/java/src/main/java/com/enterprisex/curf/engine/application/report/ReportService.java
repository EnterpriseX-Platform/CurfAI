package com.enterprisex.curf.engine.application.report;

import com.enterprisex.curf.engine.application.audit.AuditService;
import com.enterprisex.curf.engine.application.common.PageResult;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.Parsed;
import com.enterprisex.curf.engine.application.report.ReportDefinitions.QueryDef;
import com.enterprisex.curf.engine.application.report.ReportRepository.VersionInfo;
import com.enterprisex.curf.engine.application.sharing.ReportAccessService;
import com.enterprisex.curf.engine.application.view.ViewRepository;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.report.ReportAccess.Level;
import com.enterprisex.curf.engine.domain.viewer.Permission;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Stores reports in Curf's own format with a numbered version for every save, and restores old versions.
 * People who may run a report (but not edit it) get the definition with the queries reduced to their ids and
 * names, so SQL and view bindings are not handed out.
 */
@Service
public class ReportService {

    /** What a person who can only run reports sees in a list. */
    public record Runnable(UUID id, String name, int version) {}

    private static final Pattern ROLE = Pattern.compile("[A-Za-z0-9_.:-]{1,100}");
    private static final int MAX_DEFINITION_CHARS = 5_000_000;
    private static final int MAX_NOTE = 500;

    private final ReportRepository reports;
    private final ViewRepository views;
    private final ReportAccessService access;
    private final ReportDefinitions definitions;
    private final AuditService audit;
    private final JsonMapper json;
    private final Clock clock;

    public ReportService(
            ReportRepository reports, ViewRepository views, ReportAccessService access, ReportDefinitions definitions, AuditService audit, JsonMapper json,
            Clock clock) {
        this.reports = reports;
        this.views = views;
        this.access = access;
        this.definitions = definitions;
        this.audit = audit;
        this.json = json;
        this.clock = clock;
    }

    public Report create(Viewer viewer, JsonNode definition, Set<String> runRoles, String note) {
        requireEdit(viewer);
        Parsed parsed = check(viewer, definition);
        Set<String> roles = roles(runRoles);
        if (reports.nameTaken(viewer.tenantId(), parsed.name(), null)) {
            throw invalid("definition.name", "A report with this name already exists");
        }
        Instant now = clock.instant();
        Report report = new Report(UUID.randomUUID(), viewer.tenantId(), parsed.name(), definition, roles, 1, null, now,
                viewer.subject(), now, viewer.subject());
        reports.insert(report, note(note));
        audit.record(viewer, "report.create", "report", report.id().toString(), details(report));
        return report;
    }

    public Report update(Viewer viewer, UUID id, JsonNode definition, Set<String> runRoles, int expectedVersion, String note) {
        Report old = editable(viewer, id);
        return save(viewer, old, definition, runRoles, expectedVersion, note, "report.update");
    }

    /** Makes an old version the newest one; history is never rewritten. */
    public Report restore(Viewer viewer, UUID id, int versionNo) {
        Report current = editable(viewer, id);
        JsonNode old = reports.versionDefinition(viewer.tenantId(), id, versionNo).orElseThrow(ReportService::notFound);
        return save(viewer, current, old, current.runRoles(), current.version(), "Restored from version " + versionNo, "report.restore");
    }

    private Report save(Viewer viewer, Report old, JsonNode definition, Set<String> runRoles, int expectedVersion, String note, String action) {
        Parsed parsed = check(viewer, definition);
        Set<String> roles = roles(runRoles);
        if (reports.nameTaken(viewer.tenantId(), parsed.name(), old.id())) {
            throw invalid("definition.name", "A report with this name already exists");
        }
        Report changed = new Report(old.id(), old.tenantId(), parsed.name(), definition, roles, old.version() + 1, old.publishedVersion(), old.createdAt(),
                old.createdBy(), clock.instant(), viewer.subject());
        if (!reports.update(changed, expectedVersion, note(note))) {
            throw new EngineException(ErrorCode.CURF_STALE_VERSION, "The report was changed by someone else; reload it and try again");
        }
        audit.record(viewer, action, "report", old.id().toString(), details(changed));
        return changed;
    }

    public void delete(Viewer viewer, UUID id) {
        requireEdit(viewer);
        if (!reports.delete(viewer.tenantId(), id)) {
            throw notFound();
        }
        audit.record(viewer, "report.delete", "report", id.toString(), Map.of());
    }

    public Report get(Viewer viewer, UUID id) {
        return editable(viewer, id);
    }

    /** What the person may do with this report; 404 when nothing. */
    public Level level(Viewer viewer, UUID id) {
        Report report = reports.find(viewer.tenantId(), id).orElseThrow(ReportService::notFound);
        Level level = access.level(viewer, report);
        if (level == Level.NONE) {
            throw notFound();
        }
        return level;
    }

    private Report editable(Viewer viewer, UUID id) {
        Report report = reports.find(viewer.tenantId(), id).orElseThrow(ReportService::notFound);
        if (access.require(viewer, report, Level.VIEW) != Level.EDIT) {
            // They may run it, so they know it exists; saying so is honest, and hides nothing.
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Changing this report requires edit access to it");
        }
        return report;
    }

    public PageResult<Report> list(Viewer viewer, int page, int size) {
        requireEdit(viewer);
        if (page < 0 || size < 1 || size > 200) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "page must be >= 0 and size between 1 and 200");
        }
        return reports.list(viewer.tenantId(), page, size);
    }

    public List<VersionInfo> versions(Viewer viewer, UUID id) {
        editable(viewer, id);
        return reports.versions(viewer.tenantId(), id);
    }

    public JsonNode version(Viewer viewer, UUID id, int version) {
        editable(viewer, id);
        return reports.versionDefinition(viewer.tenantId(), id, version).orElseThrow(ReportService::notFound);
    }

    // ------------------------------------------------------------------ for people who only run reports

    /** The reports the person may run: editors see them all, everyone else only those with a published version. */
    public List<Runnable> runnable(Viewer viewer) {
        List<Report> all = reports.listAll(viewer.tenantId());
        Map<UUID, Level> levels = access.levels(viewer, all);
        return all.stream()
                .filter(r -> levels.get(r.id()) == Level.EDIT || (levels.get(r.id()) == Level.VIEW && r.publishedVersion() != null))
                .map(r -> new Runnable(r.id(), r.name(), levels.get(r.id()) == Level.EDIT ? r.version() : r.publishedVersion()))
                .toList();
    }

    /** A report as someone who can only run it sees it. */
    public record RunnableView(UUID id, String name, int version, JsonNode definition) {}

    /** The definition for rendering: blocks and parameters as they are, queries reduced to id and name; the published version. */
    public RunnableView forRunner(Viewer viewer, UUID id) {
        Report report = reports.find(viewer.tenantId(), id).orElseThrow(ReportService::notFound);
        Level level = access.require(viewer, report, Level.VIEW);
        Integer published = report.publishedVersion();
        if (level != Level.EDIT && published == null) {
            throw notFound();
        }
        int version = level == Level.EDIT ? report.version() : published;
        JsonNode source = version == report.version() ? report.definition()
                : reports.versionDefinition(viewer.tenantId(), id, version).orElseThrow(ReportService::notFound);
        return reduce(report, version, source);
    }

    /** The report's blocks and parameters with every query reduced to its id and name, so SQL and view bindings stay private. */
    public RunnableView reduce(Report report, int version, JsonNode source) {
        ObjectNode copy = (ObjectNode) source.deepCopy();
        ArrayNode queries = json.createArrayNode();
        for (JsonNode q : source.path("dataSources")) {
            ObjectNode reduced = json.createObjectNode();
            reduced.set("id", q.path("id"));
            reduced.set("name", q.path("name"));
            queries.add(reduced);
        }
        copy.set("dataSources", queries);
        return new RunnableView(report.id(), report.name(), version, copy);
    }

    // ------------------------------------------------------------------ checks

    private Parsed check(Viewer viewer, JsonNode definition) {
        if (definition != null && json.writeValueAsString(definition).length() > MAX_DEFINITION_CHARS) {
            throw invalid("definition", "is larger than " + MAX_DEFINITION_CHARS + " characters");
        }
        Parsed parsed = definitions.parse(definition);
        List<FieldError> problems = new ArrayList<>();
        for (QueryDef q : parsed.queries()) {
            if (q.engine() != null && views.find(viewer.tenantId(), q.engine().viewId()).isEmpty()) {
                problems.add(new FieldError("definition.dataSources." + q.id() + ".engine.viewId", "is not a view in this workspace"));
            }
        }
        if (!problems.isEmpty()) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "The report definition is not valid", problems);
        }
        return parsed;
    }

    private static Set<String> roles(Set<String> roles) {
        Set<String> out = new HashSet<>();
        if (roles != null) {
            for (String role : roles) {
                if (role == null || !ROLE.matcher(role).matches()) {
                    throw invalid("runRoles", "role names may use letters, digits and _ . : -");
                }
                out.add(role);
            }
        }
        return out;
    }

    private static String note(String note) {
        if (note == null || note.isBlank()) {
            return null;
        }
        return note.length() > MAX_NOTE ? note.substring(0, MAX_NOTE) : note;
    }

    private static Map<String, Object> details(Report r) {
        // The definition itself can hold SQL and parameter defaults; only its identity is audited.
        return Map.of("name", r.name(), "version", r.version(), "runRoles", r.runRoles().size());
    }

    private static void requireEdit(Viewer viewer) {
        if (!viewer.can(Permission.REPORT_EDIT)) {
            throw new EngineException(ErrorCode.CURF_FORBIDDEN, "Managing reports requires the report:edit permission");
        }
    }

    private static EngineException notFound() {
        return new EngineException(ErrorCode.CURF_NOT_FOUND, "No such report");
    }

    private static EngineException invalid(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }
}
