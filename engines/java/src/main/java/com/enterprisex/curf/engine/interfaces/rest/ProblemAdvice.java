package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

@RestControllerAdvice
public class ProblemAdvice {

    private static final Logger LOG = LoggerFactory.getLogger(ProblemAdvice.class);

    @ExceptionHandler(EngineException.class)
    ResponseEntity<ProblemDetail> engine(EngineException ex) {
        return respond(ProblemResponses.problem(ex.code(), ex.getMessage(), ex.errors()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ProblemDetail> validation(MethodArgumentNotValidException ex) {
        List<EngineException.FieldError> errors = ex.getBindingResult().getFieldErrors().stream()
                .map(e -> new EngineException.FieldError(e.getField(), String.valueOf(e.getDefaultMessage())))
                .toList();
        return respond(ProblemResponses.problem(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", errors));
    }

    @ExceptionHandler({
        HttpMessageNotReadableException.class,
        MissingServletRequestParameterException.class,
        MethodArgumentTypeMismatchException.class
    })
    ResponseEntity<ProblemDetail> badInput(Exception ex) {
        return respond(ProblemResponses.problem(ErrorCode.CURF_INVALID_INPUT, "The request is malformed", List.of()));
    }

    @ExceptionHandler(AccessDeniedException.class)
    ResponseEntity<ProblemDetail> denied(AccessDeniedException ex) {
        return respond(ProblemResponses.problem(ErrorCode.CURF_FORBIDDEN, "You are not allowed to do this", List.of()));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<ProblemDetail> notFound(NoResourceFoundException ex) {
        return respond(ProblemResponses.problem(ErrorCode.CURF_NOT_FOUND, "No such resource", List.of()));
    }

    /** Never leaks internals: the cause goes to the log, the caller gets a generic problem. */
    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> unexpected(Exception ex) {
        LOG.error("Unhandled error", ex);
        return respond(ProblemResponses.problem(ErrorCode.CURF_INTERNAL, "Unexpected error", List.of()));
    }

    private static ResponseEntity<ProblemDetail> respond(ProblemDetail problem) {
        ResponseEntity.BodyBuilder response = ResponseEntity.status(HttpStatus.valueOf(problem.getStatus()))
                .header(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        if (problem.getStatus() == HttpStatus.TOO_MANY_REQUESTS.value()) {
            response.header(HttpHeaders.RETRY_AFTER, "2");
        }
        return response.body(problem);
    }
}
