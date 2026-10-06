package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.query.QueryComposer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.springframework.dao.InvalidDataAccessApiUsageException;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterUtils;
import org.springframework.jdbc.core.namedparam.ParsedSql;

/** Turns {@code :name} parameters into positional ones for JDBC. Values are only ever bound. */
public final class NamedSql {

    public record Bound(String sql, List<Object> values) {}

    private NamedSql() {}

    /** Parameters a caller supplies. Names starting with the reserved prefix belong to the engine. */
    public static void checkCallerParams(Map<String, Object> params) {
        for (Map.Entry<String, Object> p : params.entrySet()) {
            if (p.getKey().startsWith(QueryComposer.RESERVED_PARAM_PREFIX)) {
                throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                        List.of(new FieldError("params", "names starting with " + QueryComposer.RESERVED_PARAM_PREFIX + " are reserved")));
            }
            Object value = p.getValue();
            if (!(value == null || value instanceof String || value instanceof Number || value instanceof Boolean)) {
                throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Parameter values must be text, numbers or booleans");
            }
        }
    }

    public static Bound bind(String sql, Map<String, Object> params) {
        ParsedSql parsed = NamedParameterUtils.parseSqlStatement(sql);
        String positional = NamedParameterUtils.substituteNamedParameters(parsed, null);
        try {
            return new Bound(positional, new ArrayList<>(Arrays.asList(
                    NamedParameterUtils.buildValueArray(parsed, new MapSqlParameterSource(params), null))));
        } catch (InvalidDataAccessApiUsageException e) {
            throw new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed",
                    List.of(new FieldError("params", "every :name in the statement needs a value, and ? cannot be mixed in")));
        }
    }
}
