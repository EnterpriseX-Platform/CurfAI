package com.enterprisex.curf.engine.application.sharing;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Counts calls per key in one-minute windows and refuses those over the limit. In memory and per instance: it stops
 * one link from being hammered, it is not a global quota.
 */
public final class FixedWindowRateLimiter {

    private static final long WINDOW_MILLIS = 60_000;
    private static final int MAX_KEYS = 10_000;

    private record Window(long start, int count) {}

    private final Map<String, Window> windows = new ConcurrentHashMap<>();

    /** True if the call is allowed (and counted). */
    public boolean tryAcquire(String key, int limit, long nowMillis) {
        if (windows.size() > MAX_KEYS) {
            windows.entrySet().removeIf(e -> nowMillis - e.getValue().start() >= WINDOW_MILLIS);
        }
        boolean[] allowed = new boolean[1];
        windows.compute(key, (k, w) -> {
            if (w == null || nowMillis - w.start() >= WINDOW_MILLIS) {
                allowed[0] = limit > 0;
                return new Window(nowMillis, 1);
            }
            allowed[0] = w.count() < limit;
            return allowed[0] ? new Window(w.start(), w.count() + 1) : w;
        });
        return allowed[0];
    }
}
