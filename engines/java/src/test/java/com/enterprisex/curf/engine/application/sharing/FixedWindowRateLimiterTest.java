package com.enterprisex.curf.engine.application.sharing;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class FixedWindowRateLimiterTest {

    @Test
    void allowsUpToTheLimitThenRefusesUntilTheWindowPasses() {
        FixedWindowRateLimiter limiter = new FixedWindowRateLimiter();

        assertThat(limiter.tryAcquire("a", 3, 0)).isTrue();
        assertThat(limiter.tryAcquire("a", 3, 1_000)).isTrue();
        assertThat(limiter.tryAcquire("a", 3, 2_000)).isTrue();
        assertThat(limiter.tryAcquire("a", 3, 3_000)).isFalse();
        assertThat(limiter.tryAcquire("a", 3, 59_999)).isFalse();
        assertThat(limiter.tryAcquire("a", 3, 60_000)).isTrue();
    }

    @Test
    void keysAreCountedSeparately() {
        FixedWindowRateLimiter limiter = new FixedWindowRateLimiter();

        assertThat(limiter.tryAcquire("a", 1, 0)).isTrue();
        assertThat(limiter.tryAcquire("a", 1, 1)).isFalse();
        assertThat(limiter.tryAcquire("b", 1, 1)).isTrue();
    }

    @Test
    void aLimitOfZeroRefusesEverything() {
        assertThat(new FixedWindowRateLimiter().tryAcquire("a", 0, 0)).isFalse();
    }
}
