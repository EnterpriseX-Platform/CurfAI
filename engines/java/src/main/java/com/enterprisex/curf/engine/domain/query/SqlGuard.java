package com.enterprisex.curf.engine.domain.query;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import net.sf.jsqlparser.JSQLParserException;
import net.sf.jsqlparser.expression.Function;
import net.sf.jsqlparser.parser.CCJSqlParserUtil;
import net.sf.jsqlparser.schema.Table;
import net.sf.jsqlparser.statement.Statement;
import net.sf.jsqlparser.statement.Statements;
import net.sf.jsqlparser.statement.select.ParenthesedSelect;
import net.sf.jsqlparser.statement.select.PlainSelect;
import net.sf.jsqlparser.statement.select.Select;
import net.sf.jsqlparser.statement.select.SetOperationList;
import net.sf.jsqlparser.statement.select.TableFunction;
import net.sf.jsqlparser.statement.select.WithItem;
import net.sf.jsqlparser.util.TablesNamesFinder;

/**
 * Fails closed. A statement is accepted only when it parses as exactly one SELECT, contains nothing
 * that writes, reads files, runs programs or sleeps, and the engine then executes the text rendered
 * from the parsed tree (never the caller's original text), so hidden comments cannot carry anything.
 * The database account being read-only is the real control; this is the layer in front of it.
 */
public final class SqlGuard {

    /** What the guard decided: the canonical text to run, or a reason it was refused. */
    public record Verdict(String sql, String rejection) {
        public boolean accepted() {
            return rejection == null;
        }
    }

    private static final Set<String> DENIED_FUNCTIONS = Set.of(
            // PostgreSQL
            "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file", "lo_import", "lo_export",
            "lo_open", "lo_create", "lo_creat", "lo_unlink", "lo_put", "lo_from_bytea", "set_config",
            "pg_sleep", "pg_sleep_for", "pg_sleep_until", "pg_terminate_backend", "pg_cancel_backend",
            "pg_reload_conf", "pg_rotate_logfile", "pg_switch_wal", "query_to_xml", "query_to_xml_and_xmlschema",
            "query_to_xmlschema", "table_to_xml", "table_to_xml_and_xmlschema", "cursor_to_xml",
            "schema_to_xml", "database_to_xml", "xmlquery",
            // MySQL / MariaDB
            "load_file", "sleep", "benchmark", "get_lock", "release_lock", "sys_exec", "sys_eval",
            // SQL Server
            "openrowset", "openquery", "opendatasource", "openjson_file", "fn_get_audit_file", "fn_trace_gettable", "fn_dblog",
            "fn_dump_dblog", "fn_xe_file_target_read_file", "waitfor",
            // Oracle
            "sys_xmlgen", "extractvalue_file");

    private static final List<String> DENIED_FUNCTION_PREFIXES = List.of(
            "dblink", "pg_read_", "pg_ls_", "pg_advisory_", "lo_", "utl_", "dbms_", "xp_", "sp_", "fn_xe_");

    private static final Set<String> DENIED_TABLES = Set.of(
            "pg_shadow", "pg_authid", "pg_user_mappings", "pg_largeobject", "pg_largeobject_metadata",
            "pg_file_settings", "pg_hba_file_rules", "pg_ident_file_mappings",
            // Oracle: password hashes and database links. SQL Server: login hashes.
            "user$", "link$", "dba_db_links", "sql_logins", "syslogins", "sysxlogins");

    private static final Set<String> DENIED_SCHEMAS = Set.of("mysql");

    /** Safety net over the rendered text, after string literals are removed. */
    private static final Pattern DENIED_WORDS = Pattern.compile(
            "\\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink\\w*|set_config|pg_sleep\\w*|"
                    + "load_file|xp_cmdshell|openrowset|openquery|opendatasource|utl_\\w+|dbms_\\w+|"
                    + "query_to_xml\\w*|into\\s+(outfile|dumpfile))\\b",
            Pattern.CASE_INSENSITIVE);

    private static final Pattern STRING_LITERALS = Pattern.compile("'(?:[^']|'')*'");

    private SqlGuard() {}

    public static Verdict check(String sql) {
        if (sql == null || sql.isBlank()) {
            return reject("empty statement");
        }
        if (sql.contains("/*!") || sql.contains("/*+")) {
            return reject("executable or hint comments are not allowed");
        }

        Statements parsed;
        try {
            parsed = parse(sql);
        } catch (JSQLParserException | RuntimeException | StackOverflowError e) {
            return reject("statement could not be parsed as a single SELECT");
        }
        if (parsed == null || parsed.size() != 1) {
            return reject("exactly one statement is allowed");
        }

        Statement statement = parsed.get(0);
        if (!(statement instanceof Select select)) {
            return reject("only SELECT statements are allowed");
        }

        Finder finder = new Finder();
        try {
            finder.getTables((Statement) select);
            checkSelect(select, finder);
        } catch (RuntimeException | StackOverflowError e) {
            return reject("statement could not be analysed");
        }
        if (!finder.problems.isEmpty()) {
            return reject(finder.problems.get(0));
        }

        String rendered = select.toString();
        String withoutLiterals = STRING_LITERALS.matcher(rendered).replaceAll("''");
        var hit = DENIED_WORDS.matcher(withoutLiterals);
        if (hit.find()) {
            return reject("'" + hit.group().toLowerCase(Locale.ROOT) + "' is not allowed");
        }
        return new Verdict(rendered, null);
    }

    /**
     * Standard syntax first. Only a statement that does not parse that way is tried with [bracket] quoting (SQL Server): turning
     * it on for everything would read a PostgreSQL array subscript, arr[1], as a quoted name. Either way the engine runs the
     * rendered text, and a statement that means something else to the real database is simply an error there.
     */
    private static Statements parse(String sql) throws JSQLParserException {
        try {
            return CCJSqlParserUtil.parseStatements(sql);
        } catch (JSQLParserException | RuntimeException first) {
            return CCJSqlParserUtil.parseStatements(sql, parser -> parser.withSquareBracketQuotation(true));
        }
    }

    private static void checkSelect(Select select, Finder finder) {
        if (select.getWithItemsList() != null) {
            for (WithItem<?> item : select.getWithItemsList()) {
                Object body = item.getSelect();
                if (!(body instanceof Select)) {
                    finder.problems.add("data-modifying WITH items are not allowed");
                }
            }
        }
        if (select instanceof PlainSelect plain) {
            checkPlain(plain, finder);
        } else if (select instanceof SetOperationList set) {
            for (Select part : set.getSelects()) {
                checkSelect(part, finder);
            }
        } else if (select instanceof ParenthesedSelect paren) {
            checkSelect(paren.getSelect(), finder);
        }
    }

    private static void checkPlain(PlainSelect plain, Finder finder) {
        if (plain.getIntoTables() != null && !plain.getIntoTables().isEmpty()) {
            finder.problems.add("SELECT ... INTO is not allowed");
        }
        if (plain.getForMode() != null || plain.getForUpdateTable() != null) {
            finder.problems.add("locking reads are not allowed");
        }
    }

    private static Verdict reject(String reason) {
        return new Verdict(null, reason);
    }

    /** Walks every expression, sub-select, CTE and FROM item looking for denied names. */
    private static final class Finder extends TablesNamesFinder<Void> {

        final List<String> problems = new ArrayList<>();

        @Override
        public <S> Void visit(Function function, S context) {
            checkFunction(function.getName());
            return super.visit(function, context);
        }

        @Override
        public <S> Void visit(TableFunction tableFunction, S context) {
            if (tableFunction.getFunction() != null) {
                checkFunction(tableFunction.getFunction().getName());
                // Trino connectors offer table functions that send text straight to the source database (system.query);
                // a data source's own SQL would run outside this guard, so every function by that name is refused.
                String bare = normalise(tableFunction.getFunction().getName());
                if (bare.equals("query") || bare.equals("execute") || bare.equals("raw_query")) {
                    problems.add("table function '" + bare + "' is not allowed");
                }
            }
            return super.visit(tableFunction, context);
        }

        @Override
        public <S> Void visit(Table table, S context) {
            String name = normalise(table.getName());
            String schema = table.getSchemaName() == null ? "" : normalise(table.getSchemaName());
            if (DENIED_TABLES.contains(name) || DENIED_SCHEMAS.contains(schema)) {
                problems.add("table '" + name + "' is not allowed");
            }
            return super.visit(table, context);
        }

        @Override
        public <S> Void visit(PlainSelect plainSelect, S context) {
            checkPlain(plainSelect, this);
            return super.visit(plainSelect, context);
        }

        private void checkFunction(String qualifiedName) {
            if (qualifiedName == null) {
                return;
            }
            String name = normalise(qualifiedName);
            if (DENIED_FUNCTIONS.contains(name) || DENIED_FUNCTION_PREFIXES.stream().anyMatch(name::startsWith)) {
                problems.add("function '" + name + "' is not allowed");
            }
        }

        private static String normalise(String identifier) {
            String last = identifier.substring(identifier.lastIndexOf('.') + 1);
            return last.replace("\"", "").replace("`", "").replace("[", "").replace("]", "").toLowerCase(Locale.ROOT);
        }
    }
}
