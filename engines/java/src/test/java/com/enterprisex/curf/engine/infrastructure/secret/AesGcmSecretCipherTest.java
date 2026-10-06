package com.enterprisex.curf.engine.infrastructure.secret;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.enterprisex.curf.engine.application.secret.SecretCipher.EncryptedSecret;
import java.util.Base64;
import java.util.Map;
import org.junit.jupiter.api.Test;

class AesGcmSecretCipherTest {

    private static final String KEY_A = Base64.getEncoder().encodeToString("0123456789abcdef0123456789abcdef".getBytes());
    private static final String KEY_B = Base64.getEncoder().encodeToString("fedcba9876543210fedcba9876543210".getBytes());

    private static AesGcmSecretCipher cipher(String keyId, String key, Map<String, String> previous) {
        return new AesGcmSecretCipher(new SecretsProperties(key, keyId, previous));
    }

    @Test
    void roundTripsAndNeverStoresPlaintext() {
        var cipher = cipher("k1", KEY_A, null);
        EncryptedSecret secret = cipher.encrypt("s3cret-pässword");

        assertThat(secret.ciphertext()).doesNotContain("s3cret");
        assertThat(secret.keyId()).isEqualTo("k1");
        assertThat(cipher.decrypt(secret)).isEqualTo("s3cret-pässword");
    }

    @Test
    void sameSecretEncryptsDifferentlyEachTime() {
        var cipher = cipher("k1", KEY_A, null);
        assertThat(cipher.encrypt("x").ciphertext()).isNotEqualTo(cipher.encrypt("x").ciphertext());
    }

    @Test
    void tamperingIsDetected() {
        var cipher = cipher("k1", KEY_A, null);
        EncryptedSecret secret = cipher.encrypt("x");
        byte[] raw = Base64.getDecoder().decode(secret.ciphertext());
        raw[raw.length - 1] ^= 1;
        var tampered = new EncryptedSecret("k1", Base64.getEncoder().encodeToString(raw));

        assertThatThrownBy(() -> cipher.decrypt(tampered)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void aSecretCannotBeMovedUnderAnotherKeyId() {
        var cipher = cipher("k1", KEY_A, Map.of("k0", KEY_A));
        EncryptedSecret secret = cipher.encrypt("x");

        assertThatThrownBy(() -> cipher.decrypt(new EncryptedSecret("k0", secret.ciphertext())))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void rotationKeepsOldSecretsReadableUntilReEncrypted() {
        EncryptedSecret old = cipher("k1", KEY_A, null).encrypt("db-password");

        var rotated = cipher("k2", KEY_B, Map.of("k1", KEY_A));
        assertThat(rotated.needsRotation(old)).isTrue();
        assertThat(rotated.decrypt(old)).isEqualTo("db-password");

        EncryptedSecret fresh = rotated.encrypt(rotated.decrypt(old));
        assertThat(rotated.needsRotation(fresh)).isFalse();
        assertThat(fresh.keyId()).isEqualTo("k2");
    }

    @Test
    void unknownKeyIdFailsWithoutLeakingAnything() {
        var cipher = cipher("k1", KEY_A, null);
        assertThatThrownBy(() -> cipher.decrypt(new EncryptedSecret("gone", "AAAA")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageNotContaining("AAAA");
    }

    @Test
    void refusesWeakOrMalformedMasterKeys() {
        assertThatThrownBy(() -> cipher("k1", "not base64!!", null)).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> cipher("k1", Base64.getEncoder().encodeToString(new byte[16]), null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("32 bytes");
    }
}
