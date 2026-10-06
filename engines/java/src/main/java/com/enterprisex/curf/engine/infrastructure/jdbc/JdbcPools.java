package com.enterprisex.curf.engine.infrastructure.jdbc;

import com.enterprisex.curf.engine.application.connection.ConnectionLifecycle;
import com.enterprisex.curf.engine.domain.connection.Connection;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PreDestroy;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import javax.sql.DataSource;
import org.springframework.stereotype.Component;

/**
 * One small pool per connection and version. Changing a connection bumps its version, so the old
 * pool (with the old credentials) is closed and never reused.
 */
@Component
public class JdbcPools implements ConnectionLifecycle {

    private record Key(UUID id, int version) {}

    private final Map<Key, HikariDataSource> pools = new ConcurrentHashMap<>();

    public DataSource pool(Connection c, String password) {
        return pools.computeIfAbsent(new Key(c.id(), c.version()), key -> {
            HikariConfig cfg = new HikariConfig();
            cfg.setJdbcUrl(JdbcUrls.of(c));
            cfg.setUsername(c.username());
            if (JdbcUrls.sendsPassword(c) && password != null && !password.isEmpty()) {
                cfg.setPassword(password);
            }
            JdbcUrls.properties(c).forEach((k, v) -> cfg.addDataSourceProperty(String.valueOf(k), v));
            cfg.setPoolName("curf-" + c.id());
            cfg.setMaximumPoolSize(4);
            cfg.setMinimumIdle(0);
            cfg.setIdleTimeout(60_000);
            cfg.setMaxLifetime(600_000);
            cfg.setConnectionTimeout(10_000);
            cfg.setAutoCommit(false);
            cfg.setReadOnly(true);
            cfg.setInitializationFailTimeout(-1);
            return new HikariDataSource(cfg);
        });
    }

    @Override
    public void evict(UUID connectionId) {
        for (Iterator<Map.Entry<Key, HikariDataSource>> it = pools.entrySet().iterator(); it.hasNext(); ) {
            var entry = it.next();
            if (entry.getKey().id().equals(connectionId)) {
                entry.getValue().close();
                it.remove();
            }
        }
    }

    @PreDestroy
    void closeAll() {
        pools.values().forEach(HikariDataSource::close);
        pools.clear();
    }
}
