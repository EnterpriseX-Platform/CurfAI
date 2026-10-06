package com.enterprisex.curf.engine.domain.query;

import com.enterprisex.curf.engine.domain.connection.ConnectionKind;
import com.enterprisex.curf.engine.domain.view.ViewColumn;
import java.util.Locale;

/** The few places where the databases differ: identifier quoting, row limits, aliases, casts and the mask expression. */
public final class Dialects {

    static final String TEXT_MASK = "'***'";

    private Dialects() {}

    /** Identifiers are checked against a strict pattern before they get here; quoting is the second line. */
    static String quote(ConnectionKind kind, String identifier) {
        return switch (kind) {
            case POSTGRESQL, ORACLE, TRINO -> "\"" + identifier.replace("\"", "\"\"") + "\"";
            case MYSQL, MARIADB -> "`" + identifier.replace("`", "``") + "`";
            case SQLSERVER -> "[" + identifier.replace("]", "]]") + "]";
        };
    }

    /** A table alias. Oracle does not accept AS before one; everyone else does. */
    public static String tableAlias(ConnectionKind kind, String alias) {
        return kind == ConnectionKind.ORACLE ? " " + alias : " AS " + alias;
    }

    /** What follows SELECT to cap the rows, for databases that cap them there (SQL Server's TOP). */
    static String limitPrefix(ConnectionKind kind, int limit) {
        return kind == ConnectionKind.SQLSERVER ? "TOP " + limit + " " : "";
    }

    /** What ends the statement to cap the rows, for databases that cap them there. */
    static String limitSuffix(ConnectionKind kind, int limit) {
        return switch (kind) {
            case POSTGRESQL, MYSQL, MARIADB, TRINO -> " LIMIT " + limit;
            case ORACLE -> " FETCH FIRST " + limit + " ROWS ONLY";
            case SQLSERVER -> "";
        };
    }

    /** Text becomes a constant (no length or shape leaks); everything else becomes a typed NULL. */
    static String mask(ConnectionKind kind, ViewColumn column) {
        TypeCategory category = TypeCategory.of(column.type());
        if (category == TypeCategory.TEXT) {
            return TEXT_MASK;
        }
        return "CAST(NULL AS " + castTarget(kind, category, column.type()) + ")";
    }

    /** A bound text date or timestamp turned into the database's own value; other values bind as they are. */
    static String bindDate(ConnectionKind kind, TypeCategory category, String declaredType, String name) {
        if (kind == ConnectionKind.ORACLE) {
            // Oracle reads a text date by the session's NLS settings; naming the format keeps it the same everywhere.
            return category == TypeCategory.DATE ? "TO_DATE(:" + name + ", 'YYYY-MM-DD')"
                    : "TO_TIMESTAMP(:" + name + ", 'YYYY-MM-DD HH24:MI:SS')";
        }
        return "CAST(:" + name + " AS " + castTarget(kind, category, declaredType) + ")";
    }

    /** Target of a cast that turns a bound text value into the column's kind of value. */
    static String castTarget(ConnectionKind kind, TypeCategory category, String declaredType) {
        if (kind == ConnectionKind.POSTGRESQL) {
            String safe = TypeCategory.safeTypeName(declaredType);
            return switch (category) {
                case DATE -> "date";
                case TIMESTAMP -> "timestamp";
                case NUMBER -> safe != null ? safe : "numeric";
                case BOOLEAN -> "boolean";
                default -> safe != null ? safe : "text";
            };
        }
        if (kind == ConnectionKind.TRINO) {
            return switch (category) {
                case DATE -> "DATE";
                case TIMESTAMP -> "TIMESTAMP";
                case NUMBER -> "DECIMAL(38,10)";
                case BOOLEAN -> "BOOLEAN";
                default -> "VARCHAR";
            };
        }
        if (kind == ConnectionKind.ORACLE) {
            return switch (category) {
                case DATE -> "DATE";
                case TIMESTAMP -> "TIMESTAMP";
                case NUMBER -> "NUMBER";
                case BOOLEAN -> "NUMBER(1)";
                default -> "VARCHAR2(4000)";
            };
        }
        if (kind == ConnectionKind.SQLSERVER) {
            return switch (category) {
                case DATE -> "DATE";
                case TIMESTAMP -> "DATETIME2";
                case NUMBER -> "DECIMAL(38,10)";
                case BOOLEAN -> "BIT";
                default -> "NVARCHAR(4000)";
            };
        }
        String lower = declaredType == null ? "" : declaredType.toLowerCase(Locale.ROOT);
        return switch (category) {
            case DATE -> "DATE";
            case TIMESTAMP -> "DATETIME";
            case NUMBER -> lower.contains("unsigned") ? "UNSIGNED" : lower.matches(".*(decimal|numeric|dec|fixed|float|double|real).*") ? "DECIMAL(38,10)" : "SIGNED";
            case BOOLEAN -> "SIGNED";
            default -> "CHAR";
        };
    }
}
