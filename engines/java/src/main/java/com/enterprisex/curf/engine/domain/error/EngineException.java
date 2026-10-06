package com.enterprisex.curf.engine.domain.error;

import java.util.List;

public class EngineException extends RuntimeException {

    public record FieldError(String field, String message) {}

    private final ErrorCode code;
    private final List<FieldError> errors;

    public EngineException(ErrorCode code, String message) {
        this(code, message, List.of());
    }

    public EngineException(ErrorCode code, String message, List<FieldError> errors) {
        super(message);
        this.code = code;
        this.errors = List.copyOf(errors);
    }

    public ErrorCode code() {
        return code;
    }

    public List<FieldError> errors() {
        return errors;
    }
}
