package com.enterprisex.curf.engine.config;

import com.enterprisex.curf.engine.application.sharing.PublicProperties;
import com.enterprisex.curf.engine.infrastructure.security.EngineSecurityProperties;
import com.enterprisex.curf.engine.infrastructure.security.IssuerAuthenticationManagerResolver;
import com.enterprisex.curf.engine.infrastructure.security.JwtDecoderFactory;
import com.enterprisex.curf.engine.infrastructure.security.JwtViewerMapper;
import com.enterprisex.curf.engine.interfaces.rest.ProblemResponses;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

@Configuration
public class SecurityConfig {

    @Bean
    @ConditionalOnMissingBean
    JwtDecoderFactory jwtDecoderFactory(EngineSecurityProperties props) {
        return IssuerAuthenticationManagerResolver.jwksFactory(props);
    }

    @Bean
    SecurityFilterChain engineSecurity(
            HttpSecurity http,
            EngineSecurityProperties props,
            JwtDecoderFactory decoders,
            JwtViewerMapper mapper,
            ProblemResponses problems,
            PublicProperties publicProps)
            throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
                .cors(cors -> cors.configurationSource(publicCors(publicProps)))
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers("/engine/v1/actuator/health/**", "/engine/v1/actuator/prometheus")
                        .permitAll()
                        // The secret in the path is the credential; PublicLinkService checks it.
                        .requestMatchers("/engine/v1/public/**")
                        .permitAll()
                        .anyRequest()
                        .authenticated())
                .oauth2ResourceServer(rs -> rs
                        .authenticationManagerResolver(
                                IssuerAuthenticationManagerResolver.create(props, decoders, mapper))
                        .authenticationEntryPoint(problems)
                        .accessDeniedHandler(problems))
                .exceptionHandling(e -> e.authenticationEntryPoint(problems).accessDeniedHandler(problems))
                .headers(Customizer.withDefaults());
        return http.build();
    }

    /** Browsers may call the public endpoints only from the listed sites; every other path gets no CORS headers at all. */
    private static CorsConfigurationSource publicCors(PublicProperties props) {
        CorsConfiguration cors = new CorsConfiguration();
        cors.setAllowedOrigins(props.allowedOrigins());
        cors.setAllowedMethods(List.of("GET", "POST", "OPTIONS"));
        cors.setAllowedHeaders(List.of("Content-Type"));
        cors.setAllowCredentials(false);
        cors.setMaxAge(600L);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/engine/v1/public/**", cors);
        return source;
    }
}
