package com.enterprisex.curf.engine.config;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import com.enterprisex.curf.engine.domain.viewer.Viewer;
import com.enterprisex.curf.engine.infrastructure.security.ViewerAuthenticationToken;
import org.springframework.core.MethodParameter;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

/** Lets controllers declare a {@link Viewer} parameter instead of reading the security context. */
public class ViewerArgumentResolver implements HandlerMethodArgumentResolver {

    @Override
    public boolean supportsParameter(MethodParameter parameter) {
        return Viewer.class.equals(parameter.getParameterType());
    }

    @Override
    public Object resolveArgument(
            MethodParameter parameter, ModelAndViewContainer mav, NativeWebRequest request, WebDataBinderFactory binder) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication instanceof ViewerAuthenticationToken token) {
            return token.viewer();
        }
        throw new EngineException(ErrorCode.CURF_UNAUTHENTICATED, "Authentication is required");
    }
}
