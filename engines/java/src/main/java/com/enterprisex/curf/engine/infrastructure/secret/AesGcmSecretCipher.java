package com.enterprisex.curf.engine.infrastructure.secret;

import com.enterprisex.curf.engine.application.secret.SecretCipher;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;

/**
 * Envelope encryption: every secret gets its own random 256-bit data key (AES-GCM), and that data
 * key is wrapped by the master key (AES-GCM). Layout of the stored value, base64:
 * {@code version(1) | wrapNonce(12) | wrappedKey(48) | dataNonce(12) | ciphertext}. The master key id
 * is bound in as additional authenticated data so a secret cannot be moved under a different key id.
 */
@Component
public class AesGcmSecretCipher implements SecretCipher {

    private static final int NONCE = 12;
    private static final int TAG_BITS = 128;
    private static final int WRAPPED_KEY = 32 + 16;
    private static final byte VERSION = 1;

    private final SecureRandom random = new SecureRandom();
    private final String currentKeyId;
    private final Map<String, SecretKeySpec> keys = new HashMap<>();

    public AesGcmSecretCipher(SecretsProperties props) {
        this.currentKeyId = props.keyId();
        keys.put(props.keyId(), parse(props.masterKey(), "master key"));
        props.previousKeys().forEach((id, key) -> keys.put(id, parse(key, "previous key " + id)));
    }

    private static SecretKeySpec parse(String base64, String what) {
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(base64.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("The " + what + " is not valid base64");
        }
        if (raw.length != 32) {
            throw new IllegalStateException("The " + what + " must be exactly 32 bytes (base64 of 32 random bytes)");
        }
        return new SecretKeySpec(raw, "AES");
    }

    @Override
    public EncryptedSecret encrypt(String plaintext) {
        try {
            byte[] dataKey = new byte[32];
            random.nextBytes(dataKey);
            byte[] wrapNonce = nonce();
            byte[] dataNonce = nonce();
            byte[] aad = currentKeyId.getBytes(StandardCharsets.UTF_8);

            byte[] wrapped = gcm(Cipher.ENCRYPT_MODE, keys.get(currentKeyId), wrapNonce, aad, dataKey);
            byte[] sealed = gcm(Cipher.ENCRYPT_MODE, new SecretKeySpec(dataKey, "AES"), dataNonce, aad,
                    plaintext.getBytes(StandardCharsets.UTF_8));

            ByteBuffer out = ByteBuffer.allocate(1 + NONCE + WRAPPED_KEY + NONCE + sealed.length);
            out.put(VERSION).put(wrapNonce).put(wrapped).put(dataNonce).put(sealed);
            return new EncryptedSecret(currentKeyId, Base64.getEncoder().encodeToString(out.array()));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("Could not encrypt secret");
        }
    }

    @Override
    public String decrypt(EncryptedSecret secret) {
        SecretKeySpec master = keys.get(secret.keyId());
        if (master == null) {
            throw new IllegalStateException("No master key available for key id " + secret.keyId());
        }
        try {
            ByteBuffer in = ByteBuffer.wrap(Base64.getDecoder().decode(secret.ciphertext()));
            if (in.get() != VERSION) {
                throw new IllegalStateException("Unsupported secret format");
            }
            byte[] wrapNonce = new byte[NONCE];
            byte[] wrapped = new byte[WRAPPED_KEY];
            byte[] dataNonce = new byte[NONCE];
            in.get(wrapNonce).get(wrapped).get(dataNonce);
            byte[] sealed = new byte[in.remaining()];
            in.get(sealed);
            byte[] aad = secret.keyId().getBytes(StandardCharsets.UTF_8);

            byte[] dataKey = gcm(Cipher.DECRYPT_MODE, master, wrapNonce, aad, wrapped);
            return new String(gcm(Cipher.DECRYPT_MODE, new SecretKeySpec(dataKey, "AES"), dataNonce, aad, sealed),
                    StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | RuntimeException e) {
            throw new IllegalStateException("Could not decrypt secret");
        }
    }

    @Override
    public boolean needsRotation(EncryptedSecret secret) {
        return !currentKeyId.equals(secret.keyId());
    }

    private byte[] nonce() {
        byte[] nonce = new byte[NONCE];
        random.nextBytes(nonce);
        return nonce;
    }

    private static byte[] gcm(int mode, SecretKeySpec key, byte[] nonce, byte[] aad, byte[] input)
            throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, key, new GCMParameterSpec(TAG_BITS, nonce));
        cipher.updateAAD(aad);
        return cipher.doFinal(input);
    }
}
