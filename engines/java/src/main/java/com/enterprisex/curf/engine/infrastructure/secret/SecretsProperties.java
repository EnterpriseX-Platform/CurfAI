package com.enterprisex.curf.engine.infrastructure.secret;

import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

/**
 * No default key: the engine will not start without one. {@code masterKey} is 32 random bytes,
 * base64. To rotate, set a new {@code keyId}/{@code masterKey} and list the old pair in
 * {@code previousKeys} (id to base64 key) until every secret has been re-encrypted.
 */
@Validated
@ConfigurationProperties(prefix = "curf.engine.secrets")
public record SecretsProperties(@NotBlank String masterKey, String keyId, Map<String, String> previousKeys) {

    public SecretsProperties {
        keyId = keyId == null || keyId.isBlank() ? "k1" : keyId;
        previousKeys = previousKeys == null ? Map.of() : Map.copyOf(previousKeys);
    }
}
