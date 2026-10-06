package com.enterprisex.curf.engine.application.query;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;

/** Small in-memory LRU. Keys include the viewer scope, so results are never shared across policies. */
@Component
public class QueryCache {

    public record Entry(QueryResult result, Instant storedAt) {}

    private final Map<String, Entry> entries;
    private final Clock clock;

    public QueryCache(QueryProperties props, Clock clock) {
        int capacity = props.cacheMaxEntries();
        this.clock = clock;
        this.entries = new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Entry> eldest) {
                return size() > capacity;
            }
        };
    }

    public synchronized Optional<QueryResult> get(String key, Duration maxAge) {
        Entry entry = entries.get(key);
        if (entry == null || entry.storedAt().plus(maxAge).isBefore(clock.instant())) {
            return Optional.empty();
        }
        return Optional.of(entry.result());
    }

    public synchronized void put(String key, QueryResult result) {
        entries.put(key, new Entry(result, clock.instant()));
    }

    public synchronized void evictAll() {
        entries.clear();
    }
}
