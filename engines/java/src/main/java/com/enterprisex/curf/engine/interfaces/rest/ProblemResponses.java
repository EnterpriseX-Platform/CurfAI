package com.enterprisex.curf.engine.interfaces.rest;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** RFC 9457 bodies with a stable {@code code}, for the advice and for the security filter chain. */
@Component
public class ProblemResponses implements AuthenticationEntryPoint, AccessDeniedHandler {

    private final JsonMapper json;

    public ProblemResponses(JsonMapper json) {
        this.json = json;
    }

    public static ProblemDetail problem(ErrorCode code, String detail, List<EngineException.FieldError> errors) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.valueOf(code.httpStatus()), detail);
        problem.setType(URI.create("urn:curf:error:" + code.name().substring("CURF_".length()).toLowerCase()));
        problem.setTitle(HttpStatus.valueOf(code.httpStatus()).getReasonPhrase());
        problem.setProperty("code", code.name());
        if (!errors.isEmpty()) {
            problem.setProperty("errors", errors);
        }
        return problem;
    }

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response, AuthenticationException ex)
            throws IOException {
        write(response, problem(ErrorCode.CURF_UNAUTHENTICATED, "Authentication is required", List.of()));
    }

    @Override
    public void handle(HttpServletRequest request, HttpServletResponse response, AccessDeniedException ex)
            throws IOException {
        write(response, problem(ErrorCode.CURF_FORBIDDEN, "You are not allowed to do this", List.of()));
    }

    private void write(HttpServletResponse response, ProblemDetail problem) throws IOException {
        response.setStatus(problem.getStatus());
        response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        response.setCharacterEncoding("UTF-8");
        if (problem.getStatus() == HttpStatus.UNAUTHORIZED.value()) {
            response.setHeader("WWW-Authenticate", "Bearer");
        }
        json.writeValue(response.getOutputStream(), problem);
    }
}
