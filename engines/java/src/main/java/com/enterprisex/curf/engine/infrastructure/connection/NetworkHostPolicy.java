package com.enterprisex.curf.engine.infrastructure.connection;

import com.enterprisex.curf.engine.application.connection.HostPolicy;
import com.enterprisex.curf.engine.domain.error.EngineException;
import com.enterprisex.curf.engine.domain.error.EngineException.FieldError;
import com.enterprisex.curf.engine.domain.error.ErrorCode;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import org.springframework.stereotype.Component;

/** Resolves the host and refuses addresses a database never legitimately lives at. */
@Component
public class NetworkHostPolicy implements HostPolicy {

    private final ConnectionPolicyProperties props;

    public NetworkHostPolicy(ConnectionPolicyProperties props) {
        this.props = props;
    }

    @Override
    public void verify(String host) {
        InetAddress[] addresses;
        try {
            addresses = InetAddress.getAllByName(host);
        } catch (UnknownHostException e) {
            throw rejected("host", "cannot be resolved");
        }
        for (InetAddress address : addresses) {
            if (address.isAnyLocalAddress() || address.isLinkLocalAddress() || address.isMulticastAddress()) {
                throw rejected("host", "points at an address the engine will not connect to");
            }
            if (address.isLoopbackAddress() && !props.allowLoopback()) {
                throw rejected("host", "points at the engine's own machine; enable curf.engine.connections.allow-loopback if that is intended");
            }
        }
    }

    private static EngineException rejected(String field, String message) {
        return new EngineException(ErrorCode.CURF_INVALID_INPUT, "Request validation failed", List.of(new FieldError(field, message)));
    }
}
