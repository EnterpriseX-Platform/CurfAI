package com.enterprisex.curf.engine.application.query;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class ConcurrencyLimiterTest {

    private static ConcurrencyLimiter limiter(int perUser) {
        return new ConcurrencyLimiter(new QueryProperties(null, null, null, null, perUser, Duration.ofMillis(50), null, null));
    }

    @Test
    void refusesTheStatementOverTheLimitWithTooManyQueries() {
        var limiter = limiter(2);
        try (var a = limiter.acquire("t:u"); var b = limiter.acquire("t:u")) {
            assertThatThrownBy(() -> limiter.acquire("t:u"))
                    .isInstanceOfSatisfying(EngineException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.CURF_TOO_MANY_QUERIES));
        }
    }

    @Test
    void aReleasedPermitCanBeReused() {
        var limiter = limiter(1);
        limiter.acquire("t:u").close();
        try (var again = limiter.acquire("t:u")) {
            assertThat(again).isNotNull();
        }
    }

    @Test
    void oneViewerCannotStarveAnother() {
        var limiter = limiter(1);
        try (var a = limiter.acquire("t:alice")) {
            try (var b = limiter.acquire("t:bob")) {
                assertThat(b).isNotNull();
            }
            assertThatThrownBy(() -> limiter.acquire("t:alice")).isInstanceOf(EngineException.class);
        }
    }

    @Test
    void sameUserIdInAnotherTenantIsADifferentViewer() {
        var limiter = limiter(1);
        try (var a = limiter.acquire("t1:u"); var b = limiter.acquire("t2:u")) {
            assertThat(b).isNotNull();
        }
    }
}
