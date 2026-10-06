package com.enterprisex.curf.engine.application.query;

import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

/** At most N statements per viewer at once; others wait briefly, then are refused with 429. */
@Component
public class ConcurrencyLimiter {

    public interface Permit extends AutoCloseable {
        @Override
        void close();
    }

    private final ConcurrentHashMap<String, Semaphore> perViewer = new ConcurrentHashMap<>();
    private final QueryProperties props;

    public ConcurrencyLimiter(QueryProperties props) {
        this.props = props;
    }

    public Permit acquire(String viewerKey) {
        Semaphore semaphore = perViewer.computeIfAbsent(viewerKey, k -> new Semaphore(props.perUserConcurrency()));
        try {
            if (!semaphore.tryAcquire(props.queueWait().toMillis(), TimeUnit.MILLISECONDS)) {
                throw new EngineException(ErrorCode.CURF_TOO_MANY_QUERIES,
                        "Too many queries are already running for you; try again shortly");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new EngineException(ErrorCode.CURF_TOO_MANY_QUERIES, "The request was interrupted");
        }
        return semaphore::release;
    }
}
